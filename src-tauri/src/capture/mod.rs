pub mod audio;
pub mod mouse;
pub mod permission;
pub mod screen;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingConfig {
    pub source_id: String,
    pub fps: u32,
    pub capture_audio: bool,
    pub capture_mic: bool,
    #[serde(default)]
    pub region: Option<CaptureRegion>,
}

impl Default for RecordingConfig {
    fn default() -> Self {
        Self {
            source_id: String::new(),
            fps: 60,
            capture_audio: true,
            capture_mic: true,
            region: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureSource {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub is_primary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionId(pub String);

impl SessionId {
    pub fn new() -> Self {
        Self(Uuid::new_v4().to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSummary {
    pub session_id: SessionId,
    pub duration_secs: f64,
    pub video_path: PathBuf,
    pub metadata_path: PathBuf,
    pub file_size_mb: f64,
}

/// Get the sessions directory for storing recordings
pub fn sessions_dir() -> PathBuf {
    let data_dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.master.screencap")
        .join("sessions");
    std::fs::create_dir_all(&data_dir).ok();
    data_dir
}
