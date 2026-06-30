/// Local HTTP print server for SoftShape Print Agent.
///
/// Runs inside the Tauri process on 0.0.0.0:3100, accepting print jobs
/// from the Cashier desktop app and Captain tablets on the same LAN.
///
/// Endpoints:
///   POST /print   { type, printerName, escposData, eventId, data }
///   GET  /health
///
/// The /print handler parses escposData (an array of { type, format, data }
/// objects — same shape as buildFoodKOT/buildLiquorKOT output), joins the
/// data fields, and sends the raw bytes to the printer via the same
/// windows_printing::raw_print() or TCP print_network path used by the
/// socket-based handlePrintJob in agentSocket.js.

use std::collections::HashSet;
use std::io::Write;
use std::net::TcpStream;
use std::sync::Mutex;
use std::time::Duration;

use tiny_http::{Header, Method, Response, Server};

const SEEN_EVENT_IDS_MAX: usize = 500;

static SEEN_EVENT_IDS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn mark_event_id_seen(id: &str) {
    let mut guard = SEEN_EVENT_IDS.lock().unwrap();
    let set = guard.get_or_insert_with(|| HashSet::with_capacity(SEEN_EVENT_IDS_MAX));
    if set.len() >= SEEN_EVENT_IDS_MAX {
        // Evict oldest entry (arbitrary — HashSet has no order, but this is
        // a best-effort bounded cache for dedup, not a FIFO queue)
        if let Some(first) = set.iter().next().cloned() {
            set.remove(&first);
        }
    }
    set.insert(id.to_string());
}

fn is_event_id_seen(id: &str) -> bool {
    let guard = SEEN_EVENT_IDS.lock().unwrap();
    guard.as_ref().map_or(false, |set| set.contains(id))
}

/// Extract raw ESC/POS bytes from the escposData field.
///
/// The frontend sends escposData as an array of objects:
///   [{ "type": "raw", "format": "plain", "data": "\x1B\x40..." }]
///
/// This mirrors what agentSocket.js does at lines 483-489:
///   const rawString = Array.isArray(escposData)
///     ? escposData.map((d) => d.data || "").join("")
///     : String(escposData);
///   const bytes = encoder.encode(rawString);
fn extract_escpos_bytes(escpos_data: &serde_json::Value) -> Option<Vec<u8>> {
    match escpos_data {
        serde_json::Value::Array(arr) => {
            let mut raw_string = String::new();
            for item in arr {
                if let Some(data) = item.get("data").and_then(|d| d.as_str()) {
                    raw_string.push_str(data);
                }
            }
            if raw_string.is_empty() {
                return None;
            }
            Some(raw_string.into_bytes())
        }
        serde_json::Value::String(s) => {
            if s.is_empty() {
                None
            } else {
                Some(s.clone().into_bytes())
            }
        }
        _ => None,
    }
}

/// Send raw bytes to a network printer via TCP (IP:port).
/// Same logic as the print_network Tauri command in main.rs.
fn print_network(ip: &str, port: u16, bytes: &[u8]) -> Result<(), String> {
    let addr = format!("{}:{}", ip, port);
    let mut stream = TcpStream::connect_timeout(
        &addr.parse().map_err(|e| format!("Invalid address: {}", e))?,
        Duration::from_secs(5),
    )
    .map_err(|e| format!("Cannot connect to {}: {}", addr, e))?;

    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| format!("Failed to set write timeout: {}", e))?;

    stream
        .write_all(bytes)
        .map_err(|e| format!("Write failed: {}", e))?;

    Ok(())
}

/// Detect if printerName is an IP:port format (e.g. "192.168.1.100:9100")
/// and route to network printing instead of local raw print.
fn route_print(printer_name: &str, bytes: &[u8]) -> Result<(), String> {
    // Check for IP:port pattern
    let parts: Vec<&str> = printer_name.splitn(2, ':').collect();
    if parts.len() == 2 {
        if let (Ok(_), Ok(port)) = (
            parts[0].parse::<std::net::Ipv4Addr>(),
            parts[1].parse::<u16>(),
        ) {
            return print_network(parts[0], port, bytes);
        }
    }

    // Local USB printer via Win32 raw print
    #[cfg(windows)]
    {
        super::windows_printing::raw_print(printer_name, bytes)
    }
    #[cfg(not(windows))]
    {
        let _ = printer_name;
        Err("Print agent is currently only supported on Windows.".to_string())
    }
}

fn handle_print_request(body: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let payload: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => {
            let resp = serde_json::json!({
                "status": "failed",
                "error": format!("Invalid JSON: {}", e)
            });
            return Response::from_string(resp.to_string())
                .with_status_code(400)
                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
        }
    };

    let event_id = payload.get("eventId").and_then(|v| v.as_str()).unwrap_or("");
    let printer_name = payload.get("printerName").and_then(|v| v.as_str()).unwrap_or("");
    let job_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let escpos_data = payload.get("escposData").unwrap_or(&serde_json::Value::Null);

    // Dedup check
    if !event_id.is_empty() && is_event_id_seen(event_id) {
        let resp = serde_json::json!({
            "status": "success",
            "deduped": true
        });
        return Response::from_string(resp.to_string())
            .with_status_code(200)
            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
    }

    if !event_id.is_empty() {
        mark_event_id_seen(event_id);
    }

    // Validate required fields
    if printer_name.is_empty() {
        let resp = serde_json::json!({
            "status": "failed",
            "error": "Missing printerName"
        });
        return Response::from_string(resp.to_string())
            .with_status_code(400)
            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
    }

    // Extract ESC/POS bytes
    let bytes = match extract_escpos_bytes(escpos_data) {
        Some(b) => b,
        None => {
            let resp = serde_json::json!({
                "status": "failed",
                "error": "No ESC/POS data in job"
            });
            return Response::from_string(resp.to_string())
                .with_status_code(400)
                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
        }
    };

    // Route to printer
    match route_print(printer_name, &bytes) {
        Ok(()) => {
            let resp = serde_json::json!({
                "status": "success",
                "type": job_type,
                "printer": printer_name,
                "bytes": bytes.len()
            });
            Response::from_string(resp.to_string())
                .with_status_code(200)
                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
        }
        Err(e) => {
            let resp = serde_json::json!({
                "status": "failed",
                "error": e
            });
            Response::from_string(resp.to_string())
                .with_status_code(500)
                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
        }
    }
}

fn json_response(status: u16, body: serde_json::Value) -> Response<std::io::Cursor<Vec<u8>>> {
    let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    Response::from_string(body.to_string())
        .with_status_code(status)
        .with_header(header)
}

pub fn start(addr: &str) {
    let server = Server::http(addr).unwrap_or_else(|e| {
        eprintln!("[PrintAgent:HTTP] Failed to bind to {}: {}", addr, e);
        std::process::exit(1);
    });

    println!("[PrintAgent:HTTP] Listening on http://{}", addr);

    for mut request in server.incoming_requests() {
        let url = request.url().to_string();
        let method = request.method().clone();

        // CORS headers
        let cors_headers: Vec<Header> = vec![
            Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap(),
            Header::from_bytes(&b"Access-Control-Allow-Methods"[..], &b"GET, POST, OPTIONS"[..]).unwrap(),
            Header::from_bytes(&b"Access-Control-Allow-Headers"[..], &b"Content-Type"[..]).unwrap(),
        ];

        // Handle OPTIONS preflight
        if method == Method::Options {
            let mut response = Response::empty(204);
            for h in cors_headers {
                response = response.with_header(h);
            }
            let _ = request.respond(response);
            continue;
        }

        // Health check
        if url == "/health" && method == Method::Get {
            let resp = serde_json::json!({
                "status": "ok",
                "service": "softshape-print-agent"
            });
            let mut response = json_response(200, resp);
            for h in cors_headers {
                response = response.with_header(h);
            }
            let _ = request.respond(response);
            continue;
        }

        // Print endpoint
        if url == "/print" && method == Method::Post {
            let mut body = String::new();
            let reader = request.as_reader();
            if let Err(e) = reader.read_to_string(&mut body) {
                let resp = serde_json::json!({
                    "status": "failed",
                    "error": format!("Failed to read body: {}", e)
                });
                let _ = request.respond(json_response(400, resp));
                continue;
            }

            let mut response = handle_print_request(&body);
            for h in cors_headers {
                response = response.with_header(h);
            }
            let _ = request.respond(response);
            continue;
        }

        // 404
        let resp = serde_json::json!({
            "status": "failed",
            "error": "Not found"
        });
        let _ = request.respond(json_response(404, resp));
    }
}
