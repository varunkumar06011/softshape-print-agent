#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{
    CustomMenuItem, Manager, SystemTray, SystemTrayEvent, SystemTrayMenu, SystemTrayMenuItem,
    WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

#[cfg(windows)]
mod windows_printing;
mod http_server;

// Shared printer mapping: role -> printer name. Updated by the frontend UI
// and read by the local HTTP server to resolve empty printerName requests.
static PRINTER_MAPPING: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

// Tray connection status — updated by the frontend via update_connection_status
static TRAY_CONNECTION_STATUS: Mutex<String> = Mutex::new(String::new());

fn update_tray_tooltip(app: &tauri::AppHandle) {
    let status = TRAY_CONNECTION_STATUS.lock().map(|g| g.clone()).unwrap_or_default();
    let tooltip = if status.is_empty() {
        "SoftShape Print Agent".to_string()
    } else {
        format!("SoftShape Print Agent — {}", status)
    };
    let _ = app.tray_handle().set_tooltip(&tooltip);
}

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

/// Atomic test-and-set for deduplication. Returns true if already seen (duplicate),
/// false if newly marked (first occurrence). Eliminates the check-then-mark race.
#[tauri::command]
fn check_and_mark_event_id(event_id: String) -> bool {
    http_server::check_and_mark_event_id(&event_id)
}

/// Enable autostart on Windows boot (Run registry key).
#[tauri::command]
fn enable_autostart(app: tauri::AppHandle) -> Result<(), String> {
    app.autolaunch()
        .enable()
        .map_err(|e| format!("Failed to enable autostart: {}", e))
}

/// Disable autostart.
#[tauri::command]
fn disable_autostart(app: tauri::AppHandle) -> Result<(), String> {
    app.autolaunch()
        .disable()
        .map_err(|e| format!("Failed to disable autostart: {}", e))
}

/// Check if autostart is currently enabled.
#[tauri::command]
fn is_autostart_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    Ok(app.autolaunch().is_enabled().unwrap_or(false))
}

/// Update the tray tooltip connection status from the frontend.
#[tauri::command]
fn update_connection_status(app: tauri::AppHandle, status: String) -> Result<(), String> {
    if let Ok(mut guard) = TRAY_CONNECTION_STATUS.lock() {
        *guard = status;
    }
    update_tray_tooltip(&app);
    Ok(())
}

fn check_edge_health() -> bool {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    let mut stream = match TcpStream::connect_timeout(
        &"127.0.0.1:3101".parse().unwrap(),
        Duration::from_secs(2),
    ) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let request = "GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }
    response.starts_with("HTTP/1.1 200")
}

fn spawn_runtime_host_if_needed(app: tauri::AppHandle) {
    if check_edge_health() {
        eprintln!("[PrintAgent] Edge server already running on :3101 — skipping host spawn");
        return;
    }
    let resource_dir = match tauri::api::path::resource_dir(&app.config()) {
        Some(dir) => dir,
        None => {
            eprintln!("[PrintAgent] Failed to resolve resource dir");
            return;
        }
    };
    let host_exe = resource_dir.join("softshape-host.exe");
    if !host_exe.exists() {
        eprintln!("[PrintAgent] softshape-host.exe not found in resources: {}", host_exe.display());
        return;
    }
    let mut cmd = std::process::Command::new(&host_exe);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    match cmd.spawn()
    {
        Ok(child) => {
            eprintln!("[PrintAgent] Spawned softshape-host.exe pid={}", child.id());
            std::mem::forget(child);
        }
        Err(e) => eprintln!("[PrintAgent] Failed to spawn softshape-host.exe: {}", e),
    }
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn main() {
    // System tray: Show Window + Quit
    let show_item = CustomMenuItem::new("show".to_string(), "Show Window");
    let quit_item = CustomMenuItem::new("quit".to_string(), "Quit");
    let tray_menu = SystemTrayMenu::new()
        .add_item(show_item)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(quit_item);
    let system_tray = SystemTray::new().with_menu(tray_menu);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Focus existing window when a second instance is launched
            if let Some(window) = app.get_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["ai.softshape.print-agent"]),
        ))
        .system_tray(system_tray)
        .on_system_tray_event(|app, event| match event {
            SystemTrayEvent::LeftClick { .. } => {
                if let Some(window) = app.get_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
                "show" => {
                    if let Some(window) = app.get_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "quit" => {
                    // This is the ONLY way to actually exit
                    app.exit(0);
                }
                _ => {}
            },
            _ => {}
        })
        .setup(|app| {
            // Enable autostart by default on first run
            let autostart = app.autolaunch();
            if !autostart.is_enabled().unwrap_or(false) {
                let _ = autostart.enable();
                eprintln!("[Autostart] Enabled on first run");
            }

            // Close-to-tray: intercept close request on the main window, hide instead
            if let Some(window) = app.get_window("main") {
                let w = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        let _ = w.hide();
                        api.prevent_close();
                    }
                });
            }

            // Spawn the local HTTP print server on 0.0.0.0:PRINT_AGENT_PORT
            // so cashier (localhost) and captain tablets (LAN) can reach it.
            // Default 3102 avoids colliding with Edge Server which uses 3101.
            let port = std::env::var("PRINT_AGENT_PORT").unwrap_or_else(|_| "3102".to_string());
            let addr = format!("0.0.0.0:{}", port);
            std::thread::spawn(move || {
                http_server::start(&addr);
            });

            // Spawn the Runtime Host (softshape-host.exe) which supervises
            // edge-server.exe and print-service.exe. The host registers itself
            // for Windows autostart on first run.
            spawn_runtime_host_if_needed(app.handle());

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
            get_lan_ip,
            is_event_id_seen,
            mark_event_id_seen,
            check_and_mark_event_id,
            enable_autostart,
            disable_autostart,
            is_autostart_enabled,
            update_connection_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running SoftShape Print Agent");
}
