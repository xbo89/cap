pub mod render;
pub mod zoom;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportProgress {
    pub percent: f64,
    pub current_frame: u64,
    pub total_frames: u64,
    pub eta_secs: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportResult {
    pub output_path: String,
    pub file_size_mb: f64,
}
