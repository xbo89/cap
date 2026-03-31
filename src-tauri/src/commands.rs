use crate::capture::audio;
use crate::capture::mouse::MouseEvent;
use crate::capture::screen::Recorder;
use crate::capture::{CaptureRegion, CaptureSource, RecordingConfig, SessionId, SessionSummary};
use crate::export::render::{self, CancelFlag, ExportJob};
use crate::project::{ExportFormat, ExportQuality, ExportSettings, Project, ZoomSegment};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct AppState {
    pub recorder: Mutex<Recorder>,
    pub export_cancel: CancelFlag,
}

#[tauri::command]
pub fn list_capture_sources() -> Vec<CaptureSource> {
    Recorder::list_sources()
}

#[tauri::command]
pub fn check_permission() -> PermissionStatus {
    let granted = crate::capture::permission::check_screen_capture_permission();
    PermissionStatus { granted }
}

#[tauri::command]
pub fn request_permission() -> PermissionStatus {
    let granted = crate::capture::permission::request_screen_capture_permission();
    if !granted {
        crate::capture::permission::open_screen_recording_settings();
    }
    PermissionStatus { granted }
}

#[derive(serde::Serialize, Clone)]
pub struct PermissionStatus {
    pub granted: bool,
}

#[tauri::command]
pub fn start_recording(
    app: AppHandle,
    config: RecordingConfig,
    state: State<'_, AppState>,
) -> Result<SessionId, String> {
    // Show region border indicator if recording a specific region
    let region_for_border = config.region.clone();
    let mut recorder = state.recorder.lock().map_err(|e| e.to_string())?;
    let session_id = recorder.start(config)?;

    if let Some(region) = region_for_border {
        let _ = show_region_border(app, region);
    }

    Ok(session_id)
}

#[tauri::command]
pub fn stop_recording(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SessionSummary, String> {
    let mut recorder = state.recorder.lock().map_err(|e| e.to_string())?;
    let summary = recorder.stop()?;

    // Dismiss region border if it exists
    let _ = dismiss_region_border(app);

    Ok(summary)
}

#[tauri::command]
pub fn get_recording_status(state: State<'_, AppState>) -> Result<RecordingStatus, String> {
    let recorder = state.recorder.lock().map_err(|e| e.to_string())?;
    Ok(RecordingStatus {
        is_recording: recorder.is_recording(),
        duration_secs: recorder.elapsed_secs(),
    })
}

#[tauri::command]
pub fn get_mouse_metadata(session_id: String) -> Result<Vec<MouseEvent>, String> {
    let metadata_path = crate::capture::sessions_dir()
        .join(&session_id)
        .join("metadata.json");
    let data = std::fs::read_to_string(&metadata_path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_capture_region(session_id: String) -> Result<Option<crate::capture::CaptureRegion>, String> {
    let region_path = crate::capture::sessions_dir()
        .join(&session_id)
        .join("region.json");
    if !region_path.exists() {
        return Ok(None);
    }
    let data = std::fs::read_to_string(&region_path).map_err(|e| e.to_string())?;
    let region = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    Ok(Some(region))
}

#[tauri::command]
pub fn get_waveform(session_id: String, samples_per_sec: u32) -> Result<Vec<f32>, String> {
    let video_path = crate::capture::sessions_dir()
        .join(&session_id)
        .join("video.mp4");
    let sps = if samples_per_sec == 0 { 100 } else { samples_per_sec };
    audio::extract_waveform(&video_path, sps)
}

#[tauri::command]
pub fn get_video_duration(session_id: String) -> Result<f64, String> {
    let video_path = crate::capture::sessions_dir()
        .join(&session_id)
        .join("video.mp4");
    audio::get_video_duration(&video_path)
}

#[tauri::command]
pub fn save_project(session_id: String, project: Project) -> Result<(), String> {
    let project_path = crate::capture::sessions_dir()
        .join(&session_id)
        .join("project.json");
    let json = serde_json::to_string_pretty(&project).map_err(|e| e.to_string())?;
    std::fs::write(&project_path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_project(session_id: String) -> Result<Option<Project>, String> {
    let project_path = crate::capture::sessions_dir()
        .join(&session_id)
        .join("project.json");
    if !project_path.exists() {
        return Ok(None);
    }
    let data = std::fs::read_to_string(&project_path).map_err(|e| e.to_string())?;
    let project: Project = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    Ok(Some(project))
}

#[tauri::command]
pub fn get_video_info(session_id: String) -> Result<VideoInfo, String> {
    let video_path = crate::capture::sessions_dir()
        .join(&session_id)
        .join("video.mp4");

    // Use ffprobe to get width, height, fps
    let output = std::process::Command::new("ffprobe")
        .args([
            "-v", "quiet",
            "-show_entries", "stream=width,height,r_frame_rate",
            "-select_streams", "v:0",
            "-of", "csv=p=0",
            video_path.to_str().unwrap_or(""),
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("ffprobe failed: {}", e))?;

    let s = String::from_utf8_lossy(&output.stdout);
    let parts: Vec<&str> = s.trim().split(',').collect();
    if parts.len() < 3 {
        return Err("Could not parse video info".into());
    }

    let width = parts[0].parse::<u32>().unwrap_or(1920);
    let height = parts[1].parse::<u32>().unwrap_or(1080);

    // Parse frame rate (e.g. "30/1" or "60000/1001")
    let fps_parts: Vec<&str> = parts[2].split('/').collect();
    let fps = if fps_parts.len() == 2 {
        let num = fps_parts[0].parse::<f64>().unwrap_or(30.0);
        let den = fps_parts[1].parse::<f64>().unwrap_or(1.0);
        if den > 0.0 { num / den } else { 30.0 }
    } else {
        parts[2].parse::<f64>().unwrap_or(30.0)
    };

    Ok(VideoInfo { width, height, fps })
}

#[tauri::command]
pub fn start_export(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    output_path: String,
    project: Project,
) -> Result<(), String> {
    // Reset cancel flag
    *state.export_cancel.lock().unwrap() = false;
    let cancel = state.export_cancel.clone();

    let session_dir = crate::capture::sessions_dir().join(&session_id);

    // Load mouse events
    let metadata_path = session_dir.join("metadata.json");
    let mouse_events: Vec<MouseEvent> = if metadata_path.exists() {
        let data = std::fs::read_to_string(&metadata_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        vec![]
    };

    // Load capture region
    let region_path = session_dir.join("region.json");
    let capture_region: Option<crate::capture::CaptureRegion> = if region_path.exists() {
        let data = std::fs::read_to_string(&region_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&data).ok()
    } else {
        None
    };

    // Get video info
    let video_info = get_video_info(session_id.clone())?;
    let duration = audio::get_video_duration(&session_dir.join("video.mp4"))?;

    let zoom_segments = project.zoom_effect.into_segments(duration);

    // Use custom fps from export settings, or fall back to source video fps
    let export_fps = project.export_settings.fps.unwrap_or(video_info.fps);

    let job = ExportJob {
        session_dir,
        output_path: PathBuf::from(&output_path),
        clips: project.clips,
        subtitles: project.subtitles,
        zoom_segments,
        mouse_events,
        capture_region,
        export_settings: project.export_settings,
        video_width: video_info.width,
        video_height: video_info.height,
        duration,
        fps: export_fps,
    };

    // Run export in background thread
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let app_progress = app_clone.clone();
        let result = render::run_export(job, cancel, move |progress| {
            let _ = app_progress.emit("export-progress", &progress);
        });

        match result {
            Ok(path) => {
                let size = std::fs::metadata(&path)
                    .map(|m| m.len() as f64 / 1_048_576.0)
                    .unwrap_or(0.0);
                let _ = app_clone.emit(
                    "export-complete",
                    ExportComplete {
                        output_path: path.to_string_lossy().to_string(),
                        file_size_mb: size,
                    },
                );
            }
            Err(e) => {
                let _ = app_clone.emit("export-error", ExportError { message: e });
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn cancel_export(state: State<'_, AppState>) -> Result<(), String> {
    *state.export_cancel.lock().unwrap() = true;
    Ok(())
}

#[tauri::command]
pub fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

#[tauri::command]
pub fn get_desktop_path() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    Ok(format!("{}/Desktop", home))
}

#[derive(serde::Serialize, Clone)]
pub struct RecordingStatus {
    pub is_recording: bool,
    pub duration_secs: f64,
}

#[derive(serde::Serialize, Clone)]
pub struct VideoInfo {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
}

// --- Screenshot ---

#[tauri::command]
pub fn take_screenshot(region: Option<CaptureRegion>) -> Result<String, String> {
    use std::process::Command;

    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let desktop = format!("{}/Desktop", home);

    let timestamp = chrono_timestamp();
    let filename = format!("Screenshot {}.png", timestamp);
    let output_path = PathBuf::from(&desktop).join(&filename);

    // Use macOS screencapture CLI — reliable and handles retina scaling
    let mut args = vec!["-x".to_string()]; // silent, no sound
    if let Some(ref r) = region {
        args.extend([
            "-R".to_string(),
            format!("{},{},{},{}", r.x as i32, r.y as i32, r.width as i32, r.height as i32),
        ]);
    }
    args.push(output_path.to_str().unwrap().to_string());

    let result = Command::new("screencapture")
        .args(&args)
        .output()
        .map_err(|e| format!("screencapture failed: {}", e))?;

    if !result.status.success() {
        return Err(format!(
            "screencapture error: {}",
            String::from_utf8_lossy(&result.stderr)
        ));
    }

    Ok(output_path.to_string_lossy().to_string())
}

fn chrono_timestamp() -> String {
    use std::process::Command;
    Command::new("date")
        .args(["+%Y-%m-%d at %H.%M.%S"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "unknown".into())
}

// --- Region selector overlay ---

#[derive(serde::Serialize, Clone)]
pub struct MonitorInfo {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale_factor: f64,
}

#[tauri::command]
pub fn show_region_selector(app: AppHandle) -> Result<Vec<MonitorInfo>, String> {
    use tauri::WebviewWindowBuilder;

    // Close any existing overlay windows
    let _ = dismiss_region_selector(app.clone());

    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let mut monitor_infos = Vec::new();

    for (i, monitor) in monitors.iter().enumerate() {
        let pos = monitor.position();
        let size = monitor.size();
        let scale = monitor.scale_factor();

        let label = format!("overlay_{}", i);
        let logical_w = size.width as f64 / scale;
        let logical_h = size.height as f64 / scale;
        let logical_x = pos.x as f64 / scale;
        let logical_y = pos.y as f64 / scale;

        // Pass monitor offset as query params so the overlay knows its global position
        let url = format!("/overlay.html?monitorX={}&monitorY={}", logical_x, logical_y);
        let builder = WebviewWindowBuilder::new(
            &app,
            &label,
            tauri::WebviewUrl::App(url.into()),
        )
        .title("")
        .inner_size(logical_w, logical_h)
        .position(logical_x, logical_y)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .resizable(false)
        .skip_taskbar(true)
        .focused(true);

        builder.build().map_err(|e| format!("Failed to create overlay: {}", e))?;

        monitor_infos.push(MonitorInfo {
            id: i as u32,
            x: logical_x,
            y: logical_y,
            width: logical_w,
            height: logical_h,
            scale_factor: scale,
        });
    }

    Ok(monitor_infos)
}

#[tauri::command]
pub fn dismiss_region_selector(app: AppHandle) -> Result<(), String> {
    // Close all overlay windows
    for i in 0..16 {
        let label = format!("overlay_{}", i);
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.close();
        }
    }
    Ok(())
}

// --- Recording region border indicator ---

#[tauri::command]
pub fn show_region_border(app: AppHandle, region: CaptureRegion) -> Result<(), String> {
    use tauri::WebviewWindowBuilder;

    // Close any existing border window
    let _ = dismiss_region_border(app.clone());

    // Create a small borderless transparent window positioned exactly at the region
    // with a colored border to indicate the recording area.
    // Add a few pixels of padding for the border itself.
    let padding = 3.0;
    let builder = WebviewWindowBuilder::new(
        &app,
        "region_border",
        tauri::WebviewUrl::App("/region-border.html".into()),
    )
    .title("")
    .inner_size(region.width + padding * 2.0, region.height + padding * 2.0)
    .position(region.x - padding, region.y - padding)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .resizable(false)
    .skip_taskbar(true)
    .focused(false);

    // This window should not be interactable — clicks pass through
    let window = builder.build().map_err(|e| format!("Failed to create border window: {}", e))?;
    let _ = window.set_ignore_cursor_events(true);

    Ok(())
}

#[tauri::command]
pub fn dismiss_region_border(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("region_border") {
        let _ = window.close();
    }
    Ok(())
}

// --- Session management ---

#[derive(serde::Serialize, Clone)]
pub struct SessionInfo {
    pub session_id: String,
    pub duration_secs: f64,
    pub file_size_mb: f64,
    pub created_at: String,
    pub has_project: bool,
    pub thumbnail_path: Option<String>,
}

#[tauri::command]
pub fn list_sessions() -> Result<Vec<SessionInfo>, String> {
    let sessions_dir = crate::capture::sessions_dir();
    let mut sessions = Vec::new();

    let entries = std::fs::read_dir(&sessions_dir).map_err(|e| e.to_string())?;

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() { continue; }

        let session_id = path.file_name().unwrap().to_string_lossy().to_string();
        let video_path = path.join("video.mp4");
        if !video_path.exists() { continue; }

        // Read cached session info (fast) instead of calling ffprobe (slow)
        let info_path = path.join("session_info.json");
        let (duration_secs, file_size_mb) = if info_path.exists() {
            let data = std::fs::read_to_string(&info_path).unwrap_or_default();
            let v: serde_json::Value = serde_json::from_str(&data).unwrap_or_default();
            (
                v["duration_secs"].as_f64().unwrap_or(0.0),
                v["file_size_mb"].as_f64().unwrap_or(0.0),
            )
        } else {
            // Fallback: read file size from fs, skip duration (will show 0)
            let size = std::fs::metadata(&video_path)
                .map(|m| m.len() as f64 / 1_048_576.0)
                .unwrap_or(0.0);
            (0.0, size)
        };

        let created_at = std::fs::metadata(&path)
            .and_then(|m| m.created())
            .map(|t| {
                let secs = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
                format!("{}", secs)
            })
            .unwrap_or_default();

        let has_project = path.join("project.json").exists();
        let thumb = path.join("thumbnail.jpg");
        let thumbnail_path = if thumb.exists() {
            Some(thumb.to_string_lossy().to_string())
        } else {
            None
        };

        sessions.push(SessionInfo {
            session_id,
            duration_secs,
            file_size_mb,
            created_at,
            has_project,
            thumbnail_path,
        });
    }

    // Sort by created_at descending (newest first)
    sessions.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(sessions)
}

#[tauri::command]
pub fn delete_session(session_id: String) -> Result<(), String> {
    // Validate session_id looks like a UUID to prevent path traversal
    if session_id.len() != 36 || !session_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err("Invalid session ID".into());
    }
    let session_path = crate::capture::sessions_dir().join(&session_id);
    if session_path.exists() {
        std::fs::remove_dir_all(&session_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn generate_thumbnail(session_id: String) -> Result<String, String> {
    let session_dir = crate::capture::sessions_dir().join(&session_id);
    let video_path = session_dir.join("video.mp4");
    let thumb_path = session_dir.join("thumbnail.jpg");

    if thumb_path.exists() {
        return Ok(thumb_path.to_string_lossy().to_string());
    }
    if !video_path.exists() {
        return Err("Video not found".into());
    }

    let result = std::process::Command::new("ffmpeg")
        .args([
            "-y", "-ss", "1", "-i", video_path.to_str().unwrap(),
            "-frames:v", "1", "-q:v", "5",
            "-vf", "scale=320:-1",
            thumb_path.to_str().unwrap(),
        ])
        .output()
        .map_err(|e| format!("ffmpeg failed: {}", e))?;

    if !result.status.success() {
        return Err("Thumbnail generation failed".into());
    }

    Ok(thumb_path.to_string_lossy().to_string())
}

#[derive(serde::Serialize, Clone)]
struct ExportComplete {
    output_path: String,
    file_size_mb: f64,
}

#[derive(serde::Serialize, Clone)]
struct ExportError {
    message: String,
}
