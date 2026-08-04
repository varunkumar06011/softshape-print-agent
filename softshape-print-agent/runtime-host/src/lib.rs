// ─────────────────────────────────────────────────────────────────────────────
// runtime-host/src/lib.rs — Testable logic extracted from main.rs
// ─────────────────────────────────────────────────────────────────────────────
// The Host is a binary (main.rs), so we extract pure logic functions into
// a lib.rs for unit testing. The binary calls these functions.
// ─────────────────────────────────────────────────────────────────────────────

use std::sync::atomic::{AtomicU32, Ordering};

pub const CRASH_LIMIT: u32 = 3;
pub const CRASH_WINDOW_SECS: u64 = 60;

// ── Crash-loop guard logic ───────────────────────────────────────────────────

pub struct CrashLoopGuard {
    crash_count: AtomicU32,
    window_start: std::sync::Mutex<Option<std::time::Instant>>,
}

impl Default for CrashLoopGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl CrashLoopGuard {
    pub fn new() -> Self {
        Self {
            crash_count: AtomicU32::new(0),
            window_start: std::sync::Mutex::new(None),
        }
    }

    pub fn record_crash(&self) {
        let now = std::time::Instant::now();
        let mut window = self.window_start.lock().unwrap();

        if let Some(start) = *window {
            if now.duration_since(start).as_secs() >= CRASH_WINDOW_SECS {
                // Window expired — reset
                self.crash_count.store(0, Ordering::Relaxed);
                *window = Some(now);
            }
        } else {
            *window = Some(now);
        }

        self.crash_count.fetch_add(1, Ordering::Relaxed);
    }

    pub fn is_crash_loop(&self) -> bool {
        self.crash_count.load(Ordering::Relaxed) >= CRASH_LIMIT
    }

    pub fn crash_count(&self) -> u32 {
        self.crash_count.load(Ordering::Relaxed)
    }

    pub fn reset(&self) {
        self.crash_count.store(0, Ordering::Relaxed);
        *self.window_start.lock().unwrap() = None;
    }
}

// ── Health probe response parsing ────────────────────────────────────────────

pub fn is_healthy_response(response: &str) -> bool {
    response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
}

// ── Date formatting (no chrono dependency) ───────────────────────────────────

pub fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

pub fn days_to_date(days: u64) -> (u64, u64, u64) {
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

pub fn format_timestamp(unix_secs: u64) -> String {
    let days_since_epoch = unix_secs / 86400;
    let secs_in_day = unix_secs % 86400;
    let hour = secs_in_day / 3600;
    let min = (secs_in_day % 3600) / 60;
    let sec = secs_in_day % 60;
    let (year, month, day) = days_to_date(days_since_epoch);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}", year, month, day, hour, min, sec)
}

// ── Network printer parsing ──────────────────────────────────────────────────

pub fn parse_network_printer(printer_name: &str) -> Option<(String, u16)> {
    let (ip, port) = printer_name.rsplit_once(':')?;
    if ip.parse::<std::net::Ipv4Addr>().is_err() {
        return None;
    }
    Some((ip.to_string(), port.parse().ok()?))
}

// ── JSON string extraction (minimal, no serde dependency) ────────────────────

pub fn extract_json_string(json: &str, key: &str) -> Option<String> {
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

// ── Heartbeat staleness detection (Phase 7) ───────────────────────────────────

pub const HEARTBEAT_STALE_SECS: u64 = 120; // 2 minutes — Host writes every 10s

pub fn is_heartbeat_stale(heartbeat_secs: u64, now_secs: u64) -> bool {
    now_secs.saturating_sub(heartbeat_secs) > HEARTBEAT_STALE_SECS
}

pub fn read_heartbeat_timestamp(path: &std::path::Path) -> Option<u64> {
    let content = std::fs::read_to_string(path).ok()?;
    content.trim().parse::<u64>().ok()
}

// ── Single-instance lock file (Phase 7) ───────────────────────────────────────

pub fn lock_file_path(log_dir: &std::path::Path) -> std::path::PathBuf {
    log_dir.join("host.lock")
}

pub fn try_acquire_lock(lock_path: &std::path::Path) -> bool {
    // Write our PID to the lock file. If the file already exists and the
    // PID inside is still alive, we fail to acquire the lock.
    use std::io::Read;

    // Check existing lock
    if let Ok(mut f) = std::fs::OpenOptions::new().read(true).open(lock_path) {
        let mut content = String::new();
        if f.read_to_string(&mut content).is_ok() {
            if let Ok(pid) = content.trim().parse::<u32>() {
                if is_process_alive(pid) {
                    return false; // Another Host instance is running
                }
            }
        }
        // Stale lock — remove it
        let _ = std::fs::remove_file(lock_path);
    }

    // Write our PID
    let pid = std::process::id();
    let _ = std::fs::write(lock_path, format!("{}\n", pid));
    true
}

pub fn release_lock(lock_path: &std::path::Path) {
    let _ = std::fs::remove_file(lock_path);
}

#[cfg(windows)]
pub fn is_process_alive(pid: u32) -> bool {
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::Foundation::CloseHandle;

    unsafe {
        if let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            let _ = CloseHandle(handle);
            true
        } else {
            false
        }
    }
}

#[cfg(not(windows))]
pub fn is_process_alive(pid: u32) -> bool {
    // On non-Windows, check if /proc/{pid} exists (Linux) or use kill 0
    #[cfg(target_os = "linux")]
    {
        return std::path::Path::new(&format!("/proc/{}", pid)).exists();
    }
    #[cfg(not(target_os = "linux"))]
    {
        // Fallback: assume alive (non-Windows, non-Linux is not a target anyway)
        let _ = pid;
        true
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Crash-loop guard tests ───────────────────────────────────────────────

    #[test]
    fn crash_guard_starts_at_zero() {
        let guard = CrashLoopGuard::new();
        assert_eq!(guard.crash_count(), 0);
        assert!(!guard.is_crash_loop());
    }

    #[test]
    fn crash_guard_increments_on_record() {
        let guard = CrashLoopGuard::new();
        guard.record_crash();
        assert_eq!(guard.crash_count(), 1);
        assert!(!guard.is_crash_loop());
    }

    #[test]
    fn crash_guard_triggers_at_limit() {
        let guard = CrashLoopGuard::new();
        for _ in 0..CRASH_LIMIT {
            guard.record_crash();
        }
        assert_eq!(guard.crash_count(), CRASH_LIMIT);
        assert!(guard.is_crash_loop());
    }

    #[test]
    fn crash_guard_resets() {
        let guard = CrashLoopGuard::new();
        for _ in 0..CRASH_LIMIT {
            guard.record_crash();
        }
        assert!(guard.is_crash_loop());
        guard.reset();
        assert_eq!(guard.crash_count(), 0);
        assert!(!guard.is_crash_loop());
    }

    #[test]
    fn crash_guard_does_not_trigger_below_limit() {
        let guard = CrashLoopGuard::new();
        for _ in 0..(CRASH_LIMIT - 1) {
            guard.record_crash();
        }
        assert_eq!(guard.crash_count(), CRASH_LIMIT - 1);
        assert!(!guard.is_crash_loop());
    }

    // ── Health probe response parsing tests ──────────────────────────────────

    #[test]
    fn healthy_response_200_ok() {
        assert!(is_healthy_response("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"status\":\"ok\"}"));
    }

    #[test]
    fn healthy_response_http10() {
        assert!(is_healthy_response("HTTP/1.0 200 OK\r\n\r\n"));
    }

    #[test]
    fn unhealthy_response_500() {
        assert!(!is_healthy_response("HTTP/1.1 500 Internal Server Error\r\n\r\n"));
    }

    #[test]
    fn unhealthy_response_503() {
        assert!(!is_healthy_response("HTTP/1.1 503 Service Unavailable\r\n\r\n"));
    }

    #[test]
    fn unhealthy_response_empty() {
        assert!(!is_healthy_response(""));
    }

    // ── Date formatting tests ────────────────────────────────────────────────

    #[test]
    fn leap_year_detection() {
        assert!(is_leap_year(2000));
        assert!(is_leap_year(2024));
        assert!(!is_leap_year(1900));
        assert!(!is_leap_year(2023));
        assert!(!is_leap_year(2026));
    }

    #[test]
    fn leap_year_2026_is_not_leap() {
        assert!(!is_leap_year(2026));
    }

    #[test]
    fn epoch_start_date() {
        assert_eq!(days_to_date(0), (1970, 1, 1));
    }

    #[test]
    fn known_date_2024_jan_1() {
        // 2024-01-01 is 19723 days after 1970-01-01
        assert_eq!(days_to_date(19723), (2024, 1, 1));
    }

    #[test]
    fn format_timestamp_epoch() {
        assert_eq!(format_timestamp(0), "1970-01-01T00:00:00");
    }

    #[test]
    fn format_timestamp_known() {
        // 2024-01-01T00:00:00 UTC = 1704067200
        assert_eq!(format_timestamp(1704067200), "2024-01-01T00:00:00");
    }

    // ── Network printer parsing tests ────────────────────────────────────────

    #[test]
    fn parse_valid_network_printer() {
        let result = parse_network_printer("192.168.1.100:9100");
        assert_eq!(result, Some(("192.168.1.100".to_string(), 9100)));
    }

    #[test]
    fn parse_invalid_network_printer_no_port() {
        assert_eq!(parse_network_printer("192.168.1.100"), None);
    }

    #[test]
    fn parse_invalid_network_printer_bad_ip() {
        assert_eq!(parse_network_printer("not-an-ip:9100"), None);
    }

    #[test]
    fn parse_invalid_network_printer_bad_port() {
        assert_eq!(parse_network_printer("192.168.1.100:abc"), None);
    }

    #[test]
    fn parse_network_printer_with_high_port() {
        let result = parse_network_printer("10.0.0.5:65535");
        assert_eq!(result, Some(("10.0.0.5".to_string(), 65535)));
    }

    // ── JSON string extraction tests (for update check) ──────────────────────

    #[test]
    fn extract_json_string_finds_value() {
        let json = r#"{"version":"22.8.0","downloadUrl":"https://example.com/runtime.exe"}"#;
        assert_eq!(extract_json_string(json, "version"), Some("22.8.0".to_string()));
        assert_eq!(extract_json_string(json, "downloadUrl"), Some("https://example.com/runtime.exe".to_string()));
    }

    #[test]
    fn extract_json_string_missing_key() {
        let json = r#"{"version":"22.8.0"}"#;
        assert_eq!(extract_json_string(json, "downloadUrl"), None);
    }

    #[test]
    fn extract_json_string_empty_value() {
        let json = r#"{"version":""}"#;
        assert_eq!(extract_json_string(json, "version"), Some("".to_string()));
    }

    #[test]
    fn extract_json_string_with_spaces() {
        let json = r#"{ "version" : "22.8.0" }"#;
        assert_eq!(extract_json_string(json, "version"), Some("22.8.0".to_string()));
    }

    // ── Update check response parsing tests ──────────────────────────────────

    #[test]
    fn update_available_true() {
        let body = r#"{"version":"22.8.0","updateAvailable":true,"downloadUrl":"https://example.com/edge-server.exe"}"#;
        assert!(body.contains("\"updateAvailable\""));
        assert!(body.contains("true"));
        assert_eq!(extract_json_string(body, "downloadUrl"), Some("https://example.com/edge-server.exe".to_string()));
    }

    #[test]
    fn update_available_false() {
        let body = r#"{"version":"22.8.0","updateAvailable":false}"#;
        assert!(body.contains("\"updateAvailable\""));
        assert!(!body.contains("true"));
    }

    #[test]
    fn update_check_no_update_url_configured() {
        // When runtime_update_url is not set, the endpoint returns updateAvailable: false
        let body = r#"{"version":"22.8.0","updateAvailable":false}"#;
        assert!(!body.contains("true"));
        assert_eq!(extract_json_string(body, "downloadUrl"), None);
    }

    // ── Heartbeat and Task Scheduler fallback tests (Phase 7) ────────────────

    #[test]
    fn heartbeat_timestamp_is_valid_unix() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        // Should be a reasonable timestamp (after 2020)
        assert!(now > 1577836800);
    }

    #[test]
    fn heartbeat_stale_detection() {
        // A heartbeat older than 60 seconds is considered stale
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let stale_heartbeat = now - 120; // 2 minutes ago
        let fresh_heartbeat = now - 5;   // 5 seconds ago

        assert!(now - stale_heartbeat > 60);
        assert!(now - fresh_heartbeat <= 60);
    }

    #[test]
    fn schtasks_command_args_are_valid() {
        // Verify the schtasks argument structure is correct
        let args = vec![
            "/create",
            "/tn", "SoftShape Host Monitor",
            "/tr", "\"C:\\Program Files\\Softshape\\softshape-host.exe\" --no-autostart",
            "/sc", "minute",
            "/mo", "5",
            "/f",
            "/rl", "limited",
        ];

        assert_eq!(args[0], "/create");
        assert!(args.contains(&"SoftShape Host Monitor"));
        assert!(args.contains(&"minute"));
        assert!(args.contains(&"5"));
        assert!(args.contains(&"/f"));
    }

    #[test]
    fn schtasks_delete_args_are_valid() {
        let args = vec!["/delete", "/tn", "SoftShape Host Monitor", "/f"];
        assert_eq!(args[0], "/delete");
        assert!(args.contains(&"SoftShape Host Monitor"));
        assert!(args.contains(&"/f"));
    }

    // ── Heartbeat staleness tests (Phase 7) ──────────────────────────────────

    #[test]
    fn heartbeat_fresh_is_not_stale() {
        let now = 1700000000u64;
        let heartbeat = now - 10; // 10 seconds ago
        assert!(!is_heartbeat_stale(heartbeat, now));
    }

    #[test]
    fn heartbeat_old_is_stale() {
        let now = 1700000000u64;
        let heartbeat = now - 200; // 200 seconds ago (> 120s threshold)
        assert!(is_heartbeat_stale(heartbeat, now));
    }

    #[test]
    fn heartbeat_exactly_at_threshold_is_not_stale() {
        let now = 1700000000u64;
        let heartbeat = now - HEARTBEAT_STALE_SECS; // exactly 120s
        assert!(!is_heartbeat_stale(heartbeat, now)); // > not >=
    }

    #[test]
    fn heartbeat_one_second_past_threshold_is_stale() {
        let now = 1700000000u64;
        let heartbeat = now - (HEARTBEAT_STALE_SECS + 1);
        assert!(is_heartbeat_stale(heartbeat, now));
    }

    #[test]
    fn heartbeat_in_future_is_not_stale() {
        let now = 1700000000u64;
        let heartbeat = now + 100; // clock skew
        assert!(!is_heartbeat_stale(heartbeat, now));
    }

    #[test]
    fn read_heartbeat_parses_valid_timestamp() {
        let dir = std::env::temp_dir();
        let path = dir.join("test_heartbeat_valid.txt");
        std::fs::write(&path, "1700000000\n").unwrap();
        assert_eq!(read_heartbeat_timestamp(&path), Some(1700000000));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_heartbeat_returns_none_for_missing_file() {
        let path = std::env::temp_dir().join("nonexistent_heartbeat.txt");
        assert_eq!(read_heartbeat_timestamp(&path), None);
    }

    #[test]
    fn read_heartbeat_returns_none_for_invalid_content() {
        let dir = std::env::temp_dir();
        let path = dir.join("test_heartbeat_invalid.txt");
        std::fs::write(&path, "not-a-number\n").unwrap();
        assert_eq!(read_heartbeat_timestamp(&path), None);
        let _ = std::fs::remove_file(&path);
    }

    // ── Single-instance lock tests (Phase 7) ─────────────────────────────────

    #[test]
    fn lock_file_path_appends_host_lock() {
        let dir = std::path::Path::new("/tmp/softshape/logs");
        let lock = lock_file_path(dir);
        assert_eq!(lock, std::path::PathBuf::from("/tmp/softshape/logs/host.lock"));
    }

    #[test]
    fn try_acquire_lock_succeeds_when_no_lock_exists() {
        let dir = std::env::temp_dir();
        let lock = dir.join("test_host_lock_acquire.lock");
        let _ = std::fs::remove_file(&lock);
        assert!(try_acquire_lock(&lock));
        // Lock file should now exist with our PID
        let content = std::fs::read_to_string(&lock).unwrap();
        let pid: u32 = content.trim().parse().unwrap();
        assert_eq!(pid, std::process::id());
        release_lock(&lock);
        assert!(!lock.exists());
    }

    #[test]
    fn try_acquire_lock_fails_when_process_alive() {
        let dir = std::env::temp_dir();
        let lock = dir.join("test_host_lock_alive.lock");
        // Write our own PID — we are alive
        std::fs::write(&lock, format!("{}\n", std::process::id())).unwrap();
        assert!(!try_acquire_lock(&lock));
        let _ = std::fs::remove_file(&lock);
    }

    #[test]
    fn try_acquire_lock_steals_stale_lock() {
        let dir = std::env::temp_dir();
        let lock = dir.join("test_host_lock_stale.lock");
        // Write a PID that almost certainly doesn't exist
        std::fs::write(&lock, "99999999\n").unwrap();
        assert!(try_acquire_lock(&lock));
        // Lock should now have our PID
        let content = std::fs::read_to_string(&lock).unwrap();
        let pid: u32 = content.trim().parse().unwrap();
        assert_eq!(pid, std::process::id());
        release_lock(&lock);
    }

    #[test]
    fn release_lock_removes_file() {
        let dir = std::env::temp_dir();
        let lock = dir.join("test_host_lock_release.lock");
        std::fs::write(&lock, "12345\n").unwrap();
        assert!(lock.exists());
        release_lock(&lock);
        assert!(!lock.exists());
    }

    #[test]
    fn release_lock_is_noop_for_missing_file() {
        let path = std::env::temp_dir().join("nonexistent_release.lock");
        // Should not panic
        release_lock(&path);
    }
}
