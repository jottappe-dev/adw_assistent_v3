// ADW Assistent v3 - Rust/Tauri Backend
// WhatsApp media downloader with WebView integration

use chrono::{Local, NaiveDate};
use raw_window_handle::HasWindowHandle;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    AppHandle, Emitter, Listener, Manager, WebviewUrl, WebviewWindowBuilder,
};

// ---------------------------------------------------------------------------
// Windows FFI helpers
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod win32 {
    use std::ffi::c_void;

    #[link(name = "user32")]
    extern "system" {
        pub fn SetWindowLongPtrW(
            hwnd: *mut c_void,
            index: i32,
            value: isize,
        ) -> isize;
        pub fn GetWindowLongPtrW(hwnd: *mut c_void, index: i32) -> isize;
        pub fn SetWindowPos(
            hwnd: *mut c_void,
            hwndInsertAfter: *mut c_void,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
        pub fn SetParent(
            hWndChild: *mut c_void,
            hWndNewParent: *mut c_void,
        ) -> *mut c_void;
    }

    pub const GWL_STYLE: i32 = -16;
    pub const GWL_EXSTYLE: i32 = -20;
    pub const WS_CHILD: isize = 0x40000000;
    pub const WS_POPUP: isize = 0x80000000;
    pub const WS_EX_TOOLWINDOW: isize = 0x00000080;
    pub const WS_EX_APPWINDOW: isize = 0x00040000;
    pub const SWP_NOMOVE: u32 = 0x0002;
    pub const SWP_NOSIZE: u32 = 0x0001;
    pub const SWP_NOACTIVATE: u32 = 0x0010;
    pub const SWP_FRAMECHANGED: u32 = 0x0020;
}

/// Retrieve the raw HWND pointer from a Tauri window.
#[cfg(windows)]
fn get_hwnd(window: &tauri::WebviewWindow) -> Result<*mut std::ffi::c_void, String> {
    let handle = window
        .window_handle()
        .map_err(|e| format!("Failed to get window handle: {}", e))?;
    match handle.as_raw() {
        raw_window_handle::RawWindowHandle::Win32(h) => Ok(h.hwnd.get() as *mut std::ffi::c_void),
        _ => Err("Not a Win32 window".into()),
    }
}

/// Make `child` a true child window of `parent` using SetParent.
/// The child is clipped to the parent, moves with it, and is removed from the taskbar.
#[cfg(windows)]
fn make_window_child(
    child: &tauri::WebviewWindow,
    parent: &tauri::WebviewWindow,
) -> Result<(), String> {
    use win32::*;

    let child_hwnd = get_hwnd(child)?;
    let parent_hwnd = get_hwnd(parent)?;

    unsafe {
        // Reparent: make it a true child of the main window (clipped, moves together)
        SetParent(child_hwnd, parent_hwnd);

        // Change style from popup to child window
        let style = GetWindowLongPtrW(child_hwnd, GWL_STYLE);
        let new_style = (style & !WS_POPUP) | WS_CHILD;
        SetWindowLongPtrW(child_hwnd, GWL_STYLE, new_style);

        // Remove from taskbar and Alt+Tab
        let ex_style = GetWindowLongPtrW(child_hwnd, GWL_EXSTYLE);
        let new_ex_style = (ex_style & !WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW;
        SetWindowLongPtrW(child_hwnd, GWL_EXSTYLE, new_ex_style);

        // Apply style changes
        SetWindowPos(
            child_hwnd,
            std::ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
    }
    Ok(())
}

#[cfg(not(windows))]
fn make_window_child(
    _child: &tauri::WebviewWindow,
    _parent: &tauri::WebviewWindow,
) -> Result<(), String> {
    Ok(())
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TB_HEIGHT: i32 = 48;
const TABS_HEIGHT: i32 = 48;

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupCfg {
    pub id: String,
    pub name: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
    pub output_dir: String,
    #[serde(default)]
    pub skip_days: Vec<u32>,
    #[serde(default = "default_media_types")]
    pub media_types: Vec<String>,
    #[serde(default = "d3")]
    pub max_retries: u32,
    #[serde(default = "default_delays")]
    pub retry_delays: Vec<u64>,
    #[serde(default)]
    pub groups: Vec<GroupCfg>,
    #[serde(default = "default_true")]
    pub agent_enabled: bool,
    #[serde(default)]
    pub initial_date: Option<String>,
    #[serde(default = "d8")]
    pub schedule_hour: u32,
    #[serde(default)]
    pub schedule_min: u32,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub enabled_groups: Vec<String>,
    #[serde(default = "default_true")]
    pub task_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GroupProgress {
    pub last_scan: String,
    pub downloaded_dates: Vec<String>,
    pub total_messages: u64,
    pub total_images: u64,
    pub total_videos: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProgressData {
    pub groups: std::collections::HashMap<String, GroupProgress>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadState {
    pub running: bool,
    pub saved: u32,
    pub failed: u32,
    pub days_done: u32,
    pub total_days: u32,
    pub found: u32,
    pub current_group: String,
    pub current_day: String,
    pub phase: String,
}

impl Default for DownloadState {
    fn default() -> Self {
        Self {
            running: false,
            saved: 0,
            failed: 0,
            days_done: 0,
            total_days: 0,
            found: 0,
            current_group: String::new(),
            current_day: String::new(),
            phase: String::new(),
        }
    }
}

pub struct AppState {
    pub config: Mutex<AppConfig>,
    pub download_state: Mutex<DownloadState>,
    pub abort_flag: Mutex<bool>,
    pub agent_proc: Mutex<Option<std::process::Child>>,
    pub wpp_child_ready: Mutex<bool>,
}

// ---------------------------------------------------------------------------
// Default helpers
// ---------------------------------------------------------------------------

fn default_media_types() -> Vec<String> {
    vec!["image".into(), "video".into()]
}

fn d3() -> u32 {
    3
}

fn d8() -> u32 {
    8
}

fn default_delays() -> Vec<u64> {
    vec![3000, 10000, 30000]
}

fn default_true() -> bool {
    true
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

fn data_dir() -> PathBuf {
    let base = dirs_next().unwrap_or_else(|| PathBuf::from("."));
    base.join("adw_assistent")
}

fn dirs_next() -> Option<PathBuf> {
    // On Windows, use %APPDATA%
    #[cfg(windows)]
    {
        std::env::var("APPDATA")
            .ok()
            .map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME")
            .ok()
            .map(|h| PathBuf::from(h).join(".config"))
    }
}

fn config_path() -> PathBuf {
    data_dir().join("config.json")
}

fn state_path() -> PathBuf {
    data_dir().join("state.json")
}

fn pending_path() -> PathBuf {
    data_dir().join("pending.json")
}

fn groups_cache_path() -> PathBuf {
    data_dir().join("groups-cache.json")
}

fn progress_path() -> PathBuf {
    data_dir().join("progress.json")
}

fn load_progress() -> ProgressData {
    read_json(&progress_path(), ProgressData::default())
}

fn save_progress(data: &ProgressData) -> Result<(), String> {
    write_json_with_backup(&progress_path(), data, &backup_dir())
}

fn logs_dir() -> PathBuf {
    let d = data_dir().join("logs");
    d
}

fn backup_dir() -> PathBuf {
    data_dir().join("backups")
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path, fallback: T) -> T {
    match std::fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or(fallback),
        Err(_) => fallback,
    }
}

fn write_json<T: Serialize>(path: &Path, data: &T) -> Result<(), String> {
    let content = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, &content).map_err(|e| e.to_string())?;
    Ok(())
}

fn write_json_with_backup<T: Serialize>(
    path: &Path,
    data: &T,
    backup_dir: &Path,
) -> Result<(), String> {
    // Backup old file if it exists
    if path.exists() {
        std::fs::create_dir_all(backup_dir).map_err(|e| e.to_string())?;
        let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
        let fname = path
            .file_name()
            .map(|n| {
                let mut s = n.to_string_lossy().to_string();
                s.push_str(&format!(".{}", timestamp));
                s
            })
            .unwrap_or_else(|| format!("backup_{}", timestamp));
        let backup_path = backup_dir.join(&fname);
        let _ = std::fs::copy(path, &backup_path); // best-effort
    }
    write_json(path, data)
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

fn date_str(d: &NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

fn add_days(s: &str, n: i64) -> Option<String> {
    let d = NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()?;
    let nd = if n >= 0 {
        d.checked_add_signed(chrono::Duration::days(n))?
    } else {
        d.checked_sub_signed(chrono::Duration::days(n.abs()))?
    };
    Some(date_str(&nd))
}

fn yesterday() -> String {
    let d = Local::now().date_naive();
    let y = d
        .checked_sub_signed(chrono::Duration::days(1))
        .unwrap_or(d);
    date_str(&y)
}

fn label_of(s: &str) -> String {
    // Get last segment after last /
    s.rsplit('/').next().unwrap_or(s).to_string()
}

fn sanitize(name: &str) -> String {
    let invalid = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    name.chars()
        .map(|c| if invalid.contains(&c) { '_' } else { c })
        .collect::<String>()
        .trim_end_matches('.')
        .to_string()
}

fn sanitize_for_path(s: &str) -> String {
    let result: String = s.chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\x00'..='\x1f' => '_',
            _ => c,
        })
        .collect::<String>()
        .trim_end_matches('.')
        .trim()
        .to_string();
    let result = if result.is_empty() { String::from("grupo") } else { result };
    // DOS reserved names
    let upper = result.to_uppercase();
    let base = upper.split('.').next().unwrap_or(&upper);
    let reserved = ["CON","PRN","AUX","NUL","COM1","COM2","COM3","COM4","COM5","COM6","COM7","COM8","COM9","LPT1","LPT2","LPT3","LPT4","LPT5","LPT6","LPT7","LPT8","LPT9"];
    if reserved.contains(&base) {
        format!("_{}", result)
    } else {
        result
    }
}

// ---------------------------------------------------------------------------
// Node.js agent helper
// ---------------------------------------------------------------------------

fn hide_cmd(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
    }
    #[cfg(not(windows))]
    { let _ = cmd; }
}

fn run_schtasks(args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = std::process::Command::new("schtasks");
    cmd.args(args);
    hide_cmd(&mut cmd);
    cmd.output().map_err(|e| format!("schtasks error: {}", e))
}

fn resolve_node() -> Option<PathBuf> {
    // 1. Try bare "node" in PATH
    let mut cmd = std::process::Command::new("node");
    cmd.arg("--version");
    hide_cmd(&mut cmd);
    if let Ok(output) = cmd.output() {
        if output.status.success() {
            return Some(PathBuf::from("node"));
        }
    }

    // 2. Try Program Files
    #[cfg(windows)]
    {
        if let Ok(pf) = std::env::var("ProgramFiles") {
            let candidate = PathBuf::from(pf).join("nodejs/node.exe");
            if candidate.exists() {
                return Some(candidate);
            }
        }
        if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
            let candidate = PathBuf::from(pf86).join("nodejs/node.exe");
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    // 3. Try fnm (Fast Node Manager) multishells
    #[cfg(windows)]
    {
        if let Ok(localapp) = std::env::var("LOCALAPPDATA") {
            let fnm_dir = PathBuf::from(localapp).join("fnm_multishells");
            if fnm_dir.exists() {
                if let Ok(entries) = std::fs::read_dir(&fnm_dir) {
                    for entry in entries.flatten() {
                        let candidate = entry.path().join("node.exe");
                        if candidate.exists() {
                            return Some(candidate);
                        }
                    }
                }
            }
        }
    }

    None
}

fn find_agent_js(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    // 1. Resource directory (bundled with app)
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("agent.js"));
        // 2. Parent of resource dir (dev build: project root)
        if let Some(parent) = res.parent() {
            candidates.push(parent.join("agent.js"));
        }
    }

    // 3. Executable directory
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("agent.js"));
            // 4. Parent of exe dir (release build: target/release -> project root)
            if let Some(parent) = dir.parent() {
                candidates.push(parent.join("agent.js"));
                if let Some(grandparent) = parent.parent() {
                    candidates.push(grandparent.join("agent.js"));
                }
            }
        }
    }

    // 5. Current working directory
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("agent.js"));
    }

    // 6. CARGO_MANIFEST_DIR / .. (dev build)
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        let manifest_dir = PathBuf::from(&manifest);
        candidates.push(manifest_dir.join("agent.js"));
        if let Some(parent) = manifest_dir.parent() {
            candidates.push(parent.join("agent.js"));
        }
    }

    for p in &candidates {
        if p.exists() {
            return Ok(p.clone());
        }
    }

    Err(format!(
        "agent.js not found. Searched:\n{}",
        candidates.iter().map(|p| format!("  {}", p.display())).collect::<Vec<_>>().join("\n")
    ))
}

// ---------------------------------------------------------------------------
// Console hiding (Windows)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Directory recursive copy
// ---------------------------------------------------------------------------

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.exists() {
        return Err(format!("Source does not exist: {}", src.display()));
    }
    if !src.is_dir() {
        return Err(format!("Source is not a directory: {}", src.display()));
    }
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;

    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let src_path = entry.path();
        let dst_path = dst.join(&name);

        if ft.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else if ft.is_file() {
            if let Err(e) = std::fs::copy(&src_path, &dst_path) {
                // Skip files that are locked / in use — log but continue
                eprintln!(
                    "Warning: could not copy {}: {}",
                    src_path.display(),
                    e
                );
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Profile copy (skip heavy / lock-prone cache dirs)
// ---------------------------------------------------------------------------

const SKIP_DIRS: &[&str] = &[
    "Cache",
    "Code Cache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "GPUCache",
    "GrShaderCache",
    "ShaderCache",
    "Service Worker",
    "GCM Store",
    "shared_proto_db",
    "VideoDecodeStats",
    "blob_storage",
    "Crashpad",
    "component_crx_cache",
];

fn copy_profile_to_temp(app: &AppHandle) -> Result<PathBuf, String> {
    // WebView2 stores user data in LocalAppData (not Roaming)
    let local_app_data = app.path().app_local_data_dir()
        .map_err(|e| format!("Failed to resolve local app data dir: {}", e))?;
    let eb_dir = local_app_data.join("EBWebView").join("Default");

    // Fallback: try Roaming if Local doesn't exist (older Tauri versions)
    let eb_dir = if eb_dir.exists() {
        eb_dir
    } else {
        let roaming = app.path().app_data_dir()
            .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
        let roaming_eb = roaming.join("EBWebView").join("Default");
        if roaming_eb.exists() {
            roaming_eb
        } else {
            return Err(format!(
                "EBWebView/Default not found.\nTried:\n  {}\n  {}\nLog in to WhatsApp first.",
                eb_dir.display(), roaming_eb.display()
            ));
        }
    };

    let uid = uuid::Uuid::new_v4();
    let temp_root = std::env::temp_dir().join(format!("adw_profile_{}", uid));
    let dst = temp_root.join("Default");

    // Walk EBWebView/Default manually, skipping known cache dirs
    fn walk_copy(src: &Path, dst: &Path, rel: &Path) -> Result<(), String> {
        // Check if any component of rel matches a skip dir
        for comp in rel.components() {
            if let std::path::Component::Normal(c) = comp {
                if SKIP_DIRS.contains(&c.to_string_lossy().as_ref()) {
                    return Ok(()); // skip entire subtree
                }
            }
        }

        if src.is_dir() {
            std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
            for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let name = entry.file_name();
                let next_src = entry.path();
                let next_dst = dst.join(&name);
                let next_rel = rel.join(&name);
                walk_copy(&next_src, &next_dst, &next_rel)?;
            }
        } else if src.is_file() {
            if let Err(e) = std::fs::copy(src, dst) {
                eprintln!("Warning: could not copy {}: {}", src.display(), e);
            }
        }
        Ok(())
    }

    walk_copy(&eb_dir, &dst, Path::new(""))?;

    // Also copy Cookies and Local Storage etc. from parent EBWebView if needed
    // The agent expects a "Default" subdir inside the profile path
    Ok(temp_root)
}

// ---------------------------------------------------------------------------
// WhatsApp WebView management
// ---------------------------------------------------------------------------

fn close_wpp_webview(app: &AppHandle) -> Result<(), String> {
    if let Some(wpp) = app.get_webview_window("whatsapp") {
        // Hide first, then close
        let _ = wpp.hide();
        wpp.close().map_err(|e| format!("Failed to close WhatsApp WebView: {}", e))?;
        // Small delay to let Tauri fully remove the window from its registry
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    // Reset ready flag
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut ready) = state.wpp_child_ready.lock() {
            *ready = false;
        }
    }
    Ok(())
}

fn ensure_wpp_webview(app: &AppHandle) -> Result<(), String> {
    // If webview already exists, just return
    if app.get_webview_window("whatsapp").is_some() {
        return Ok(());
    }
    create_wpp_webview_inner(app)
}

fn create_wpp_webview_inner(app: &AppHandle) -> Result<(), String> {
    let main_window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    let wpp = WebviewWindowBuilder::new(app, "whatsapp", WebviewUrl::External(
        "https://web.whatsapp.com".parse().map_err(|e| format!("Invalid URL: {}", e))?,
    ))
    .decorations(false)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false)
    .initialization_script(include_str!("../../wpp_init.js"))
    .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36")
    .build()
    .map_err(|e| format!("Failed to create WhatsApp WebView: {}", e))?;

    // Make the whatsapp window a child of the main window (integrated, no overlap)
    make_window_child(&wpp, &main_window)?;

    // Mark that it's ready
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut ready) = state.wpp_child_ready.lock() {
            *ready = true;
        }
    }

    Ok(())
}

fn sync_wpp_position(app: &AppHandle) -> Result<(), String> {
    let main_window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;
    let wpp = app
        .get_webview_window("whatsapp")
        .ok_or_else(|| "WhatsApp WebView not found".to_string())?;

    let size = main_window
        .outer_size()
        .map_err(|e| format!("Failed to get main window size: {}", e))?;
    let scale = main_window
        .scale_factor()
        .map_err(|e| format!("Failed to get scale factor: {}", e))?;

    // Child window coordinates are relative to parent's client area
    // For frameless windows, client area == window rect
    let offset = ((TB_HEIGHT + TABS_HEIGHT) as f64 * scale) as i32;
    let wpp_x = 0;
    let wpp_y = offset;
    let wpp_w = size.width as i32;
    let wpp_h = (size.height as i32) - offset;

    #[cfg(windows)]
    {
        use win32::*;
        if let Ok(hwnd) = get_hwnd(&wpp) {
            unsafe {
                SetWindowPos(
                    hwnd,
                    std::ptr::null_mut(),
                    wpp_x,
                    wpp_y,
                    wpp_w.max(1),
                    wpp_h.max(1),
                    SWP_NOACTIVATE,
                );
            }
        }
    }
    // On non-Windows, use Tauri's set_position/set_size
    #[cfg(not(windows))]
    {
        let _ = wpp.set_position(tauri::PhysicalPosition::new(wpp_x, wpp_y));
        let _ = wpp.set_size(tauri::PhysicalSize::new(
            wpp_w.max(1) as u32,
            wpp_h.max(1) as u32,
        ));
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri Commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn ping() -> String {
    "pong".into()
}

#[tauri::command]
fn load_config() -> Result<serde_json::Value, String> {
    let path = config_path();
    let cfg: AppConfig = read_json(&path, AppConfig {
        output_dir: String::new(),
        skip_days: Vec::new(),
        media_types: default_media_types(),
        max_retries: d3(),
        retry_delays: default_delays(),
        groups: Vec::new(),
        agent_enabled: true,
        initial_date: None,
        schedule_hour: d8(),
        schedule_min: 0,
        mode: String::new(),
        enabled_groups: Vec::new(),
        task_enabled: true,
    });
    serde_json::to_value(cfg).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_config(
    app: AppHandle,
    config: serde_json::Value,
) -> Result<bool, String> {
    let cfg: AppConfig =
        serde_json::from_value(config).map_err(|e| format!("Invalid config: {}", e))?;
    let path = config_path();
    write_json_with_backup(&path, &cfg, &backup_dir())?;

    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut c) = state.config.lock() {
            *c = cfg;
        }
    }
    Ok(true)
}

#[tauri::command]
fn load_state() -> Result<serde_json::Value, String> {
    let path = state_path();
    if path.exists() {
        let content =
            std::fs::read_to_string(&path).map_err(|e| format!("Failed to read state: {}", e))?;
        let val: serde_json::Value =
            serde_json::from_str(&content).map_err(|e| format!("Invalid state JSON: {}", e))?;
        Ok(val)
    } else {
        Ok(serde_json::json!({}))
    }
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let file = app.dialog().file().blocking_pick_folder();
    match file {
        Some(p) => Ok(Some(p.to_string())),
        None => Ok(None),
    }
}

#[tauri::command]
async fn fetch_groups(app: AppHandle) -> Result<serde_json::Value, String> {
    let wpp = app
        .get_webview_window("whatsapp")
        .ok_or_else(|| "WhatsApp WebView not found".to_string())?;

    let js_code = r#"
(async () => {
    try {
        let chats = [];
        let source = 'none';
        let debug = {};

        // ── Method 1: window.require('WAWebCollections') ────
        // WhatsApp Web exposes the webpack require function globally
        if (typeof window.require === 'function') {
            debug.hasRequire = true;
            try {
                const collections = window.require('WAWebCollections');
                if (collections) {
                    debug.hasWAWebCollections = true;
                    if (collections.Chat && typeof collections.Chat.getModelsArray === 'function') {
                        chats = collections.Chat.getModelsArray();
                        source = 'require(WAWebCollections).Chat';
                    }
                }
            } catch(e) {
                debug.requireError = e.message;
            }

            // Try alternative module names
            if (!chats.length) {
                const moduleNames = [
                    'WAWebCollections',
                    'WAWebChatCollection',
                    'WAChatCollection',
                    'ChatCollection'
                ];
                for (const modName of moduleNames) {
                    try {
                        const mod = window.require(modName);
                        if (mod && mod.Chat && typeof mod.Chat.getModelsArray === 'function') {
                            chats = mod.Chat.getModelsArray();
                            source = 'require(' + modName + ').Chat';
                            break;
                        }
                        if (mod && typeof mod.getModelsArray === 'function') {
                            chats = mod.getModelsArray();
                            source = 'require(' + modName + ').getModelsArray';
                            break;
                        }
                    } catch(e) {}
                }
            }
        } else {
            debug.hasRequire = false;
        }

        // ── Method 2: __adw_store (captured by init script) ──
        if (!chats.length && window.__adw_store && window.__adw_store.Chat) {
            try {
                if (typeof window.__adw_store.Chat.getModelsArray === 'function') {
                    chats = window.__adw_store.Chat.getModelsArray();
                    source = '__adw_store.Chat';
                    debug.hasAdwStore = true;
                }
            } catch(e) {}
        }

        // ── Method 3: window.Store (older versions) ──
        if (!chats.length && window.Store && window.Store.Chat) {
            debug.hasStore = true;
            try {
                if (typeof window.Store.Chat.getModelsArray === 'function') {
                    chats = window.Store.Chat.getModelsArray();
                    source = 'Store.Chat';
                }
            } catch(e) {}
        }

        debug.source = source;
        debug.chatCount = chats.length;

        // Log structure of first chat to help debug
        if (chats.length > 0) {
            try {
                const first = chats[0];
                debug.firstChatKeys = Object.keys(first).slice(0, 20);
                debug.firstChatHas = {
                    isGroup: first.isGroup,
                    hasGroupMetadata: !!first.groupMetadata,
                    hasId: !!first.id,
                    hasName: !!first.name,
                    hasFormattedTitle: !!first.formattedTitle
                };
            } catch(e) {}
        }

        // whatsapp-web.js uses `chat.groupMetadata` to detect groups, not `chat.isGroup`
        const groups = chats.filter(c => {
            try {
                var isGrp = false;
                // Primary method: check groupMetadata (used by whatsapp-web.js)
                if (c.groupMetadata) isGrp = true;
                // Also check isGroup property if present
                if (c.isGroup === true) isGrp = true;
                // Exclude broadcast lists and communities if distinguishable
                if (c.isAnnounceGroup || c.announce || c.isBroadcast) isGrp = false;
                return isGrp;
            } catch(e) { return false; }
        });

        debug.groupCount = groups.length;

        window.__TAURI__.event.emit('fetch-groups-result', {
            source,
            groups: groups.map(g => {
                let id = '';
                try { id = (g.id && g.id._serialized) ? g.id._serialized : String(g.id || ''); } catch(e) { id = ''; }
                let name = '';
                try { name = g.name || g.formattedTitle || (g.groupMetadata && g.groupMetadata.subject) || 'Unnamed'; } catch(e) { name = 'Unnamed'; }
                return { id, name };
            }),
            debug
        });
    } catch(e) {
        window.__TAURI__.event.emit('fetch-groups-result', {
            source: 'error',
            error: e.message,
            groups: [],
            debug: { errorName: e.name, errorStack: (e.stack || '').split('\n').slice(0,3).join('\n') }
        });
    }
})();
"#;

    // Emit progress
    let _ = app.emit("fetch-groups-progress", serde_json::json!({ "phase": "querying", "progress": 50 }));

    // Set up one-shot channel to receive the JS result via event
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let handler = app.once("fetch-groups-result", move |event| {
        let _ = tx.send(event.payload().to_string());
    });

    wpp.eval(js_code).map_err(|e| format!("Failed to evaluate JS: {}", e))?;

    // Wait for result with timeout
    let payload = match tokio::time::timeout(
        std::time::Duration::from_secs(15),
        rx,
    ).await {
        Ok(Ok(payload)) => payload,
        Ok(Err(_)) => {
            app.unlisten(handler);
            return Err("Channel closed without result".to_string());
        }
        Err(_) => {
            app.unlisten(handler);
            return Err("Timeout waiting for WhatsApp response".to_string());
        }
    };

    let parsed: serde_json::Value =
        serde_json::from_str(&payload).map_err(|e| format!("Failed to parse JS result: {}", e))?;

    let _ = app.emit("fetch-groups-progress", serde_json::json!({ "phase": "done", "progress": 100 }));

    // Extract debug info for diagnostics
    let debug_info = parsed.get("debug").cloned();
    let extraction_source = parsed
        .get("source")
        .and_then(|s| s.as_str())
        .unwrap_or("unknown");

    // Cache the groups
    if let Some(groups) = parsed.get("groups") {
        let cache_path = groups_cache_path();
        let _ = write_json(&cache_path, groups);
    }

    // Count total
    let total = parsed
        .get("groups")
        .and_then(|g| g.as_array())
        .map(|a| a.len())
        .unwrap_or(0);

    let response = serde_json::json!({
        "groups": parsed.get("groups"),
        "total": total,
        "source": extraction_source,
        "debug": debug_info,
    });

    // Also emit wpp-groups event for the frontend listener
    let _ = app.emit("wpp-groups", response.clone());

    Ok(response)
}

#[tauri::command]
fn load_progress_data() -> Result<serde_json::Value, String> {
    let data = load_progress();
    serde_json::to_value(data).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_progress_data(data: serde_json::Value) -> Result<bool, String> {
    let progress: ProgressData = serde_json::from_value(data).map_err(|e| e.to_string())?;
    save_progress(&progress)?;
    Ok(true)
}

#[tauri::command]
fn load_cached_groups() -> Result<serde_json::Value, String> {
    let path = groups_cache_path();
    if path.exists() {
        let content =
            std::fs::read_to_string(&path).map_err(|e| format!("Failed to read cache: {}", e))?;
        let val: serde_json::Value =
            serde_json::from_str(&content).map_err(|e| format!("Invalid cache JSON: {}", e))?;
        Ok(val)
    } else {
        Ok(serde_json::json!([]))
    }
}

#[tauri::command]
async fn scan_groups(app: AppHandle, date: String, group_ids: Vec<String>) -> Result<serde_json::Value, String> {
    let wpp = app.get_webview_window("whatsapp")
        .ok_or_else(|| "WhatsApp WebView not found".to_string())?;

    let ids_json = serde_json::to_string(&group_ids).unwrap_or_else(|_| "[]".into());
    let js_code = format!(r#"
(async () => {{
    try {{
        const targetDate = "{}";
        const enabledIds = {};
        const results = [];
        const Chat = window.require('WAWebCollections').Chat;
        const Msg = window.require('WAWebCollections').Msg;

        for (const chatId of enabledIds) {{
            try {{
                const chat = Chat.get(chatId);
                if (!chat) {{ results.push({{ id: chatId, error: 'not found' }}); continue; }}

                let totalMsg = 0, images = 0, videos = 0, docs = 0;
                // Check cached messages (msgs is a collection on the chat model)
                const msgs = chat.msgs ? chat.msgs.getModelsArray ? chat.msgs.getModelsArray() : [] : [];

                for (const m of msgs) {{
                    try {{
                        const t = m.t || 0;
                        const msgDate = new Date(t * 1000).toISOString().slice(0,10);
                        if (msgDate !== targetDate) continue;
                        totalMsg++;
                        const type = m.type || '';
                        const mimetype = (m.mimetype || '').toLowerCase();
                        if (type === 'image' || mimetype.startsWith('image/')) images++;
                        else if (type === 'video' || mimetype.startsWith('video/')) videos++;
                        else if (m.mediaObject || m.deprecatedMms3Url) docs++;
                    }} catch(e) {{}}
                }}

                results.push({{
                    id: chatId,
                    name: (chat.name || chat.formattedTitle || 'Unnamed'),
                    total: totalMsg,
                    images: images,
                    videos: videos,
                    docs: docs,
                    isGroup: !!chat.groupMetadata
                }});
            }} catch(e) {{
                results.push({{ id: chatId, error: e.message }});
            }}
        }}

        const totalAll = results.reduce((s,r) => s + (r.total||0), 0);
        const imgsAll = results.reduce((s,r) => s + (r.images||0), 0);
        const vidsAll = results.reduce((s,r) => s + (r.videos||0), 0);

        window.__TAURI__.event.emit('scan-groups-result', {{
            date: targetDate,
            groups: results,
            totals: {{ total: totalAll, images: imgsAll, videos: vidsAll }}
        }});
    }} catch(e) {{
        window.__TAURI__.event.emit('scan-groups-result', {{ error: e.message }});
    }}
}})();
"#, date, ids_json);

    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let handler = app.once("scan-groups-result", move |event| {
        let _ = tx.send(event.payload().to_string());
    });

    wpp.eval(&js_code).map_err(|e| format!("Failed to evaluate scan JS: {}", e))?;

    let payload = match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
        Ok(Ok(p)) => p,
        Ok(Err(_)) => { app.unlisten(handler); return Err("Channel closed".into()); }
        Err(_) => { app.unlisten(handler); return Err("Timeout".into()); }
    };

    serde_json::from_str(&payload).map_err(|e| format!("Invalid result: {}", e))
}

#[tauri::command]
fn show_wpp_webview(app: AppHandle) -> Result<(), String> {
    sync_wpp_position(&app)?;
    let wpp = app
        .get_webview_window("whatsapp")
        .ok_or_else(|| "WhatsApp WebView not found".to_string())?;
    wpp.show().map_err(|e| format!("Failed to show WebView: {}", e))?;
    Ok(())
}

#[tauri::command]
fn hide_wpp_webview(app: AppHandle) -> Result<(), String> {
    let wpp = app
        .get_webview_window("whatsapp")
        .ok_or_else(|| "WhatsApp WebView not found".to_string())?;
    wpp.hide().map_err(|e| format!("Failed to hide WebView: {}", e))?;
    Ok(())
}

#[tauri::command]
fn sync_wpp_window(app: AppHandle) -> Result<(), String> {
    sync_wpp_position(&app)
}

#[tauri::command]
fn reload_wpp_webview(app: AppHandle) -> Result<(), String> {
    // Close existing WebView (if any) and wait for cleanup
    close_wpp_webview(&app)?;
    // Recreate from scratch (bypasses the "already exists" check)
    create_wpp_webview_inner(&app)?;
    Ok(())
}

#[tauri::command]
fn win_minimize(app: AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;
    win.minimize().map_err(|e| format!("Failed to minimize: {}", e))
}

#[tauri::command]
fn win_maximize(app: AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;
    if win.is_maximizable().unwrap_or(false) && win.is_maximized().unwrap_or(false) {
        win.unmaximize().map_err(|e| format!("Failed to unmaximize: {}", e))
    } else {
        win.maximize().map_err(|e| format!("Failed to maximize: {}", e))
    }
}

#[tauri::command]
fn win_close(app: AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;
    win.close().map_err(|e| format!("Failed to close: {}", e))
}

#[tauri::command]
async fn run_now(
    app: AppHandle,
    mode: String,
    date_start: Option<String>,
    date_end: Option<String>,
) -> Result<(), String> {
    // Check if already running
    let is_running = {
        let state = app
            .try_state::<AppState>()
            .ok_or_else(|| "AppState not initialized".to_string())?;
        let ds = state
            .download_state
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        ds.running
    };

    if is_running {
        return Err("A download is already in progress".into());
    }

    // Reset abort flag and download state
    {
        let state = app
            .try_state::<AppState>()
            .ok_or_else(|| "AppState not initialized".to_string())?;
        if let Ok(mut abort) = state.abort_flag.lock() {
            *abort = false;
        };
        if let Ok(mut ds) = state.download_state.lock() {
            ds.running = true;
            ds.saved = 0;
            ds.failed = 0;
            ds.days_done = 0;
            ds.total_days = 0;
            ds.found = 0;
            ds.current_group = String::new();
            ds.current_day = String::new();
            ds.phase = "starting".into();
        };
    }

    // Emit state change
    let _ = app.emit("run-progress", serde_json::json!({
        "phase": "starting",
        "message": "Copying profile..."
    }));

    // Copy profile
    let temp_profile = copy_profile_to_temp(&app)?;

    // Resolve node
    let node_path = resolve_node()
        .ok_or_else(|| "Node.js not found. Please install Node.js.".to_string())?;

    // Resolve agent script
    let script_path = match find_agent_js(&app) {
        Ok(p) => p,
        Err(e) => {
            let _ = app.emit("run-progress", serde_json::json!({
                "phase": "error",
                "message": e
            }));
            if let Some(state) = app.try_state::<AppState>() {
                if let Ok(mut ds) = state.download_state.lock() {
                    ds.running = false;
                }
            }
            return Err(e);
        }
    };

    let _ = app.emit("run-progress", serde_json::json!({
        "phase": "launching",
        "message": "Launching agent..."
    }));

    // Build command args
    let data_dir_str = data_dir().to_string_lossy().to_string();
    let profile_str = temp_profile.to_string_lossy().to_string();

    let mut cmd = std::process::Command::new(&node_path);
    cmd.arg(&script_path)
        .arg("--data-dir")
        .arg(&data_dir_str)
        .arg("--profile")
        .arg(&profile_str);

    if mode == "range" {
        if let Some(ref start) = date_start {
            cmd.arg("--from").arg(start);
        }
        if let Some(ref end) = date_end {
            cmd.arg("--to").arg(end);
        }
    }

    // Hide console window on Windows
    hide_cmd(&mut cmd);

    // Stdout / stderr pipes
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn agent: {}", e))?;

    // Take stdout/stderr pipes before storing child in state
    let stdout = child.stdout.take().ok_or_else(|| "No stdout".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "No stderr".to_string())?;

    // Store the child handle for abort
    {
        let state = app
            .try_state::<AppState>()
            .ok_or_else(|| "AppState not initialized".to_string())?;
        if let Ok(mut proc) = state.agent_proc.lock() {
            *proc = Some(child);
        };
    }

    // Reader tasks for stdout/stderr
    let app_clone = app.clone();
    let reader_stdout = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            if let Ok(line) = line {
                let _ = app_clone.emit("run-progress", serde_json::json!({
                    "phase": "progress",
                    "message": line,
                }));
                // Parse structured JSON lines from agent
                if let Ok(data) = serde_json::from_str::<serde_json::Value>(&line) {
                    if let Some(state) = app_clone.try_state::<AppState>() {
                        if let Ok(mut ds) = state.download_state.lock() {
                            if let Some(saved) = data.get("saved").and_then(|v| v.as_u64()) {
                                ds.saved = saved as u32;
                            }
                            if let Some(failed) = data.get("failed").and_then(|v| v.as_u64()) {
                                ds.failed = failed as u32;
                            }
                            if let Some(done) = data.get("days_done").and_then(|v| v.as_u64()) {
                                ds.days_done = done as u32;
                            }
                            if let Some(total) = data.get("total_days").and_then(|v| v.as_u64()) {
                                ds.total_days = total as u32;
                            }
                            if let Some(found) = data.get("found").and_then(|v| v.as_u64()) {
                                ds.found = found as u32;
                            }
                            if let Some(group) = data.get("current_group").and_then(|v| v.as_str()) {
                                ds.current_group = group.to_string();
                            }
                            if let Some(day) = data.get("current_day").and_then(|v| v.as_str()) {
                                ds.current_day = day.to_string();
                            }
                            if let Some(phase) = data.get("phase").and_then(|v| v.as_str()) {
                                ds.phase = phase.to_string();
                            }
                        }
                    }
                }
            }
        }
    });

    let app_clone2 = app.clone();
    let reader_stderr = std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(line) = line {
                let _ = app_clone2.emit("run-progress", serde_json::json!({
                    "phase": "error",
                    "message": line,
                }));
            }
        }
    });

    // Monitor task: poll for process exit (std::process::Child is not Clone,
    // so we store it in agent_proc and poll with try_wait)
    let app_clone3 = app.clone();
    let temp_profile_clone = temp_profile.clone();
    std::thread::spawn(move || {
        // Poll for child exit
        loop {
            std::thread::sleep(Duration::from_millis(200));
            let done = {
                if let Some(state) = app_clone3.try_state::<AppState>() {
                    if let Ok(mut proc) = state.agent_proc.lock() {
                        match proc.as_mut() {
                            Some(ref mut child) => match child.try_wait() {
                                Ok(Some(_)) => true,
                                Ok(None) => false,
                                Err(_) => true,
                            },
                            None => true, // already cleaned up by abort
                        }
                    } else {
                        false
                    }
                } else {
                    false
                }
            };
            if done {
                break;
            }
        }

        // Join reader threads
        let _ = reader_stdout.join();
        let _ = reader_stderr.join();

        // Update state
        if let Some(state) = app_clone3.try_state::<AppState>() {
            if let Ok(mut ds) = state.download_state.lock() {
                ds.running = false;
                ds.phase = "done".into();
            }
            if let Ok(mut proc) = state.agent_proc.lock() {
                *proc = None;
            }
        }

        // Clean up temp profile
        let _ = std::fs::remove_dir_all(&temp_profile_clone);

        let _ = app_clone3.emit(
            "run-now-done",
            serde_json::json!({
                "success": true,
            }),
        );
    });

    Ok(())
}

#[tauri::command]
fn abort_download(app: AppHandle) -> Result<(), String> {
    // Set abort flag
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut abort) = state.abort_flag.lock() {
            *abort = true;
        }
        // Kill agent process
        if let Ok(mut proc) = state.agent_proc.lock() {
            if let Some(ref mut child) = *proc {
                let _ = child.kill();
                let _ = child.wait();
            }
            *proc = None;
        }
        if let Ok(mut ds) = state.download_state.lock() {
            ds.running = false;
            ds.phase = "aborted".into();
        }
    }
    let _ = app.emit("run-progress", serde_json::json!({
        "phase": "aborted",
        "message": "Download aborted by user"
    }));
    Ok(())
}

fn setup_save_media_listener(app: &AppHandle) {
    let app_handle = app.clone();
    app.listen("save-media", move |event| {
        let payload = event.payload();
        let data: serde_json::Value = match serde_json::from_str(payload) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("save-media parse error: {}", e);
                return;
            }
        };
        let path = data.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let b64 = data.get("data").and_then(|v| v.as_str()).unwrap_or("");
        if path.is_empty() || b64.is_empty() {
            return;
        }
        // Skip if already exists
        if Path::new(path).exists() { return; }
        match base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64) {
            Ok(bytes) => {
                if let Some(parent) = Path::new(path).parent() {
                    if let Err(e) = std::fs::create_dir_all(parent) {
                        let _ = app_handle.emit("run-progress", serde_json::json!({
                            "log": format!("ERR mkdir [{}]: {}", parent.display(), e),
                            "log_type": "err"
                        }));
                        return;
                    }
                }
                match std::fs::write(path, &bytes) {
                    Ok(_) => {} // silent — frontend only shows summary
                    Err(e) => {
                        let _ = app_handle.emit("run-progress", serde_json::json!({
                            "log": format!("ERR write [{}]: {}", path, e),
                            "log_type": "err"
                        }));
                    }
                }
            }
            Err(e) => {
                let _ = app_handle.emit("run-progress", serde_json::json!({
                    "log": "ERR base64: ".to_string() + &e.to_string(),
                    "log_type": "err"
                }));
            }
        }
    });

    // Chunked file reassembly for large media
    let app_handle2 = app.clone();
    let partial_files: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, (String, usize, Vec<Vec<u8>>)>>> =
        std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
    app.listen("save-media-chunk", move |event| {
        let payload = event.payload();
        let data: serde_json::Value = match serde_json::from_str(payload) {
            Ok(v) => v,
            Err(_) => return,
        };
        let file_id = data.get("fileId").and_then(|v| v.as_str()).unwrap_or("");
        let path = data.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let b64 = data.get("data").and_then(|v| v.as_str()).unwrap_or("");
        let index = data.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let total = data.get("total").and_then(|v| v.as_u64()).unwrap_or(0) as usize;

        let bytes = match base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64) {
            Ok(b) => b,
            Err(_) => return,
        };

        let mut pf = partial_files.lock().unwrap();
        let entry = pf.entry(file_id.to_string()).or_insert_with(|| {
            (path.to_string(), total, (0..total).map(|_| Vec::new()).collect())
        });

        if index < total { entry.2[index] = bytes; }
        let new_count = entry.2.iter().filter(|c| !c.is_empty()).count();

        // Check if all chunks received
        if new_count >= total {
            if Path::new(&entry.0).exists() { pf.remove(file_id); return; }
            if let Some(parent) = Path::new(&entry.0).parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let mut full: Vec<u8> = Vec::new();
            for chunk in &entry.2 { full.extend_from_slice(chunk); }
            let expected_size: usize = entry.2.iter().map(|c| c.len()).sum();
            if full.len() == expected_size && !full.is_empty() {
                if let Err(e) = std::fs::write(&entry.0, &full) {
                    let _ = app_handle2.emit("run-progress", serde_json::json!({
                        "log": "ERR write: ".to_string() + &e.to_string(),
                        "log_type": "err"
                    }));
                }
            }
            pf.remove(file_id);
        }
    });
}

#[tauri::command]
async fn download_all_media(
    app: AppHandle,
    date: String,
    group_ids: Vec<String>,
    output_dir: String,
    media_types: Vec<String>,
) -> Result<serde_json::Value, String> {
    let wpp = app.get_webview_window("whatsapp")
        .ok_or_else(|| "WhatsApp WebView not found".to_string())?;

    let ids_json = serde_json::to_string(&group_ids).unwrap_or_else(|_| "[]".into());
    let types_json = serde_json::to_string(&media_types).unwrap_or_else(|_| "[]".into());

    // Compute next sequence number from existing files matching date pattern
    let seq_start: u32 = {
        let mut max = 0u32;
        let date_prefix = format!("{}-", date);
        for gid in &group_ids {
            let gname = sanitize_for_path(gid);
            let dir = PathBuf::from(&output_dir).join(&gname).join(&date);
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let fname = entry.file_name().to_string_lossy().to_string();
                    if fname.starts_with(&date_prefix) {
                        if let Some(num_str) = fname.strip_prefix(&date_prefix).and_then(|s| s.split('.').next()) {
                            if let Ok(n) = num_str.parse::<u32>() { max = max.max(n); }
                        }
                    }
                }
            }
        }
        max
    };

    // Load the download JS from file, prepend parameter setup
    let download_script = include_str!("../../download_media.js");
    let js_code = format!(
        "window.__adw_date='{}';window.__adw_ids={};window.__adw_types={};window.__adw_out='{}';window.__adw_seq_start={};\n{}",
        date, ids_json, types_json, output_dir.replace('\\', "\\\\").replace('\'', "\\'"), seq_start, download_script
    );

    wpp.eval(&js_code).map_err(|e| format!("Failed to start download: {}", e))?;
    Ok(serde_json::json!({ "started": true }))
}

#[tauri::command]
fn schedule_task(app: AppHandle, hour: u32, minute: u32) -> Result<serde_json::Value, String> {
    #[cfg(windows)]
    {
        let script_path = find_agent_js(&app).unwrap_or_else(|_| PathBuf::from("agent.js"));
        let node_path = resolve_node()
            .ok_or_else(|| "Node.js not found".to_string())?;
        let data_dir_str = data_dir().to_string_lossy().to_string();

        // Build schtasks command
        let task_name = "WhatsAppAgentV3";
        let exe_str = node_path.to_string_lossy();
        let args_str = format!(
            "\"{}\" --data-dir \"{}\" --profile \"{}\"",
            script_path.to_string_lossy(),
            data_dir_str,
            data_dir().join("EBWebView").join("Default").to_string_lossy()
        );
        let tr = format!("\"{} {}\"", exe_str, args_str);
        let st = format!("{:02}:{:02}", hour, minute);
        let output = run_schtasks(&["/Create", "/SC", "DAILY", "/TN", task_name, "/TR", &tr, "/ST", &st, "/F"])
            .map_err(|e| format!("Failed to create scheduled task: {}", e))?;

        if output.status.success() {
            Ok(serde_json::json!({ "ok": true }))
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            if stderr.is_empty() {
                Ok(serde_json::json!({ "ok": false, "err": "Unknown error creating task" }))
            } else {
                Ok(serde_json::json!({ "ok": false, "err": stderr }))
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (app, hour, minute);
        Ok(serde_json::json!({ "ok": false, "err": "Scheduling is only supported on Windows" }))
    }
}

#[tauri::command]
fn check_task() -> Result<serde_json::Value, String> {
    #[cfg(windows)]
    {
        let output = run_schtasks(&["/Query", "/TN", "WhatsAppAgentV3", "/FO", "CSV", "/V"])
            .map_err(|e| format!("Failed to query task: {}", e))?;

        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let lines: Vec<&str> = stdout.trim().lines().collect();
            if lines.len() >= 2 {
                let cols: Vec<&str> = lines[1].split(',').collect();
                let status = cols.get(0).unwrap_or(&"").trim().trim_matches('"').to_string();
                let schedule = cols.get(5).unwrap_or(&"").trim().trim_matches('"').to_string();
                let next_run = cols.get(8).unwrap_or(&"").trim().trim_matches('"').to_string();
                Ok(serde_json::json!({
                    "exists": true,
                    "status": status,
                    "schedule": schedule,
                    "next_run": next_run,
                }))
            } else {
                Ok(serde_json::json!({ "exists": false }))
            }
        } else {
            Ok(serde_json::json!({ "exists": false }))
        }
    }
    #[cfg(not(windows))]
    {
        Ok(serde_json::json!({ "exists": false, "status": "unsupported" }))
    }
}

#[tauri::command]
fn delete_task() -> Result<bool, String> {
    #[cfg(windows)]
    {
        let output = run_schtasks(&["/Delete", "/TN", "WhatsAppAgentV3", "/F"])
            .map_err(|e| format!("Failed to delete task: {}", e))?;
        Ok(output.status.success())
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

#[tauri::command]
fn enable_task() -> Result<bool, String> {
    #[cfg(windows)]
    {
        let output = run_schtasks(&["/Change", "/TN", "WhatsAppAgentV3", "/ENABLE"])
            .map_err(|e| format!("Failed to enable task: {}", e))?;
        Ok(output.status.success())
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

#[tauri::command]
fn disable_task() -> Result<bool, String> {
    #[cfg(windows)]
    {
        let output = run_schtasks(&["/Change", "/TN", "WhatsAppAgentV3", "/DISABLE"])
            .map_err(|e| format!("Failed to disable task: {}", e))?;
        Ok(output.status.success())
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

#[tauri::command]
async fn wpp_logout(app: AppHandle) -> Result<bool, String> {
    let wpp = app
        .get_webview_window("whatsapp")
        .ok_or_else(|| "WhatsApp WebView not found".to_string())?;

    let js = r#"
(async () => {
    try {
        // Clear localStorage
        localStorage.clear();
        // Clear IndexedDB databases
        const dbs = await indexedDB.databases();
        for (const db of dbs) {
            if (db.name) indexedDB.deleteDatabase(db.name);
        }
        // Try WhatsApp logout API
        if (window.Store && window.Store.logout) {
            await window.Store.logout();
        } else if (window.WA && window.WA.logout) {
            await window.WA.logout();
        }
        // Navigate to WhatsApp Web (will show QR code)
        window.location.href = 'https://web.whatsapp.com';
        return true;
    } catch(e) {
        // Even if logout APIs fail, clear storage and reload
        localStorage.clear();
        window.location.href = 'https://web.whatsapp.com';
        return false;
    }
})();
"#;

    let _ = wpp.eval(js);
    Ok(true)
}

#[tauri::command]
fn wpp_clear_session(app: AppHandle) -> Result<bool, String> {
    let eb_dir = data_dir().join("EBWebView").join("Default");
    if eb_dir.exists() {
        // Hide the webview first
        if let Some(wpp) = app.get_webview_window("whatsapp") {
            let _ = wpp.hide();
        }
        // Small delay to ensure WebView releases file handles
        std::thread::sleep(Duration::from_millis(500));
        let _ = std::fs::remove_dir_all(&eb_dir);
    }
    Ok(true)
}

#[tauri::command]
fn factory_reset() -> Result<bool, String> {
    let files_to_delete = [
        config_path(),
        state_path(),
        pending_path(),
        groups_cache_path(),
    ];
    let dirs_to_delete = [data_dir().join("EBWebView"), logs_dir()];

    for f in &files_to_delete {
        if f.exists() {
            let _ = std::fs::remove_file(f);
        }
    }
    for d in &dirs_to_delete {
        if d.exists() {
            let _ = std::fs::remove_dir_all(d);
        }
    }
    Ok(true)
}

#[tauri::command]
fn apply_initial_date(
    date: String,
) -> Result<serde_json::Value, String> {
    // Parse and validate the date
    let parsed_date = NaiveDate::parse_from_str(&date, "%Y-%m-%d")
        .map_err(|e| format!("Invalid date format (use YYYY-MM-DD): {}", e))?;

    let formatted = date_str(&parsed_date);

    // Load current state, update each group's date
    let state_path = state_path();
    let mut state_val: serde_json::Value = if state_path.exists() {
        let content = std::fs::read_to_string(&state_path)
            .map_err(|e| format!("Failed to read state: {}", e))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    // Set initial_date in the state for all groups
    if let Some(obj) = state_val.as_object_mut() {
        obj.insert("initial_date".into(), serde_json::json!(formatted));
        // If there's a groups map, set each group's date
        if let Some(groups) = obj.get_mut("groups") {
            if let Some(groups_obj) = groups.as_object_mut() {
                for (_id, g_data) in groups_obj.iter_mut() {
                    if let Some(g_obj) = g_data.as_object_mut() {
                        g_obj.insert("last_date".into(), serde_json::json!(formatted));
                    }
                }
            }
        }
    }

    write_json(&state_path, &state_val)?;

    Ok(serde_json::json!({ "ok": true, "date": formatted }))
}

#[tauri::command]
fn reset_group_state(
    group_id: String,
) -> Result<(), String> {
    let state_path = state_path();
    let mut state_val: serde_json::Value = if state_path.exists() {
        let content = std::fs::read_to_string(&state_path)
            .map_err(|e| format!("Failed to read state: {}", e))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    // Try to get initial_date from state
    let initial_date = state_val
        .get("initial_date")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // Update the specific group's state
    if let Some(obj) = state_val.as_object_mut() {
        if let Some(groups) = obj.get_mut("groups") {
            if let Some(groups_obj) = groups.as_object_mut() {
                if let Some(g_data) = groups_obj.get_mut(&group_id) {
                    if let Some(g_obj) = g_data.as_object_mut() {
                        let date_val = match initial_date {
                            Some(ref d) => serde_json::json!(d),
                            None => serde_json::Value::Null,
                        };
                        g_obj.insert("last_date".into(), date_val);
                    }
                }
            }
        }
    }

    write_json(&state_path, &state_val)?;
    Ok(())
}

#[tauri::command]
#[allow(deprecated)]
fn open_logs(app: AppHandle) -> Result<(), String> {
    let log_dir = logs_dir();
    if !log_dir.exists() {
        std::fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
    }
    let path_str = log_dir.to_string_lossy().to_string();
    tauri_plugin_shell::ShellExt::shell(&app)
        .open(&path_str, None)
        .map_err(|e| format!("Failed to open logs directory: {}", e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Application entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // Create data directories
            let d = data_dir();
            std::fs::create_dir_all(&d).ok();
            std::fs::create_dir_all(&logs_dir()).ok();
            std::fs::create_dir_all(&backup_dir()).ok();

            // Load config
            let conf_path = config_path();
            let cfg: AppConfig = read_json(&conf_path, AppConfig {
                output_dir: String::new(),
                skip_days: Vec::new(),
                media_types: default_media_types(),
                max_retries: d3(),
                retry_delays: default_delays(),
                groups: Vec::new(),
                agent_enabled: true,
                initial_date: None,
                schedule_hour: d8(),
                schedule_min: 0,
                mode: String::new(),
                enabled_groups: Vec::new(),
                task_enabled: true,
            });

            // Initialize app state
            app.manage(AppState {
                config: Mutex::new(cfg),
                download_state: Mutex::new(DownloadState::default()),
                abort_flag: Mutex::new(false),
                agent_proc: Mutex::new(None),
                wpp_child_ready: Mutex::new(false),
            });

            // Setup media save listener (receives base64 data from WhatsApp WebView via events)
            setup_save_media_listener(app.handle());

            // Create WhatsApp WebView
            if let Err(e) = ensure_wpp_webview(app.handle()) {
                eprintln!("Warning: could not create WhatsApp WebView: {}", e);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
                    if window.label() == "main" {
                        if let Some(_wpp) = window.app_handle().get_webview_window("whatsapp") {
                            let _ = sync_wpp_position(window.app_handle());
                            let _ = window.app_handle().emit("whatsapp-sync", serde_json::json!({}));
                        }
                    }
                }
                tauri::WindowEvent::CloseRequested { api: _, .. } => {
                    if window.label() == "main" {
                        // Close whatsapp window too
                        if let Some(wpp) = window.app_handle().get_webview_window("whatsapp") {
                            let _ = wpp.close();
                        }
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            load_config,
            save_config,
            load_state,
            pick_folder,
            fetch_groups,
            load_cached_groups,
            scan_groups,
            load_progress_data,
            save_progress_data,
            show_wpp_webview,
            hide_wpp_webview,
            reload_wpp_webview,
            sync_wpp_window,
            win_minimize,
            win_maximize,
            win_close,
            run_now,
            abort_download,
            download_all_media,
            schedule_task,
            check_task,
            delete_task,
            enable_task,
            disable_task,
            wpp_logout,
            wpp_clear_session,
            factory_reset,
            apply_initial_date,
            reset_group_state,
            open_logs,
        ])
        .run(tauri::generate_context!())
        .expect("Error while running ADW Assistent v3");
}
