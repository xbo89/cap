use super::{CaptureSource, RecordingConfig, SessionId, SessionSummary};
use crate::capture::mouse::MouseTracker;
use serde_json;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub struct Recorder {
    session_id: Option<SessionId>,
    session_dir: Option<PathBuf>,
    mouse_tracker: Option<MouseTracker>,
    start_time: Option<Instant>,
    recording_process: Option<std::process::Child>,
    is_recording: Arc<Mutex<bool>>,
    capture_region: Option<super::CaptureRegion>,
}

impl Recorder {
    pub fn new() -> Self {
        Self {
            session_id: None,
            session_dir: None,
            mouse_tracker: None,
            start_time: None,
            recording_process: None,
            is_recording: Arc::new(Mutex::new(false)),
            capture_region: None,
        }
    }

    pub fn is_recording(&self) -> bool {
        *self.is_recording.lock().unwrap()
    }

    pub fn list_sources() -> Vec<CaptureSource> {
        #[cfg(target_os = "macos")]
        { list_macos_screens() }
        #[cfg(not(target_os = "macos"))]
        { vec![] }
    }

    pub fn start(&mut self, config: RecordingConfig) -> Result<SessionId, String> {
        if self.is_recording() {
            return Err("Already recording".into());
        }

        let session_id = SessionId::new();
        let session_dir = super::sessions_dir().join(&session_id.0);
        std::fs::create_dir_all(&session_dir).map_err(|e| e.to_string())?;

        let video_path = session_dir.join("video.mp4");
        let fps = if config.fps > 30 { 30 } else { config.fps };

        // Write ScreenCaptureKit-based Swift recorder
        let region = config.region.as_ref().map(|r| (r.x, r.y, r.width, r.height));
        let swift_src = build_swift_recorder(
            video_path.to_str().unwrap(),
            session_dir.join("recording.flag").to_str().unwrap(),
            fps,
            region,
        );

        let swift_path = session_dir.join("record.swift");
        std::fs::write(&swift_path, &swift_src).map_err(|e| e.to_string())?;

        // Compile
        let compiled_path = session_dir.join("recorder");
        let compile = Command::new("swiftc")
            .args([
                "-framework", "Cocoa",
                "-framework", "AVFoundation",
                "-framework", "CoreMedia",
                "-framework", "ScreenCaptureKit",
                "-o", compiled_path.to_str().unwrap(),
                swift_path.to_str().unwrap(),
            ])
            .output()
            .map_err(|e| format!("swiftc failed: {}", e))?;

        if !compile.status.success() {
            return Err(format!(
                "Swift compile error: {}",
                String::from_utf8_lossy(&compile.stderr)
            ));
        }

        // Run — stderr inherits to avoid pipe buffer blocking the recorder
        let child = Command::new(compiled_path.to_str().unwrap())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .map_err(|e| format!("Failed to start recorder: {}", e))?;

        // Wait for ready flag
        let ready_flag = session_dir.join("recording.flag");
        let wait_start = Instant::now();
        while !ready_flag.exists() && wait_start.elapsed().as_secs() < 5 {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        if !ready_flag.exists() {
            return Err("Recorder failed to start. Screen recording permission may not be granted.".into());
        }

        let mut mouse_tracker = MouseTracker::new();
        mouse_tracker.start();

        *self.is_recording.lock().unwrap() = true;
        self.session_id = Some(session_id.clone());
        self.session_dir = Some(session_dir);
        self.mouse_tracker = Some(mouse_tracker);
        self.start_time = Some(Instant::now());
        self.recording_process = Some(child);
        self.capture_region = config.region.clone();

        Ok(session_id)
    }

    pub fn stop(&mut self) -> Result<SessionSummary, String> {
        if !self.is_recording() {
            return Err("Not recording".into());
        }

        let duration = self.start_time.unwrap().elapsed().as_secs_f64();

        let session_dir = self.session_dir.as_ref().unwrap();
        let stop_flag = session_dir.join("stop.flag");
        let done_flag = session_dir.join("done.flag");

        // Signal the recorder to stop via file flag
        let _ = std::fs::File::create(&stop_flag);

        if let Some(ref mut process) = self.recording_process {
            // Wait for done flag (recorder finished writing) or timeout
            let start = Instant::now();
            while !done_flag.exists() && start.elapsed().as_secs() < 10 {
                match process.try_wait() {
                    Ok(Some(_)) => break,
                    _ => std::thread::sleep(std::time::Duration::from_millis(200)),
                }
            }

            // If done flag not created, send SIGTERM as fallback
            if !done_flag.exists() {
                unsafe { libc_ffi::kill(process.id() as i32, 15); }
                let start2 = Instant::now();
                while !done_flag.exists() && start2.elapsed().as_secs() < 5 {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
            }

            // Wait for process exit
            let start3 = Instant::now();
            loop {
                match process.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if start3.elapsed().as_secs() > 3 => {
                        let _ = process.kill();
                        let _ = process.wait();
                        break;
                    }
                    _ => std::thread::sleep(std::time::Duration::from_millis(100)),
                }
            }

        }

        let mouse_events = if let Some(ref tracker) = self.mouse_tracker {
            tracker.stop()
        } else {
            vec![]
        };

        let session_dir = self.session_dir.as_ref().unwrap();
        let metadata_path = session_dir.join("metadata.json");
        std::fs::write(&metadata_path, serde_json::to_string(&mouse_events).unwrap_or_default())
            .map_err(|e| e.to_string())?;

        // Save capture region info if present
        if let Some(ref region) = self.capture_region {
            let region_path = session_dir.join("region.json");
            let _ = std::fs::write(&region_path, serde_json::to_string(region).unwrap_or_default());
        }

        let video_path = session_dir.join("video.mp4");
        let file_size_bytes = std::fs::metadata(&video_path).map(|m| m.len()).unwrap_or(0);
        let file_size = file_size_bytes as f64 / 1_048_576.0;

        if file_size_bytes == 0 {
            // Clean up state before returning error
            *self.is_recording.lock().unwrap() = false;
            self.session_id = None;
            self.session_dir = None;
            self.mouse_tracker = None;
            self.start_time = None;
            self.recording_process = None;
            return Err("Recording failed: video file is empty. Check screen recording permissions.".into());
        }

        let summary = SessionSummary {
            session_id: self.session_id.clone().unwrap(),
            duration_secs: duration,
            video_path,
            metadata_path,
            file_size_mb: file_size,
        };

        // Cache session info for fast listing later
        let info_cache = serde_json::json!({
            "duration_secs": duration,
            "file_size_mb": file_size,
        });
        let _ = std::fs::write(
            session_dir.join("session_info.json"),
            serde_json::to_string(&info_cache).unwrap_or_default(),
        );

        *self.is_recording.lock().unwrap() = false;
        self.session_id = None;
        self.session_dir = None;
        self.mouse_tracker = None;
        self.start_time = None;
        self.recording_process = None;

        Ok(summary)
    }

    pub fn elapsed_secs(&self) -> f64 {
        self.start_time.map(|t| t.elapsed().as_secs_f64()).unwrap_or(0.0)
    }
}

mod libc_ffi {
    extern "C" { pub fn kill(pid: i32, sig: i32) -> i32; }
}

fn build_swift_recorder(
    video_path: &str,
    ready_flag: &str,
    fps: u32,
    region: Option<(f64, f64, f64, f64)>,
) -> String {
    let ready = std::path::Path::new(ready_flag);
    let stop_flag_str = ready.parent().unwrap().join("stop.flag");
    let done_flag_str = ready.parent().unwrap().join("done.flag");
    let stop_flag = stop_flag_str.to_str().unwrap();
    let done_flag = done_flag_str.to_str().unwrap();

    format!(
        r#"import Cocoa
import AVFoundation
import ScreenCaptureKit

class Recorder: NSObject, SCStreamOutput {{
    var stream: SCStream?
    var writer: AVAssetWriter?
    var videoInput: AVAssetWriterInput?
    var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    var sessionStarted = false
    var frameCount = 0
    var errorLogged = false
    let outputURL: URL
    var stopping = false

    init(outputPath: String) {{
        self.outputURL = URL(fileURLWithPath: outputPath)
        super.init()
    }}

    func start() async throws {{
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard !content.displays.isEmpty else {{
            fputs("ERROR: No display found\n", stderr)
            exit(1)
        }}

        // Find the display that contains the capture region (if specified),
        // otherwise use the first display.
        var display = content.displays[0]
        {display_selection_code}

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        {region_code}
        config.minimumFrameInterval = CMTime(value: 1, timescale: {fps})
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = true

        try? FileManager.default.removeItem(at: outputURL)
        writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)

        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: config.width,
            AVVideoHeightKey: config.height,
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 8_000_000]
        ]
        videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        videoInput?.expectsMediaDataInRealTime = true

        // Use pixel buffer adaptor for proper format handling with ScreenCaptureKit
        adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: videoInput!,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: config.width,
                kCVPixelBufferHeightKey as String: config.height,
            ]
        )

        writer?.add(videoInput!)
        writer?.startWriting()

        if writer?.status == .failed {{
            fputs("ERROR: AVAssetWriter failed: \(writer?.error?.localizedDescription ?? "unknown")\n", stderr)
            exit(1)
        }}

        stream = SCStream(filter: filter, configuration: config, delegate: nil)
        try stream?.addStreamOutput(self, type: .screen, sampleHandlerQueue: .global())
        try await stream?.startCapture()

        FileManager.default.createFile(atPath: "{ready_flag}", contents: nil)
        fputs("Recording started (display: \(display.width)x\(display.height), fps: {fps})\n", stderr)
    }}

    func stream(_ s: SCStream, didOutputSampleBuffer buf: CMSampleBuffer, of type: SCStreamOutputType) {{
        guard type == .screen, !stopping else {{ return }}
        guard buf.isValid else {{ return }}
        guard let videoInput = videoInput, videoInput.isReadyForMoreMediaData else {{ return }}
        guard let w = writer, w.status == .writing else {{ return }}

        // Get the pixel buffer from the sample buffer
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(buf) else {{ return }}
        let pts = CMSampleBufferGetPresentationTimeStamp(buf)

        if !sessionStarted {{
            w.startSession(atSourceTime: pts)
            sessionStarted = true
        }}

        if let adaptor = adaptor {{
            if !adaptor.append(pixelBuffer, withPresentationTime: pts) {{
                if !errorLogged {{
                    fputs("ERROR: Adaptor append failed. Writer status: \(w.status.rawValue) error: \(w.error?.localizedDescription ?? "none")\n", stderr)
                    let dims = CVPixelBufferGetWidth(pixelBuffer)
                    let height = CVPixelBufferGetHeight(pixelBuffer)
                    let fmt = CVPixelBufferGetPixelFormatType(pixelBuffer)
                    fputs("  PixelBuffer: \(dims)x\(height) format=\(fmt) pts=\(pts.seconds)s\n", stderr)
                    errorLogged = true
                }}
                return
            }}
        }} else {{
            if !videoInput.append(buf) {{ return }}
        }}
        frameCount += 1
    }}

    /// Synchronous stop using RunLoop pumping to ensure completion handlers fire.
    func stopSync() {{
        fputs("Stopping capture (frames: \(frameCount))...\n", stderr)

        // Step 1: Stop capture FIRST and wait for completion.
        // After stopCapture completes, no more didOutputSampleBuffer callbacks will fire.
        if let s = stream {{
            var captureStopped = false
            s.stopCapture {{ error in
                if let error = error {{
                    fputs("Warning: stopCapture: \(error)\n", stderr)
                }}
                captureStopped = true
            }}
            while !captureStopped {{
                RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
            }}
            stream = nil
            fputs("Capture stopped. No more callbacks.\n", stderr)
        }}

        // Step 2: NOW it's safe to set stopping and mark finished.
        // No more append calls can happen since capture is stopped.
        stopping = true
        Thread.sleep(forTimeInterval: 0.1) // Extra safety: let any in-flight .global() callbacks drain

        fputs("Writer status before markAsFinished: \(writer?.status.rawValue ?? -1)\n", stderr)
        videoInput?.markAsFinished()
        fputs("Writer status after markAsFinished: \(writer?.status.rawValue ?? -1) error: \(writer?.error?.localizedDescription ?? "none")\n", stderr)

        guard let w = writer, w.status == .writing else {{
            fputs("ERROR: Writer not in writing state: \(writer?.status.rawValue ?? -1) error: \(writer?.error?.localizedDescription ?? "none")\n", stderr)
            return
        }}

        // Step 3: Finish writing synchronously
        var writingDone = false
        w.finishWriting {{
            writingDone = true
        }}
        while !writingDone {{
            RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
        }}

        fputs("finishWriting done. Status: \(w.status.rawValue) error: \(w.error?.localizedDescription ?? "none")\n", stderr)

        if w.status == .completed {{
            fputs("Video finalized OK. Frames: \(frameCount)\n", stderr)
            // Flush file to disk
            let fd = open(outputURL.path, O_WRONLY)
            if fd >= 0 {{
                fsync(fd)
                close(fd)
            }}
        }}
    }}
}}

let rec = Recorder(outputPath: "{video_path}")

// Handle SIGTERM: create stop flag as fallback
signal(SIGTERM) {{ _ in
    FileManager.default.createFile(atPath: "{stop_flag}", contents: nil)
}}

// Start recording
Task {{
    do {{
        try await rec.start()
    }} catch {{
        fputs("Start error: \(error)\n", stderr)
        exit(1)
    }}
}}

// Poll for stop flag on a timer (runs on the main RunLoop)
Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) {{ timer in
    guard FileManager.default.fileExists(atPath: "{stop_flag}") else {{ return }}
    timer.invalidate()

    rec.stopSync()

    // Write diagnostic info
    let statusMsg = "frames=\(rec.frameCount) writer_status=\(rec.writer?.status.rawValue ?? -1) file_size=\(try? FileManager.default.attributesOfItem(atPath: rec.outputURL.path)[.size] ?? 0)"
    fputs("Status: \(statusMsg)\n", stderr)

    FileManager.default.createFile(atPath: "{done_flag}", contents: statusMsg.data(using: .utf8))
    fputs("Done flag created, exiting.\n", stderr)
    // Brief delay then exit
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {{
        exit(0)
    }}
}}

RunLoop.current.run()
"#,
        video_path = video_path.replace('\\', "\\\\").replace('"', "\\\""),
        ready_flag = ready_flag.replace('\\', "\\\\").replace('"', "\\\""),
        stop_flag = stop_flag.replace('\\', "\\\\").replace('"', "\\\""),
        done_flag = done_flag.replace('\\', "\\\\").replace('"', "\\\""),
        fps = fps,
        display_selection_code = if let Some((x, y, w, h)) = region {
            // Pick the display whose frame contains the center of the region
            format!(
                r#"let regionCenter = CGPoint(x: {cx}, y: {cy})
        for d in content.displays {{
            let frame = CGDisplayBounds(d.displayID)
            if frame.contains(regionCenter) {{
                display = d
                break
            }}
        }}"#,
                cx = x + w / 2.0,
                cy = y + h / 2.0,
            )
        } else {
            String::new()
        },
        region_code = if let Some((x, y, w, h)) = region {
            // Region capture: sourceRect is display-relative, so subtract display origin.
            // Global region coords are converted to display-local coords in Swift.
            format!(
                r#"let displayBounds = CGDisplayBounds(display.displayID)
        config.sourceRect = CGRect(x: {x} - displayBounds.origin.x, y: {y} - displayBounds.origin.y, width: {w}, height: {h})
        config.width = Int({w}) * 2
        config.height = Int({h}) * 2"#,
                x = x, y = y, w = w, h = h
            )
        } else {
            // Full display capture
            "config.width = display.width * 2\n        config.height = display.height * 2".to_string()
        },
    )
}

#[cfg(target_os = "macos")]
fn list_macos_screens() -> Vec<CaptureSource> {
    use core_graphics::display::CGDisplay;
    let displays = CGDisplay::active_displays().unwrap_or_default();
    displays.iter().enumerate().map(|(i, &id)| {
        let d = CGDisplay::new(id);
        let b = d.bounds();
        CaptureSource {
            id: i.to_string(),
            name: if d.is_main() { "Main Display".into() } else { format!("Display {}", i + 1) },
            width: b.size.width as u32,
            height: b.size.height as u32,
            is_primary: d.is_main(),
        }
    }).collect()
}
