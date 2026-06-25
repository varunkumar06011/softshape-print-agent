#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use serde::{Deserialize, Serialize};

#[cfg(windows)]
mod windows_printing;

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
        Err("Printing is only supported on Windows".to_string())
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

    stream
        .write_all(&bytes)
        .map_err(|e| format!("Write failed: {}", e))?;

    Ok(())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_printers,
            print_raw,
            print_network
        ])
        .run(tauri::generate_context!())
        .expect("error while running SoftShape Print Agent");
}
