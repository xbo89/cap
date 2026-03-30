use std::path::Path;
use std::process::Command;

/// Extract audio waveform peaks from a video file using ffmpeg.
/// Returns a Vec of peak amplitudes normalized to 0.0-1.0,
/// sampled at approximately `samples_per_sec` samples per second.
pub fn extract_waveform(video_path: &Path, samples_per_sec: u32) -> Result<Vec<f32>, String> {
    if !video_path.exists() {
        return Err(format!("Video file not found: {}", video_path.display()));
    }
    // Use ffmpeg to extract raw PCM audio and compute peaks
    // -ac 1: mono, -ar: sample rate, -f f32le: 32-bit float little-endian
    let sample_rate = samples_per_sec * 64; // oversample then downsample to get peaks
    let output = Command::new("ffmpeg")
        .args([
            "-i",
            video_path.to_str().unwrap_or(""),
            "-vn",           // no video
            "-ac", "1",      // mono
            "-ar", &sample_rate.to_string(),
            "-f", "f32le",   // raw 32-bit float
            "-",             // output to stdout
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("Failed to run ffmpeg for waveform: {}", e))?;

    if !output.status.success() {
        // Video may have no audio track — return empty waveform instead of error
        return Ok(vec![]);
    }

    let raw_bytes = output.stdout;
    if raw_bytes.len() < 4 {
        return Ok(vec![]);
    }

    // Parse f32 samples from raw bytes
    let samples: Vec<f32> = raw_bytes
        .chunks_exact(4)
        .map(|chunk| {
            let bytes: [u8; 4] = [chunk[0], chunk[1], chunk[2], chunk[3]];
            f32::from_le_bytes(bytes).abs()
        })
        .collect();

    // Downsample: take the peak of every `chunk_size` samples
    let chunk_size = 64usize; // matches our oversample factor
    let peaks: Vec<f32> = samples
        .chunks(chunk_size)
        .map(|chunk| {
            chunk
                .iter()
                .cloned()
                .fold(0.0f32, |max, v| if v > max { v } else { max })
        })
        .collect();

    // Normalize to 0.0 - 1.0
    let max_peak = peaks.iter().cloned().fold(0.0f32, f32::max);
    if max_peak > 0.0 {
        Ok(peaks.iter().map(|&v| v / max_peak).collect())
    } else {
        Ok(peaks)
    }
}

/// Get video duration in seconds using ffprobe
pub fn get_video_duration(video_path: &Path) -> Result<f64, String> {
    if !video_path.exists() {
        return Err(format!("Video file not found: {}", video_path.display()));
    }
    let output = Command::new("ffprobe")
        .args([
            "-v", "quiet",
            "-show_entries", "format=duration",
            "-of", "csv=p=0",
            video_path.to_str().unwrap_or(""),
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("ffprobe failed: {}", e))?;

    let s = String::from_utf8_lossy(&output.stdout);
    s.trim()
        .parse::<f64>()
        .map_err(|e| format!("Failed to parse duration: {}", e))
}
