// ─────────────────────────────────────────────────────────────────────────────
// print-service/src/main.rs — SoftShape Print Service (headless, isolated)
// ─────────────────────────────────────────────────────────────────────────────
// A tiny headless HTTP server on :3103 that accepts print jobs from the
// Runtime and sends them directly to Win32 printers. Process isolation means
// a printer driver crash cannot take down the Runtime.
//
// Endpoints:
//   GET  /health    → { "status": "ok" }
//   GET  /printers  → [ { "name": "...", "isDefault": true/false }, ... ]
//   POST /print     → { "printerName": "...", "bytes": [...] }
//                     → { "ok": true } or { "ok": false, "error": "..." }
//
// The Runtime supervises this process via supervisor.ts (spawn, watchdog,
// health probe, crash-loop guard). If this process dies, the Runtime respawns
// it and re-queues any in-flight print jobs from the SQLite print_job table.
// ─────────────────────────────────────────────────────────────────────────────

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod printing;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

const DEFAULT_PORT: u16 = 3103;

// ── Per-printer serialization ──────────────────────────────────────────────
// Each printer name gets its own Mutex. This prevents concurrent print jobs
// to the same printer from interleaving ESC/POS bytes (which would garble
// the output), while allowing different printers to print in parallel.
// The outer RwLock protects the HashMap itself; the inner Mutex serializes
// access to a single printer.
static PRINTER_LOCKS: std::sync::LazyLock<RwLock<HashMap<String, Arc<Mutex<()>>>>> = std::sync::LazyLock::new(|| RwLock::new(HashMap::new()));

fn with_printer_lock<T, F: FnOnce() -> T>(printer_name: &str, f: F) -> T {
    // Fast path: read lock to check if a mutex already exists for this printer
    let mutex = {
        let locks = PRINTER_LOCKS.read().unwrap();
        locks.get(printer_name).cloned()
    };
    let mutex = match mutex {
        Some(m) => m,
        None => {
            // Slow path: write lock to insert a new mutex for this printer
            let mut locks = PRINTER_LOCKS.write().unwrap();
            locks
                .entry(printer_name.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        }
    };
    let _guard = mutex.lock().unwrap();
    f()
}

#[derive(Debug, Deserialize)]
struct PrintRequest {
    #[serde(rename = "printerName")]
    printer_name: String,
    bytes: Vec<u8>,
}

#[derive(Debug, Serialize)]
struct PrintResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn json_response(status: &str, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        body.len(),
        body,
    )
    .into_bytes()
}

fn handle_connection(mut stream: std::net::TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
    let mut request = Vec::with_capacity(8192);
    let mut buffer = [0u8; 8192];
    let header_end;
    let content_length;

    loop {
        let bytes_read = match stream.read(&mut buffer) {
            Ok(0) => return,
            Ok(n) => n,
            Err(_) => return,
        };
        request.extend_from_slice(&buffer[..bytes_read]);
        if request.len() > 10 * 1024 * 1024 {
            let resp = json_response("413 Payload Too Large", r#"{"ok":false,"error":"Print payload too large"}"#);
            let _ = stream.write_all(&resp);
            return;
        }
        if let Some(position) = request.windows(4).position(|w| w == b"\r\n\r\n") {
            header_end = position + 4;
            let headers = String::from_utf8_lossy(&request[..position]);
            content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    if name.eq_ignore_ascii_case("Content-Length") {
                        value.trim().parse::<usize>().ok()
                    } else {
                        None
                    }
                })
                .unwrap_or(0);
            break;
        }
    }

    while request.len() < header_end + content_length {
        let bytes_read = match stream.read(&mut buffer) {
            Ok(0) => return,
            Ok(n) => n,
            Err(_) => return,
        };
        request.extend_from_slice(&buffer[..bytes_read]);
    }

    let headers = String::from_utf8_lossy(&request[..header_end]);
    let request_line = headers.lines().next().unwrap_or_default();

    // ── Route ────────────────────────────────────────────────────────────────
    if request_line.starts_with("GET /health ") {
        let resp = json_response("200 OK", r#"{"status":"ok"}"#);
        let _ = stream.write_all(&resp);
        return;
    }

    if request_line.starts_with("GET /printers ") {
        match printing::enumerate_printers() {
            Ok(printers) => {
                let body = serde_json::to_string(&printers).unwrap_or_else(|_| "[]".to_string());
                let resp = json_response("200 OK", &body);
                let _ = stream.write_all(&resp);
            }
            Err(e) => {
                let body = format!(r#"{{"ok":false,"error":"{}"}}"#, e.replace('"', "\\\""));
                let resp = json_response("500 Internal Server Error", &body);
                let _ = stream.write_all(&resp);
            }
        }
        return;
    }

    if request_line.starts_with("POST /print ") {
        let body = &request[header_end..header_end + content_length];
        let print_req: PrintRequest = match serde_json::from_slice(body) {
            Ok(req) => req,
            Err(_) => {
                let resp = json_response("400 Bad Request", r#"{"ok":false,"error":"Invalid print request"}"#);
                let _ = stream.write_all(&resp);
                return;
            }
        };

        let byte_count = print_req.bytes.len();
        let printer_name = &print_req.printer_name;

        // Acquire per-printer lock to prevent concurrent jobs to the same
        // printer from interleaving ESC/POS bytes. Different printers are
        // not blocked by each other — each has its own Mutex.
        let result = with_printer_lock(printer_name, || {
            if let Some((ip, port)) = printing::parse_network_printer(printer_name) {
                printing::print_network(&ip, port, &print_req.bytes)
            } else {
                printing::raw_print(printer_name, &print_req.bytes)
            }
        });

        let resp = match result {
            Ok(()) => {
                eprintln!("[PrintService] ✓ printed {} bytes to {}", byte_count, printer_name);
                let body = r#"{"ok":true}"#;
                json_response("200 OK", body)
            }
            Err(error) => {
                eprintln!("[PrintService] ✗ failed: {}", error);
                let body = format!(
                    r#"{{"ok":false,"error":"{}"}}"#,
                    error.replace('\\', "\\\\").replace('"', "\\\"")
                );
                json_response("500 Internal Server Error", &body)
            }
        };
        let _ = stream.write_all(&resp);
        return;
    }

    // ── 404 ──────────────────────────────────────────────────────────────────
    let resp = json_response("404 Not Found", r#"{"ok":false,"error":"Not found"}"#);
    let _ = stream.write_all(&resp);
}

fn main() {
    let port: u16 = std::env::var("PRINT_SERVICE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[PrintService] Failed to bind port {}: {}", port, e);
            std::process::exit(1);
        }
    };

    eprintln!("[PrintService] Listening on 127.0.0.1:{}", port);

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                std::thread::spawn(|| handle_connection(stream));
            }
            Err(e) => {
                eprintln!("[PrintService] Accept error: {}", e);
            }
        }
    }
}
