// ─────────────────────────────────────────────────────────────────────────────
// runtime-host/src/main.rs — SoftShape Runtime Host
// ─────────────────────────────────────────────────────────────────────────────
// A minimal (~200 line) Rust binary that:
//   1. Starts on user logon (via Windows registry Run key)
//   2. Spawns the Runtime (edge-server.exe)
//   3. Watches it — respawns on crash (with crash-loop guard)
//   4. Health-probes every 10s — kills + respawns if unresponsive
//   5. Pipes Runtime stdout/stderr to %LOCALAPPDATA%\Softshape\logs\runtime-host.log
//   6. No tray icon, no UI — purely headless supervision
//
// The Host is the ONLY process that starts the Runtime. The Cashier app
// connects to the Runtime as a client. If the Cashier is closed, the
// Runtime keeps running. If the Runtime crashes, the Host respawns it.
//
// Crash-loop guard: if the Runtime dies 3+ times within 60 seconds,
// the Host stops respawning and writes an error to the log. This
// prevents infinite respawn loops from a broken binary or corrupted DB.
// ─────────────────────────────────────────────────────────────────────────────

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use softshape_host::{
    is_heartbeat_stale, read_heartbeat_timestamp, try_acquire_lock, release_lock,
    lock_file_path, HEARTBEAT_STALE_SECS,
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const RUNTIME_PORT: u16 = 3101;
const WATCHDOG_INTERVAL_SECS: u64 = 10;
const HEALTH_PROBE_TIMEOUT_SECS: u64 = 5;
const CRASH_LIMIT: u32 = 5;
const CRASH_WINDOW_SECS: u64 = 30;
const UPDATE_CHECK_INTERVAL_SECS: u64 = 3600; // 1 hour
const UPDATE_DOWNLOAD_TIMEOUT_SECS: u64 = 120; // 2 min

static SHUTDOWN: AtomicBool = AtomicBool::new(false);
static CRASH_COUNT: AtomicU32 = AtomicU32::new(0);

// ── Log directory ────────────────────────────────────────────────────────────

fn log_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
            let dir = PathBuf::from(local_app_data).join("Softshape").join("logs");
            let _ = fs::create_dir_all(&dir);
            return dir;
        }
    }
    PathBuf::from(".").join("logs")
}

fn log_file() -> PathBuf {
    log_dir().join("runtime-host.log")
}

fn log(msg: &str) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| {
            chrono_format(d.as_secs())
        })
        .unwrap_or_else(|_| "?".to_string());

    let line = format!("[{}] [Host] {}", timestamp, msg);
    eprintln!("{}", line);

    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log_file()) {
        let _ = writeln!(f, "{}", line);
    }
}

// Minimal ISO-8601 timestamp formatter (avoids chrono dependency)
fn chrono_format(unix_secs: u64) -> String {
    let days_since_epoch = unix_secs / 86400;
    let secs_in_day = unix_secs % 86400;
    let hour = secs_in_day / 3600;
    let min = (secs_in_day % 3600) / 60;
    let sec = secs_in_day % 60;

    // Calculate date from days since 1970-01-01
    let (year, month, day) = days_to_date(days_since_epoch);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}", year, month, day, hour, min, sec)
}

fn days_to_date(days: u64) -> (u64, u64, u64) {
    // Algorithm: convert days since epoch to (year, month, day)
    let mut days = days as i64;
    let mut year = 1970i64;

    loop {
        let days_in_year = if is_leap_year(year) { 366 } else { 365 };
        if days < days_in_year {
            break;
        }
        days -= days_in_year;
        year += 1;
    }

    let months = [31, if is_leap_year(year) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 1u64;
    for &dim in &months {
        if days < dim {
            break;
        }
        days -= dim;
        month += 1;
    }

    (year as u64, month, days as u64 + 1)
}

fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

// ── Resolve the Runtime executable ───────────────────────────────────────────

fn resolve_runtime_exe() -> Option<PathBuf> {
    // 1. Explicit env override
    if let Ok(path) = env::var("SOFTSHAPE_RUNTIME_EXE") {
        let p = PathBuf::from(path);
        if p.is_file() {
            return Some(p);
        }
    }

    // 2. Same directory as the Host executable
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("edge-server.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    // 3. Common install locations
    #[cfg(windows)]
    {
        if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
            let base = PathBuf::from(&local_app_data).join("Softshape");
            let candidates = [
                base.join("bin").join("edge-server.exe"),
                base.join("edge-server.exe"),
            ];
            for c in &candidates {
                if c.is_file() {
                    return Some(c.clone());
                }
            }
        }

        let program_files = PathBuf::from("C:\\Program Files\\Softshape");
        let candidate = program_files.join("edge-server.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    // 4. Development: relative to Cargo manifest
    if cfg!(debug_assertions) {
        let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("edge-server")
            .join("edge-server.exe");
        if dev_path.is_file() {
            return Some(dev_path);
        }
    }

    None
}

// ── Spawn the Runtime ────────────────────────────────────────────────────────

fn spawn_runtime(exe: &PathBuf) -> Option<Child> {
    log(&format!("Spawning Runtime: {}", exe.display()));

    let log_path = log_dir().join("runtime-stdout.log");
    let stdout_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .ok()
        .map(Stdio::from);

    let stderr_log_path = log_dir().join("runtime-stderr.log");
    let stderr_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&stderr_log_path)
        .ok()
        .map(Stdio::from);

    let mut cmd = Command::new(exe);
    cmd.env("EDGE_PORT", RUNTIME_PORT.to_string());

    if let Some(stdout) = stdout_file {
        cmd.stdout(stdout);
    } else {
        cmd.stdout(Stdio::null());
    }
    if let Some(stderr) = stderr_file {
        cmd.stderr(stderr);
    } else {
        cmd.stderr(Stdio::null());
    }

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    match cmd.spawn() {
        Ok(child) => {
            log(&format!("Runtime started (PID: {})", child.id()));
            Some(child)
        }
        Err(e) => {
            log(&format!("Failed to spawn Runtime: {}", e));
            None
        }
    }
}

// ── Health probe ─────────────────────────────────────────────────────────────

fn health_probe() -> bool {
    use std::io::{Read, Write};
    use std::net::TcpStream;

    let addr = format!("127.0.0.1:{}", RUNTIME_PORT);
    let mut stream = match TcpStream::connect_timeout(
        &addr.parse().unwrap_or_else(|_| "127.0.0.1:3101".parse().unwrap()),
        Duration::from_secs(HEALTH_PROBE_TIMEOUT_SECS),
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

    response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
}

// ── Crash-loop guard ─────────────────────────────────────────────────────────

fn check_crash_loop() -> bool {
    let count = CRASH_COUNT.load(Ordering::Relaxed);
    count >= CRASH_LIMIT
}

fn record_crash() {
    let prev = CRASH_COUNT.fetch_add(1, Ordering::Relaxed);
    log(&format!("Runtime crash recorded (count: {})", prev + 1));
}

fn reset_crash_count() {
    CRASH_COUNT.store(0, Ordering::Relaxed);
}

// ── Windows autostart registration ───────────────────────────────────────────

#[cfg(windows)]
fn register_autostart() {
    use windows::Win32::System::Registry::{
        RegOpenKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
        REG_SZ,
    };
    use windows::core::PCWSTR;

    let exe_path = match env::current_exe() {
        Ok(p) => p,
        Err(_) => return,
    };
    let exe_path_str = exe_path.to_string_lossy().to_string();

    // Open HKCU\Software\Microsoft\Windows\CurrentVersion\Run
    let subkey = to_wide("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
    let mut hkey = HKEY::default();

    let result = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR::from_raw(subkey.as_ptr()),
            0,
            KEY_SET_VALUE,
            &mut hkey,
        )
    };

    if result.is_err() {
        log("Failed to open Run registry key for autostart");
        return;
    }

    let value_name = to_wide("SoftshapeRuntimeHost");
    let value_data = to_wide(&format!("\"{}\" --silent", exe_path_str));
    let data_bytes: &[u8] = unsafe {
        std::slice::from_raw_parts(
            value_data.as_ptr() as *const u8,
            value_data.len() * 2,
        )
    };

    let result = unsafe {
        RegSetValueExW(
            hkey,
            PCWSTR::from_raw(value_name.as_ptr()),
            0,
            REG_SZ,
            Some(data_bytes),
        )
    };

    let _ = result;
    log("Registered for Windows autostart (HKCU Run key)");
}

#[cfg(windows)]
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(not(windows))]
fn register_autostart() {
    // No-op on non-Windows platforms
}

// ── Signal handling ──────────────────────────────────────────────────────────

#[cfg(windows)]
fn setup_signal_handlers() {
    // On Windows, we use a console control handler for Ctrl+C
    // For a windows_subsystem = windows app, this is less relevant,
    // but we still handle it for debug builds.
    extern "system" {
        fn SetConsoleCtrlHandler(
            handler: Option<unsafe extern "system" fn(u32) -> i32>,
            add: i32,
        ) -> i32;
    }

    unsafe extern "system" fn ctrl_handler(_ctrl_type: u32) -> i32 {
        SHUTDOWN.store(true, Ordering::Relaxed);
        1 // TRUE = we handled it
    }

    unsafe {
        SetConsoleCtrlHandler(Some(ctrl_handler), 1);
    }
}

#[cfg(not(windows))]
fn setup_signal_handlers() {
    // On Unix, we could use signal hooks, but the Host is Windows-only
}

// ── Runtime update: check, download, swap ────────────────────────────────────
// The Host polls the Runtime's /api/edge/update-check endpoint every hour.
// If an update is available, the Host:
//   1. Downloads the new edge-server.exe to a temp file
//   2. Stops the current Runtime process
//   3. Renames the old binary to .old (backup)
//   4. Moves the new binary to the target path
//   5. Restarts the Runtime
//   6. If the new Runtime fails health probe within 30s, rolls back

struct UpdateInfo {
    download_url: String,
    version: String,
}

fn check_for_runtime_update(_runtime_exe: &PathBuf) -> Option<UpdateInfo> {
    use std::io::{Read, Write};
    use std::net::TcpStream;

    let addr = format!("127.0.0.1:{}", RUNTIME_PORT);
    let mut stream = match TcpStream::connect_timeout(
        &addr.parse().unwrap_or_else(|_| "127.0.0.1:3101".parse().unwrap()),
        Duration::from_secs(5),
    ) {
        Ok(s) => s,
        Err(_) => return None,
    };

    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));

    let request = "GET /api/edge/update-check HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";
    if stream.write_all(request.as_bytes()).is_err() {
        return None;
    }

    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return None;
    }

    if !response.starts_with("HTTP/1.1 200") {
        return None;
    }

    // Parse JSON body (after \r\n\r\n)
    let body_start = response.find("\r\n\r\n")?;
    let body = &response[body_start + 4..];

    // Minimal JSON parsing without serde to avoid adding dependencies
    // Look for "updateAvailable":true and "downloadUrl":"..."
    if !body.contains("\"updateAvailable\"") || !body.contains("true") {
        return None;
    }

    let url = extract_json_string(body, "downloadUrl")?;
    let version = extract_json_string(body, "version").unwrap_or_else(|| "unknown".to_string());

    Some(UpdateInfo { download_url: url, version })
}

fn extract_json_string(json: &str, key: &str) -> Option<String> {
    let pattern = format!("\"{}\"", key);
    let pos = json.find(&pattern)?;
    let after_key = &json[pos + pattern.len()..];
    let colon = after_key.find(':')?;
    let after_colon = &after_key[colon + 1..];
    let quote_start = after_colon.find('"')?;
    let after_quote = &after_colon[quote_start + 1..];
    let quote_end = after_quote.find('"')?;
    Some(after_quote[..quote_end].to_string())
}

fn download_update(url: &str, dest: &PathBuf) -> bool {
    log(&format!("Downloading Runtime update from {}", url));

    // Use curl as a subprocess (available on Windows 10+)
    let result = Command::new("curl")
        .args([
            "-sL",
            "--fail",
            "--max-time", &UPDATE_DOWNLOAD_TIMEOUT_SECS.to_string(),
            "-o",
        ])
        .arg(dest)
        .arg(url)
        .output();

    match result {
        Ok(output) if output.status.success() => {
            // Verify the file is not empty
            if let Ok(metadata) = fs::metadata(dest) {
                if metadata.len() > 0 {
                    log(&format!("Downloaded update ({} bytes)", metadata.len()));
                    return true;
                }
            }
            log("Downloaded file is empty — update aborted");
            false
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            log(&format!("curl failed: {}", stderr.trim()));
            false
        }
        Err(e) => {
            log(&format!("Failed to run curl: {}", e));
            false
        }
    }
}

// ── Graceful Runtime shutdown ─────────────────────────────────────────────────
// Asks the Runtime to shut down via its HTTP API so it can run the pre-shutdown
// backup and close the SQLite DB cleanly (flushing WAL). Falls back to a hard
// kill if the Runtime doesn't exit within GRACEFUL_SHUTDOWN_TIMEOUT_SECS — this
// matters because the binary swap below requires the exe to no longer be loaded.

const GRACEFUL_SHUTDOWN_TIMEOUT_SECS: u64 = 8;

fn graceful_shutdown_runtime(child: &mut Child) {
    use std::io::{Read, Write};
    use std::net::TcpStream;

    // 1. POST /runtime/shutdown — the Runtime responds 200 immediately and
    //    exits a few ms later after running its shutdown handler.
    let addr = format!("127.0.0.1:{}", RUNTIME_PORT);
    if let Ok(mut stream) = TcpStream::connect_timeout(
        &addr.parse().unwrap_or_else(|_| "127.0.0.1:3101".parse().unwrap()),
        Duration::from_secs(2),
    ) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let req = "POST /runtime/shutdown HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let _ = stream.write_all(req.as_bytes());
        // Drain whatever it sends back so the request completes.
        let mut buf = [0u8; 128];
        let _ = stream.read(&mut buf);
    }

    // 2. Wait up to the timeout for the Runtime to exit on its own.
    let deadline = Instant::now() + Duration::from_secs(GRACEFUL_SHUTDOWN_TIMEOUT_SECS);
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => {
                log("Runtime exited gracefully after /runtime/shutdown");
                return;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
            Err(_) => break,
        }
    }

    // 3. Fallback: hard-kill if it didn't exit in time.
    log(&format!(
        "Runtime did not exit within {}s — hard-killing",
        GRACEFUL_SHUTDOWN_TIMEOUT_SECS
    ));
    let _ = child.kill();
    let _ = child.wait();
}

fn perform_runtime_update(
    runtime_exe: &PathBuf,
    update: UpdateInfo,
    child: &mut Child,
) -> bool {
    log(&format!("Starting Runtime update to version {}", update.version));

    let temp_path = runtime_exe.with_extension("exe.new");
    let backup_path = runtime_exe.with_extension("exe.old");

    // 1. Download the new binary
    if !download_update(&update.download_url, &temp_path) {
        log("Update download failed — aborting");
        let _ = fs::remove_file(&temp_path);
        return false;
    }

    // 2. Stop the current Runtime gracefully — lets it run the pre-shutdown
    //    backup and close the SQLite DB cleanly before the binary swap.
    log("Stopping Runtime for update swap");
    graceful_shutdown_runtime(child);

    // 3. Backup old binary
    let _ = fs::remove_file(&backup_path);
    if let Err(e) = fs::rename(runtime_exe, &backup_path) {
        log(&format!("Failed to backup old binary: {} — attempting to continue", e));
    }

    // 4. Move new binary to target path
    if let Err(e) = fs::rename(&temp_path, runtime_exe) {
        log(&format!("Failed to move new binary: {} — rolling back", e));
        let _ = fs::rename(&backup_path, runtime_exe);
        return false;
    }

    log("Binary swap complete — starting new Runtime");

    // 5. Restart the Runtime
    *child = match spawn_runtime(runtime_exe) {
        Some(c) => c,
        None => {
            log("Failed to start new Runtime — rolling back");
            let _ = fs::remove_file(runtime_exe);
            let _ = fs::rename(&backup_path, runtime_exe);
            *child = match spawn_runtime(runtime_exe) {
                Some(c) => c,
                None => {
                    log("FATAL: Rollback also failed — Runtime cannot start");
                    return false;
                }
            };
            return false;
        }
    };

    // 6. Wait for health probe (up to 30 seconds)
    let mut healthy = false;
    for _ in 0..15 {
        std::thread::sleep(Duration::from_secs(2));
        if health_probe() {
            healthy = true;
            break;
        }
    }

    if healthy {
        log(&format!("Runtime update to {} successful — new Runtime is healthy", update.version));
        let _ = fs::remove_file(&backup_path);
        true
    } else {
        log("New Runtime failed health probe — rolling back");
        let _ = child.kill();
        let _ = child.wait();
        let _ = fs::remove_file(runtime_exe);
        let _ = fs::rename(&backup_path, runtime_exe);
        *child = match spawn_runtime(runtime_exe) {
            Some(c) => {
                log("Rollback successful — old Runtime restarted");
                c
            }
            None => {
                log("FATAL: Rollback failed — Runtime cannot start");
                return false;
            }
        };
        false
    }
}

// ── Task Scheduler fallback (Phase 7) ─────────────────────────────────────────
// The Host registers a Windows Task Scheduler job as a second-level fallback.
// If the Host itself crashes or is killed, Task Scheduler restarts it within
// 5 minutes. This provides defense-in-depth beyond the autostart registry key.

fn heartbeat_file() -> PathBuf {
    log_dir().join("host.heartbeat")
}

fn write_heartbeat() {
    let path = heartbeat_file();
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let _ = fs::write(&path, format!("{}\n", ts));
}

fn register_task_scheduler() {
    #[cfg(windows)]
    {
        let exe = match env::current_exe() {
            Ok(e) => e,
            Err(_) => return,
        };

        let exe_path = exe.to_string_lossy().to_string();

        // Use schtasks to create a scheduled task that restarts the Host
        // if it crashes. The task runs every 5 minutes and at logon.
        // IgnoreNew prevents duplicate instances.
        let result = Command::new("schtasks")
            .args([
                "/create",
                "/tn", "SoftShape Host Monitor",
                "/tr", &format!("\"{}\" --no-autostart", exe_path),
                "/sc", "minute",
                "/mo", "5",
                "/f",
                "/rl", "limited",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        match result {
            Ok(output) if output.status.success() => {
                log("Task Scheduler fallback registered (every 5 minutes)");
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                log(&format!("Task Scheduler registration failed (non-fatal): {}", stderr.trim()));
            }
            Err(e) => {
                log(&format!("Could not run schtasks (non-fatal): {}", e));
            }
        }
    }
}

fn unregister_task_scheduler() {
    #[cfg(windows)]
    {
        let result = Command::new("schtasks")
            .args(["/delete", "/tn", "SoftShape Host Monitor", "/f"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        match result {
            Ok(output) if output.status.success() => {
                log("Task Scheduler fallback removed");
            }
            _ => {
                // Non-fatal — task may not exist
            }
        }
    }
}

// ── Main supervision loop ────────────────────────────────────────────────────

fn print_status() {
    let dir = log_dir();
    let hb_path = heartbeat_file();
    let lock_path = lock_file_path(&dir);

    println!("=== SoftShape Host Status ===");
    println!("Log directory: {}", dir.display());

    // Check heartbeat
    if let Some(ts) = read_heartbeat_timestamp(&hb_path) {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        let age = now.saturating_sub(ts);
        let stale = is_heartbeat_stale(ts, now);
        println!("Heartbeat: {} ({}s old){}", ts, age, if stale { " [STALE]" } else { " [fresh]" });
    } else {
        println!("Heartbeat: none (Host not running or just started)");
    }

    // Check lock file
    if lock_path.exists() {
        let content = fs::read_to_string(&lock_path).unwrap_or_default();
        println!("Lock file: {} (PID: {})", lock_path.display(), content.trim());
    } else {
        println!("Lock file: none (Host not running)");
    }

    // Check Runtime health
    if health_probe() {
        println!("Runtime: HEALTHY (port {})", RUNTIME_PORT);
    } else {
        println!("Runtime: UNREACHABLE (port {})", RUNTIME_PORT);
    }

    // Check scheduler task
    #[cfg(windows)]
    {
        let result = Command::new("schtasks")
            .args(["/query", "/tn", "SoftShape Host Monitor"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        match result {
            Ok(output) if output.status.success() => {
                println!("Task Scheduler: registered");
            }
            _ => {
                println!("Task Scheduler: not registered");
            }
        }
    }

    println!("=============================");
}

fn main() {
    log("SoftShape Runtime Host starting");

    let args: Vec<String> = env::args().collect();
    let no_autostart = args.iter().any(|a| a == "--no-autostart");
    let register_scheduler = args.iter().any(|a| a == "--register-scheduler");
    let unregister_scheduler = args.iter().any(|a| a == "--unregister-scheduler");
    let status_flag = args.iter().any(|a| a == "--status");

    // --status: print current status and exit
    if status_flag {
        print_status();
        return;
    }

    // --unregister-scheduler: remove the Task Scheduler fallback and exit
    if unregister_scheduler {
        unregister_task_scheduler();
        log("Scheduler unregistered. Host exiting.");
        return;
    }

    // --register-scheduler: install the Task Scheduler fallback and exit
    if register_scheduler {
        register_task_scheduler();
        log("Scheduler registered. Host exiting.");
        return;
    }

    // ── Single-instance guard (Phase 7) ──────────────────────────────────────
    // Task Scheduler fires every 5 minutes. If the Host is already running,
    // the lock file prevents a duplicate instance.
    let lock_path = lock_file_path(&log_dir());
    if !try_acquire_lock(&lock_path) {
        log("Another Host instance is already running — exiting.");
        return;
    }

    // Register autostart unless --no-autostart is passed
    if !no_autostart {
        register_autostart();
        // Also register Task Scheduler fallback for defense-in-depth
        register_task_scheduler();
    }

    // ── Self-watchdog thread (Phase 7) ────────────────────────────────────────
    // A separate thread monitors the heartbeat file. If the main supervision
    // loop hangs (deadlock, infinite loop in a driver, etc.), the heartbeat
    // goes stale. The self-watchdog forces the Host to exit, which releases
    // the lock file and allows Task Scheduler to restart the Host.
    std::thread::spawn(move || {
        let hb_path = heartbeat_file();
        loop {
            std::thread::sleep(Duration::from_secs(HEARTBEAT_STALE_SECS));
            if SHUTDOWN.load(Ordering::Relaxed) {
                return;
            }
            if let Some(ts) = read_heartbeat_timestamp(&hb_path) {
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                if is_heartbeat_stale(ts, now) {
                    log("SELF-WATCHDOG: heartbeat is stale — Host appears hung. Forcing exit.");
                    SHUTDOWN.store(true, Ordering::Relaxed);
                    // Give the main loop a moment to clean up, then force exit
                    std::thread::sleep(Duration::from_secs(5));
                    std::process::exit(1);
                }
            }
        }
    });

    setup_signal_handlers();

    let runtime_exe = match resolve_runtime_exe() {
        Some(exe) => exe,
        None => {
            log("FATAL: Runtime executable (edge-server.exe) not found. Searched:");
            log("  - SOFTSHAPE_RUNTIME_EXE env var");
            log("  - Same directory as host executable");
            log("  - %LOCALAPPDATA%\\Softshape\\bin\\edge-server.exe");
            log("  - C:\\Program Files\\Softshape\\edge-server.exe");
            if cfg!(debug_assertions) {
                log("  - ../edge-server/edge-server.exe (dev mode)");
            }
            log("Host will exit. Please reinstall SoftShape POS.");
            return;
        }
    };

    log(&format!("Runtime executable: {}", runtime_exe.display()));

    // ── Spawn the Runtime ────────────────────────────────────────────────────
    let mut child = match spawn_runtime(&runtime_exe) {
        Some(c) => c,
        None => {
            log("FATAL: Could not spawn Runtime. Host will exit.");
            return;
        }
    };

    let mut last_crash_time: Option<Instant> = None;
    let mut crash_window_start: Option<Instant> = None;
    let mut last_update_check: Option<Instant> = Some(Instant::now()); // delay first check

    // Write initial heartbeat so the self-watchdog doesn't fire immediately
    write_heartbeat();

    // ── Supervision loop ─────────────────────────────────────────────────────
    while !SHUTDOWN.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_secs(WATCHDOG_INTERVAL_SECS));

        if SHUTDOWN.load(Ordering::Relaxed) {
            break;
        }

        // Write heartbeat file — Task Scheduler can check this to determine
        // if the Host is alive (vs. hung but still running)
        write_heartbeat();

        // ── Periodic update check ────────────────────────────────────────────
        let now = Instant::now();
        let should_check_update = match last_update_check {
            Some(last) => now.duration_since(last).as_secs() >= UPDATE_CHECK_INTERVAL_SECS,
            None => true,
        };
        if should_check_update {
            if let Some(update) = check_for_runtime_update(&runtime_exe) {
                log(&format!("Runtime update available: version {}", update.version));
                perform_runtime_update(&runtime_exe, update, &mut child);
            }
            last_update_check = Some(Instant::now());
        }

        // Check if the process has exited
        let exited = match child.try_wait() {
            Ok(Some(status)) => {
                let code = status.code().unwrap_or(-1);
                // 0xc000001d = STATUS_ILLEGAL_INSTRUCTION (as signed i32: -1073741795)
                if code == -1073741795 {
                    log("Runtime exited with STATUS_ILLEGAL_INSTRUCTION (0xc000001d)");
                    log("This CPU does not support the instruction set used by edge-server.exe.");
                    log("The binary was likely built without --target=bun-windows-x64-baseline.");
                    log("Rebuild with the baseline target or use a CPU with SSE4.2+ support.");
                } else {
                    log(&format!("Runtime exited with status: {}", status));
                }
                true
            }
            Ok(None) => false, // still running
            Err(e) => {
                log(&format!("Failed to inspect Runtime process: {}", e));
                true // treat as exited
            }
        };

        if exited {
            // ── Crash-loop guard ─────────────────────────────────────────────
            let now = Instant::now();
            if let Some(window_start) = crash_window_start {
                if now.duration_since(window_start).as_secs() >= CRASH_WINDOW_SECS {
                    // Window expired — reset
                    reset_crash_count();
                    crash_window_start = Some(now);
                }
            } else {
                crash_window_start = Some(now);
            }

            record_crash();

            if check_crash_loop() {
                log(&format!(
                    "CRASH LOOP DETECTED: Runtime crashed {} times in {}s. Stopping respawn.",
                    CRASH_COUNT.load(Ordering::Relaxed),
                    CRASH_WINDOW_SECS
                ));
                log("The Runtime may need to be reinstalled. Host will keep running so it can resume if the binary is updated.");
                // Wait for a cooldown period before trying again
                std::thread::sleep(Duration::from_secs(60));
                reset_crash_count();
                crash_window_start = Some(Instant::now());
            }

            // ── Respawn ──────────────────────────────────────────────────────
            child = match spawn_runtime(&runtime_exe) {
                Some(c) => c,
                None => {
                    log("Failed to respawn Runtime. Will retry in 10s.");
                    continue;
                }
            };

            last_crash_time = Some(now);
            continue;
        }

        // ── Process is still running — health probe ──────────────────────────
        if health_probe() {
            // Runtime is healthy — reset crash counter
            if last_crash_time.is_some() {
                let elapsed = last_crash_time.unwrap().elapsed();
                if elapsed.as_secs() > CRASH_WINDOW_SECS {
                    reset_crash_count();
                    crash_window_start = None;
                    last_crash_time = None;
                }
            }
        } else {
            // Runtime is unresponsive — kill and respawn
            log("Runtime health probe failed — killing and respawning");
            let _ = child.kill();
            let _ = child.wait();
            // The next iteration will detect the exit and respawn
        }
    }

    // ── Shutdown ─────────────────────────────────────────────────────────────
    log("Host shutting down — killing Runtime");
    let _ = child.kill();
    let _ = child.wait();
    release_lock(&lock_path);
    log("Host exited");
}
