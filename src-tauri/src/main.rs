#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

#[cfg(windows)]
mod windows_printing;
mod http_server;

// Shared printer mapping: role -> printer name. Updated by the frontend UI
// and read by the local HTTP server to resolve empty printerName requests.
static PRINTER_MAPPING: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

pub fn get_printer_mapping() -> Option<HashMap<String, String>> {
    PRINTER_MAPPING.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn resolve_printer_by_type(mapping: &HashMap<String, String>, job_type: &str) -> Option<String> {
    match job_type {
        "KOT" | "CANCEL_KOT" | "CANCEL_ORDER" | "TABLE_SWAP" => mapping.get("kitchen").cloned(),
        "BAR_KOT" => mapping.get("bar").cloned(),
        "FINAL_BILL" | "BILL" | "VOUCHER" | "EXPENDITURE" => mapping.get("bill").cloned(),
        _ => None,
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct PrinterInfo {
    name: String,
    #[serde(rename = "isDefault")]
    is_default: bool,
}

/// List all installed Windows printers.
#[tauri::command]
fn list_printers() -> Vec<PrinterInfo> {
    #[cfg(windows)]
    {
        windows_printing::enumerate_printers().unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        vec![]
    }
}

/// Send raw bytes directly to a named printer (silent, no dialog).
#[tauri::command]
fn print_raw(printer_name: String, bytes: Vec<u8>) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows_printing::raw_print(&printer_name, &bytes)
            .map_err(|e| format!("Print failed: {}", e))
    }
    #[cfg(not(windows))]
    {
        let _ = (printer_name, bytes);
        Err("Print agent is currently only supported on Windows. Network printing (print_network) is available on all platforms.".to_string())
    }
}

/// Send raw bytes to a network printer via TCP (IP:port).
#[tauri::command]
fn print_network(ip: String, port: u16, bytes: Vec<u8>) -> Result<(), String> {
    use std::io::Write;
    use std::net::TcpStream;
    use std::time::Duration;

    let addr = format!("{}:{}", ip, port);
    let mut stream = TcpStream::connect_timeout(
        &addr.parse().map_err(|e| format!("Invalid address: {}", e))?,
        Duration::from_secs(5),
    )
    .map_err(|e| format!("Cannot connect to {}: {}", addr, e))?;

    // Set a 10-second write timeout so a hung printer doesn't block forever
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| format!("Failed to set write timeout: {}", e))?;

    stream
        .write_all(&bytes)
        .map_err(|e| format!("Write failed: {}", e))?;

    Ok(())
}

/// Get the app version.
#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Save the printer mapping to shared state so the HTTP server can use it.
#[tauri::command]
fn save_printer_mapping(mapping: HashMap<String, String>) -> Result<(), String> {
    let mut guard = PRINTER_MAPPING.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(mapping);
    Ok(())
}

/// Load the current printer mapping from shared state.
#[tauri::command]
fn load_printer_mapping() -> Option<HashMap<String, String>> {
    get_printer_mapping()
}

/// Check for updates using Tauri's built-in updater.
#[tauri::command]
async fn check_for_updates(app: tauri::AppHandle) -> Result<bool, String> {
    let update = app.updater().check().await
        .map_err(|e| format!("Update check failed: {}", e))?;
    if update.is_update_available() {
        update.download_and_install().await
            .map_err(|e| format!("Update install failed: {}", e))?;
        Ok(true)
    } else {
        Ok(false)
    }
}

/// Check if an eventId has already been seen (for deduplication).
/// This shares the same dedup state as the HTTP server to prevent double printing.
#[tauri::command]
fn is_event_id_seen(event_id: String) -> bool {
    http_server::is_event_id_seen(&event_id)
}

/// Mark an eventId as seen (for deduplication).
/// This shares the same dedup state as the HTTP server to prevent double printing.
#[tauri::command]
fn mark_event_id_seen(event_id: String) {
    http_server::mark_event_id_seen(&event_id);
}

fn main() {
    tauri::Builder::default()
        .setup(|_app| {
            // Spawn the local HTTP print server on 0.0.0.0:PRINT_AGENT_PORT
            // so cashier (localhost) and captain tablets (LAN) can reach it.
            // Default 3102 avoids colliding with Edge Server which uses 3101.
            let port = std::env::var("PRINT_AGENT_PORT").unwrap_or_else(|_| "3102".to_string());
            let addr = format!("0.0.0.0:{}", port);
            std::thread::spawn(move || {
                http_server::start(&addr);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_printers,
            print_raw,
            print_network,
            get_app_version,
            save_printer_mapping,
            load_printer_mapping,
            check_for_updates,
            is_event_id_seen,
            mark_event_id_seen
        ])
        .run(tauri::generate_context!())
        .expect("error while running SoftShape Print Agent");
}
