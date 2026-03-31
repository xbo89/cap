use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub session_id: String,
    pub clips: Vec<Clip>,
    pub subtitles: Vec<Subtitle>,
    pub zoom_effect: ZoomEffect,
    pub export_settings: ExportSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Clip {
    pub start_time: f64,
    pub end_time: f64,
    #[serde(default)]
    pub media_offset: f64,
    #[serde(default)]
    pub track_id: u32,
    #[serde(default)]
    pub source_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Subtitle {
    pub start_time: f64,
    pub end_time: f64,
    pub text: String,
    #[serde(default)]
    pub style: Option<SubtitleStyle>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleStyle {
    #[serde(default = "default_x")]
    pub x: f64,
    #[serde(default = "default_y")]
    pub y: f64,
    #[serde(default = "default_font_size")]
    pub font_size: f64,
    #[serde(default = "default_font_color")]
    pub font_color: String,
    #[serde(default = "default_stroke_color")]
    pub stroke_color: String,
    #[serde(default = "default_stroke_width")]
    pub stroke_width: f64,
    #[serde(default = "default_bg_color")]
    pub bg_color: String,
    #[serde(default = "default_opacity")]
    pub opacity: f64,
    #[serde(default)]
    pub rotation: f64,
    #[serde(default = "default_scale")]
    pub scale: f64,
    #[serde(default)]
    pub letter_spacing: f64,
    #[serde(default = "default_line_height")]
    pub line_height: f64,
    #[serde(default = "default_blend_mode")]
    pub blend_mode: String,
}

fn default_x() -> f64 { 0.5 }
fn default_y() -> f64 { 0.85 }
fn default_font_size() -> f64 { 48.0 }
fn default_font_color() -> String { "#ffffff".into() }
fn default_stroke_color() -> String { "#000000".into() }
fn default_stroke_width() -> f64 { 2.0 }
fn default_bg_color() -> String { "transparent".into() }
fn default_opacity() -> f64 { 1.0 }
fn default_scale() -> f64 { 1.0 }
fn default_line_height() -> f64 { 1.2 }
fn default_blend_mode() -> String { "source-over".into() }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZoomSegment {
    pub start_time: f64,
    pub end_time: f64,
    pub zoom_level: f64,
    pub follow_speed: f64,
    pub padding: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ZoomEffect {
    /// New format: list of zoom segments
    Segments { segments: Vec<ZoomSegment> },
    /// Legacy format: global toggle + config
    Legacy {
        enabled: bool,
        zoom_level: f64,
        follow_speed: f64,
        padding: f64,
    },
}

impl Default for ZoomEffect {
    fn default() -> Self {
        ZoomEffect::Segments { segments: vec![] }
    }
}

impl ZoomEffect {
    /// Convert to segments, migrating legacy format if needed.
    /// `duration` is used to create a full-length segment from legacy enabled config.
    pub fn into_segments(self, duration: f64) -> Vec<ZoomSegment> {
        match self {
            ZoomEffect::Segments { segments } => segments,
            ZoomEffect::Legacy { enabled, zoom_level, follow_speed, padding } => {
                if enabled {
                    vec![ZoomSegment {
                        start_time: 0.0,
                        end_time: duration,
                        zoom_level,
                        follow_speed,
                        padding,
                    }]
                } else {
                    vec![]
                }
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportSettings {
    pub format: ExportFormat,
    pub quality: ExportQuality,
    pub resolution: Option<(u32, u32)>,
    pub burn_subtitles: bool,
    #[serde(default)]
    pub fps: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ExportFormat {
    Mp4H264,
    Mp4H265,
    WebmVp9,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ExportQuality {
    Low,
    Medium,
    High,
    Ultra,
}

impl Default for ExportSettings {
    fn default() -> Self {
        Self {
            format: ExportFormat::Mp4H264,
            quality: ExportQuality::High,
            resolution: None,
            burn_subtitles: true,
            fps: None,
        }
    }
}
