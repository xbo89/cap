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
        let session_dir = super::session_dir(&session_id.0);
        std::fs::create_dir_all(&session_dir).map_err(|e| e.to_string())?;

        let video_path = session_dir.join("video.mp4");
        let fps = if config.fps > 30 { 30 } else { config.fps };

        // Ensure cached Swift recorder binary exists
        let compiled_path = ensure_cached_recorder()?;

        // Write runtime config JSON for the recorder
        let region = config.region.as_ref().map(|r| {
            serde_json::json!({
                "x": r.x, "y": r.y, "width": r.width, "height": r.height
            })
        });
        let runtime_config = serde_json::json!({
            "video_path": video_path.to_str().unwrap(),
            "session_dir": session_dir.to_str().unwrap(),
            "fps": fps,
            "shows_cursor": config.capture_mouse,
            "capture_audio": config.capture_audio,
            "capture_mic": config.capture_mic,
            "region": region,
        });
        let config_path = session_dir.join("recorder_config.json");
        std::fs::write(&config_path, serde_json::to_string(&runtime_config).unwrap())
            .map_err(|e| e.to_string())?;

        // Run — stderr inherits to avoid pipe buffer blocking the recorder
        let child = Command::new(compiled_path.to_str().unwrap())
            .arg(config_path.to_str().unwrap())
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

    pub fn session_dir(&self) -> Option<&std::path::Path> {
        self.session_dir.as_deref()
    }
}

mod libc_ffi {
    extern "C" { pub fn kill(pid: i32, sig: i32) -> i32; }
}

/// Ensure the cached Swift recorder binary is compiled and return its path.
/// The binary is compiled once and reused for all recordings.
fn ensure_cached_recorder() -> Result<PathBuf, String> {
    let cache_dir = super::sessions_dir().parent().unwrap().join("cache");
    std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;

    let compiled_path = cache_dir.join("recorder");
    let swift_path = cache_dir.join("recorder.swift");
    let swift_src = build_swift_recorder();

    // Check if cached binary is up to date (compare source hash)
    let hash_path = cache_dir.join("recorder.hash");
    let current_hash = format!("{:x}", md5_hash(swift_src.as_bytes()));
    let cached_hash = std::fs::read_to_string(&hash_path).unwrap_or_default();

    if compiled_path.exists() && current_hash == cached_hash.trim() {
        return Ok(compiled_path);
    }

    // Need to (re)compile
    std::fs::write(&swift_path, &swift_src).map_err(|e| e.to_string())?;

    let compile = Command::new("swiftc")
        .args([
            "-O",
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

    // Save hash
    let _ = std::fs::write(&hash_path, &current_hash);

    Ok(compiled_path)
}

/// Simple hash for cache invalidation
fn md5_hash(data: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in data {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn build_swift_recorder() -> String {
    // The Swift recorder now reads config from a JSON file passed as argv[1].
    // This allows the binary to be compiled once and reused across recordings.
    r#"import Cocoa
import AVFoundation
import ScreenCaptureKit
import Foundation

struct RecorderConfig: Codable {
    let video_path: String
    let session_dir: String
    let fps: Int
    let shows_cursor: Bool
    let capture_audio: Bool?
    let capture_mic: Bool?
    let region: Region?

    struct Region: Codable {
        let x: Double
        let y: Double
        let width: Double
        let height: Double
    }
}

// Read config from argv[1]
guard CommandLine.arguments.count > 1 else {
    fputs("Usage: recorder <config.json>\n", stderr)
    exit(1)
}
let configPath = CommandLine.arguments[1]
guard let configData = FileManager.default.contents(atPath: configPath),
      let cfg = try? JSONDecoder().decode(RecorderConfig.self, from: configData) else {
    fputs("ERROR: Failed to read config from \(configPath)\n", stderr)
    exit(1)
}

let readyFlag = cfg.session_dir + "/recording.flag"
let stopFlag = cfg.session_dir + "/stop.flag"
let doneFlag = cfg.session_dir + "/done.flag"

class Recorder: NSObject, SCStreamOutput {
    var stream: SCStream?
    var writer: AVAssetWriter?
    var videoInput: AVAssetWriterInput?
    var audioInput: AVAssetWriterInput?
    var micInput: AVAssetWriterInput?
    var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    var sessionStarted = false
    var frameCount = 0
    var audioSampleCount = 0
    var errorLogged = false
    let outputURL: URL
    var stopping = false
    var captureAudio = false
    var captureMic = false

    // Microphone capture via AVCaptureSession
    var micSession: AVCaptureSession?
    var micWriter: AVAssetWriterInput?
    var micOutputDelegate: MicDelegate?

    init(outputPath: String) {
        self.outputURL = URL(fileURLWithPath: outputPath)
        super.init()
    }

    func start(config cfg: RecorderConfig) async throws {
        captureAudio = cfg.capture_audio ?? false
        captureMic = cfg.capture_mic ?? false

        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard !content.displays.isEmpty else {
            fputs("ERROR: No display found\n", stderr)
            exit(1)
        }

        var display = content.displays[0]

        if let region = cfg.region {
            let regionCenter = CGPoint(x: region.x + region.width / 2, y: region.y + region.height / 2)
            for d in content.displays {
                let frame = CGDisplayBounds(d.displayID)
                if frame.contains(regionCenter) {
                    display = d
                    break
                }
            }
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let streamConfig = SCStreamConfiguration()

        if let region = cfg.region {
            let displayBounds = CGDisplayBounds(display.displayID)
            streamConfig.sourceRect = CGRect(
                x: region.x - displayBounds.origin.x,
                y: region.y - displayBounds.origin.y,
                width: region.width,
                height: region.height
            )
            streamConfig.width = Int(region.width) * 2
            streamConfig.height = Int(region.height) * 2
        } else {
            streamConfig.width = display.width * 2
            streamConfig.height = display.height * 2
        }

        streamConfig.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(cfg.fps))
        streamConfig.pixelFormat = kCVPixelFormatType_32BGRA
        streamConfig.showsCursor = cfg.shows_cursor
        streamConfig.colorSpaceName = CGColorSpace.displayP3

        // Enable system audio capture via ScreenCaptureKit
        if captureAudio {
            streamConfig.capturesAudio = true
            streamConfig.sampleRate = 48000
            streamConfig.channelCount = 2
        }

        try? FileManager.default.removeItem(at: outputURL)
        writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)

        // Video input
        let videoSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: streamConfig.width,
            AVVideoHeightKey: streamConfig.height,
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 8_000_000],
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_P3_D65,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ]
        ]
        videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        videoInput?.expectsMediaDataInRealTime = true

        adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: videoInput!,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: streamConfig.width,
                kCVPixelBufferHeightKey as String: streamConfig.height,
            ]
        )
        writer?.add(videoInput!)

        // Audio input (system audio from ScreenCaptureKit)
        if captureAudio {
            let audioSettings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48000,
                AVNumberOfChannelsKey: 2,
                AVEncoderBitRateKey: 128000,
            ]
            audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
            audioInput?.expectsMediaDataInRealTime = true
            writer?.add(audioInput!)
        }

        // Microphone input (separate AVCaptureSession)
        if captureMic {
            let micAudioSettings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48000,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 64000,
            ]
            micInput = AVAssetWriterInput(mediaType: .audio, outputSettings: micAudioSettings)
            micInput?.expectsMediaDataInRealTime = true
            writer?.add(micInput!)

            // Set up AVCaptureSession for mic
            let session = AVCaptureSession()
            if let micDevice = AVCaptureDevice.default(for: .audio),
               let micDeviceInput = try? AVCaptureDeviceInput(device: micDevice) {
                session.addInput(micDeviceInput)
                let audioOutput = AVCaptureAudioDataOutput()
                let delegate = MicDelegate(recorder: self)
                audioOutput.setSampleBufferDelegate(delegate, queue: DispatchQueue(label: "mic-queue"))
                session.addOutput(audioOutput)
                micSession = session
                micOutputDelegate = delegate
                fputs("Microphone capture configured\n", stderr)
            } else {
                fputs("Warning: No microphone available\n", stderr)
            }
        }

        writer?.startWriting()

        if writer?.status == .failed {
            fputs("ERROR: AVAssetWriter failed: \(writer?.error?.localizedDescription ?? "unknown")\n", stderr)
            exit(1)
        }

        stream = SCStream(filter: filter, configuration: streamConfig, delegate: nil)
        try stream?.addStreamOutput(self, type: .screen, sampleHandlerQueue: .global())
        if captureAudio {
            try stream?.addStreamOutput(self, type: .audio, sampleHandlerQueue: DispatchQueue(label: "audio-queue"))
        }
        try await stream?.startCapture()

        // Start mic capture after stream is running
        micSession?.startRunning()

        FileManager.default.createFile(atPath: readyFlag, contents: nil)
        let audioDesc = captureAudio ? ", system audio: ON" : ""
        let micDesc = captureMic ? ", mic: ON" : ""
        fputs("Recording started (display: \(display.width)x\(display.height), fps: \(cfg.fps)\(audioDesc)\(micDesc))\n", stderr)
    }

    func stream(_ s: SCStream, didOutputSampleBuffer buf: CMSampleBuffer, of type: SCStreamOutputType) {
        guard !stopping else { return }
        guard buf.isValid else { return }
        guard let w = writer, w.status == .writing else { return }

        let pts = CMSampleBufferGetPresentationTimeStamp(buf)

        if type == .screen {
            guard let videoInput = videoInput, videoInput.isReadyForMoreMediaData else { return }
            guard let pixelBuffer = CMSampleBufferGetImageBuffer(buf) else { return }

            if !sessionStarted {
                w.startSession(atSourceTime: pts)
                sessionStarted = true
            }

            if let adaptor = adaptor {
                if !adaptor.append(pixelBuffer, withPresentationTime: pts) {
                    if !errorLogged {
                        fputs("ERROR: Adaptor append failed. Writer status: \(w.status.rawValue) error: \(w.error?.localizedDescription ?? "none")\n", stderr)
                        errorLogged = true
                    }
                    return
                }
            } else {
                if !videoInput.append(buf) { return }
            }
            frameCount += 1
        } else if type == .audio {
            guard sessionStarted else { return }
            guard let audioInput = audioInput, audioInput.isReadyForMoreMediaData else { return }
            if audioInput.append(buf) {
                audioSampleCount += 1
            }
        }
    }

    func appendMicSample(_ buf: CMSampleBuffer) {
        guard !stopping, sessionStarted else { return }
        guard let w = writer, w.status == .writing else { return }
        guard let micInput = micInput, micInput.isReadyForMoreMediaData else { return }
        micInput.append(buf)
    }

    func stopSync() {
        fputs("Stopping capture (frames: \(frameCount), audio samples: \(audioSampleCount))...\n", stderr)

        micSession?.stopRunning()
        micSession = nil

        if let s = stream {
            var captureStopped = false
            s.stopCapture { error in
                if let error = error {
                    fputs("Warning: stopCapture: \(error)\n", stderr)
                }
                captureStopped = true
            }
            while !captureStopped {
                RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
            }
            stream = nil
        }

        stopping = true
        Thread.sleep(forTimeInterval: 0.1)

        videoInput?.markAsFinished()
        audioInput?.markAsFinished()
        micInput?.markAsFinished()

        guard let w = writer, w.status == .writing else {
            fputs("ERROR: Writer not in writing state\n", stderr)
            return
        }

        var writingDone = false
        w.finishWriting {
            writingDone = true
        }
        while !writingDone {
            RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
        }

        if w.status == .completed {
            fputs("Video finalized OK. Frames: \(frameCount), audio samples: \(audioSampleCount)\n", stderr)
            let fd = open(outputURL.path, O_WRONLY)
            if fd >= 0 {
                fsync(fd)
                close(fd)
            }
        }
    }
}

// Delegate for microphone AVCaptureSession audio output
class MicDelegate: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    weak var recorder: Recorder?
    init(recorder: Recorder) {
        self.recorder = recorder
        super.init()
    }
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        recorder?.appendMicSample(sampleBuffer)
    }
}

let rec = Recorder(outputPath: cfg.video_path)

signal(SIGTERM) { _ in
    FileManager.default.createFile(atPath: stopFlag, contents: nil)
}

Task {
    do {
        try await rec.start(config: cfg)
    } catch {
        fputs("Start error: \(error)\n", stderr)
        exit(1)
    }
}

Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { timer in
    guard FileManager.default.fileExists(atPath: stopFlag) else { return }
    timer.invalidate()

    rec.stopSync()

    let statusMsg = "frames=\(rec.frameCount) writer_status=\(rec.writer?.status.rawValue ?? -1) file_size=\(try? FileManager.default.attributesOfItem(atPath: rec.outputURL.path)[.size] ?? 0)"
    fputs("Status: \(statusMsg)\n", stderr)

    FileManager.default.createFile(atPath: doneFlag, contents: statusMsg.data(using: .utf8))
    fputs("Done flag created, exiting.\n", stderr)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
        exit(0)
    }
}

RunLoop.current.run()
"#.to_string()
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
