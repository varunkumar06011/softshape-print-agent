#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Mutex;

#[cfg(windows)]
mod windows_printing;

static SEEN_EVENT_IDS: Mutex<Option<HashSet<String>>> = Mutex::new(None);
const SEEN_EVENT_IDS_MAX: usize = 500;

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

/// Detect this machine's primary LAN IPv4 address.
/// Uses a connected UDP socket — `connect()` on a UDP socket only sets the
/// default destination (no packets are sent), and `local_addr()` returns the
/// interface IP the OS routing table would use to reach it. More reliable than
/// WebRTC ICE candidate gathering, which WebView2 obfuscates to mDNS hostnames.
#[tauri::command]
fn get_lan_ip() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    // 8.8.8.8 is only used to force the OS to pick a non-loopback route;
    // no traffic is actually sent for a UDP connect.
    socket.connect("8.8.8.8:80").ok()?;
    match socket.local_addr().ok()? {
        std::net::SocketAddr::V4(addr) => {
            let ip = addr.ip();
            if !ip.is_loopback() && !ip.is_unspecified() {
                Some(ip.to_string())
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Check if an eventId has already been seen (for cross-path deduplication).
#[tauri::command]
fn is_event_id_seen(event_id: String) -> bool {
    let mut guard = SEEN_EVENT_IDS.lock().unwrap();
    let set = guard.get_or_insert_with(HashSet::new);
    set.contains(&event_id)
}

/// Mark an eventId as seen (for cross-path deduplication).
/// Evicts an arbitrary entry when the cache exceeds SEEN_EVENT_IDS_MAX to
/// keep memory bounded.
#[tauri::command]
fn mark_event_id_seen(event_id: String) {
    let mut guard = SEEN_EVENT_IDS.lock().unwrap();
    let set = guard.get_or_insert_with(HashSet::new);
    if set.len() >= SEEN_EVENT_IDS_MAX {
        if let Some(first) = set.iter().next().cloned() {
            set.remove(&first);
        }
    }
    set.insert(event_id);
}

/// Atomic test-and-set for cross-path deduplication.
/// Returns true if the eventId was ALREADY seen (duplicate — caller should skip).
/// Returns false if the eventId was NOT seen and has now been marked (first
/// occurrence — caller should proceed to print).
/// This eliminates the race window between separate check-then-mark calls
/// where two async paths could both pass the check before either marks.
#[tauri::command]
fn check_and_mark_event_id(event_id: String) -> bool {
    let mut guard = SEEN_EVENT_IDS.lock().unwrap();
    let set = guard.get_or_insert_with(HashSet::new);
    if set.contains(&event_id) {
        return true; // already seen — duplicate
    }
    if set.len() >= SEEN_EVENT_IDS_MAX {
        if let Some(first) = set.iter().next().cloned() {
            set.remove(&first);
        }
    }
    set.insert(event_id);
    false // newly marked — first occurrence
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_printers,
            print_raw,
            print_network,
            get_lan_ip,
            is_event_id_seen,
            mark_event_id_seen,
            check_and_mark_event_id
        ])
        .run(tauri::generate_context!())
        .expect("error while running SoftShape Print Agent");
}
