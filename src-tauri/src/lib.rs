mod capture;
mod commands;
mod export;
mod project;
mod tray;

use capture::screen::Recorder;
use commands::AppState;
use std::sync::{Arc, Mutex};
use std::io::{Read as _, Seek as _, SeekFrom};
use tauri::http::Response;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState {
            recorder: Mutex::new(Recorder::new()),
            export_cancel: Arc::new(Mutex::new(false)),
        })
        .setup(|app| {
            tray::setup_tray(app)?;
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("stream", move |_ctx, request, responder| {
            // Custom protocol to serve local video files
            // URL format: stream://localhost/<encoded_path>
            let uri = request.uri().to_string();
            let range_header = request.headers().get("range")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            std::thread::spawn(move || {
                let path = uri
                    .strip_prefix("stream://localhost/")
                    .or_else(|| uri.strip_prefix("stream:///"))
                    .unwrap_or("");

                let decoded_path =
                    urlencoding::decode(path).unwrap_or_else(|_| path.into());
                let file_path = std::path::Path::new(decoded_path.as_ref());

                if !file_path.exists() {
                    responder.respond(
                        Response::builder()
                            .status(404)
                            .body(b"Not found".to_vec())
                            .unwrap(),
                    );
                    return;
                }

                // Read file and determine content type
                let ext = file_path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("");
                let mime = match ext {
                    "mp4" => "video/mp4",
                    "mov" => "video/quicktime",
                    "webm" => "video/webm",
                    "mp3" => "audio/mpeg",
                    "aac" => "audio/aac",
                    "wav" => "audio/wav",
                    _ => "application/octet-stream",
                };

                let file_size = match std::fs::metadata(file_path) {
                    Ok(m) => m.len(),
                    Err(_) => {
                        responder.respond(
                            Response::builder()
                                .status(500)
                                .body(b"Read error".to_vec())
                                .unwrap(),
                        );
                        return;
                    }
                };

                let (start, end) = if let Some(ref range) = range_header {
                    // Parse "bytes=start-end" or "bytes=start-"
                    if let Some(range_spec) = range.strip_prefix("bytes=") {
                        let parts: Vec<&str> = range_spec.splitn(2, '-').collect();
                        let s = parts[0].parse::<u64>().unwrap_or(0);
                        let e = if parts.len() > 1 && !parts[1].is_empty() {
                            parts[1].parse::<u64>().unwrap_or(file_size - 1)
                        } else {
                            file_size - 1
                        };
                        (s, e.min(file_size - 1))
                    } else {
                        (0, file_size - 1)
                    }
                } else {
                    (0, file_size - 1)
                };

                let content_length = end - start + 1;

                let mut file = match std::fs::File::open(file_path) {
                    Ok(f) => f,
                    Err(_) => {
                        responder.respond(
                            Response::builder()
                                .status(500)
                                .body(b"Read error".to_vec())
                                .unwrap(),
                        );
                        return;
                    }
                };

                let mut buf = vec![0u8; content_length as usize];
                let read_ok = file.seek(SeekFrom::Start(start)).is_ok()
                    && file.read_exact(&mut buf).is_ok();

                if !read_ok {
                    responder.respond(
                        Response::builder()
                            .status(500)
                            .body(b"Read error".to_vec())
                            .unwrap(),
                    );
                    return;
                }

                if range_header.is_some() {
                    responder.respond(
                        Response::builder()
                            .status(206)
                            .header("Content-Type", mime)
                            .header("Accept-Ranges", "bytes")
                            .header("Content-Range", format!("bytes {}-{}/{}", start, end, file_size))
                            .header("Content-Length", content_length.to_string())
                            .header("Access-Control-Allow-Origin", "*")
                            .body(buf)
                            .unwrap(),
                    );
                } else {
                    responder.respond(
                        Response::builder()
                            .status(200)
                            .header("Content-Type", mime)
                            .header("Accept-Ranges", "bytes")
                            .header("Content-Length", file_size.to_string())
                            .header("Access-Control-Allow-Origin", "*")
                            .body(buf)
                            .unwrap(),
                    );
                }
            });
        })
        .invoke_handler(tauri::generate_handler![
            commands::check_permission,
            commands::request_permission,
            commands::list_capture_sources,
            commands::start_recording,
            commands::stop_recording,
            commands::get_recording_status,
            commands::get_mouse_metadata,
            commands::get_capture_region,
            commands::get_waveform,
            commands::get_video_duration,
            commands::get_video_info,
            commands::save_project,
            commands::load_project,
            commands::start_export,
            commands::cancel_export,
            commands::file_exists,
            commands::get_desktop_path,
            commands::take_screenshot,
            commands::show_region_selector,
            commands::dismiss_region_selector,
            commands::show_region_border,
            commands::dismiss_region_border,
            commands::list_sessions,
            commands::delete_session,
            commands::generate_thumbnail,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
