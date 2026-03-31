import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface CaptureSource {
  id: string;
  name: string;
  width: number;
  height: number;
  is_primary: boolean;
}

export interface CaptureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RecordingConfig {
  source_id: string;
  fps: number;
  capture_audio: boolean;
  capture_mic: boolean;
  capture_mouse?: boolean;
  region?: CaptureRegion;
}

export type SessionId = string;

export interface SessionSummary {
  session_id: SessionId;
  duration_secs: number;
  video_path: string;
  metadata_path: string;
  file_size_mb: number;
}

export interface RecordingStatus {
  is_recording: boolean;
  duration_secs: number;
}

export interface MouseEvent {
  timestamp_us: number;
  x: number;
  y: number;
  buttons: number;
}

export interface VideoInfo {
  width: number;
  height: number;
  fps: number;
}

export interface Clip {
  start_time: number;
  end_time: number;
  media_offset: number; // source video time at clip start
  track_id?: number;
  source_session_id?: string;
}

export interface SubtitleStyle {
  x: number;            // 0-1 normalized (0.5 = center)
  y: number;            // 0-1 normalized (0.85 = near bottom)
  fontSize: number;     // px
  fontColor: string;    // hex
  strokeColor: string;  // hex
  strokeWidth: number;  // px
  bgColor: string;      // hex or "transparent"
  opacity: number;      // 0-1
  rotation: number;     // degrees
  scale: number;        // multiplier
  letterSpacing: number;// px
  lineHeight: number;   // multiplier
  blendMode: string;    // globalCompositeOperation
}

export const defaultSubtitleStyle: SubtitleStyle = {
  x: 0.5,
  y: 0.85,
  fontSize: 48,
  fontColor: "#ffffff",
  strokeColor: "#000000",
  strokeWidth: 2,
  bgColor: "transparent",
  opacity: 1,
  rotation: 0,
  scale: 1,
  letterSpacing: 0,
  lineHeight: 1.2,
  blendMode: "source-over",
};

export interface Subtitle {
  start_time: number;
  end_time: number;
  text: string;
  style?: SubtitleStyle;
}

export interface ZoomSegment {
  start_time: number;
  end_time: number;
  zoom_level: number;
  follow_speed: number;
  padding: number;
}

export interface ZoomEffectConfig {
  segments: ZoomSegment[];
}

export interface ExportSettings {
  format: string;
  quality: string;
  resolution: [number, number] | null;
  burn_subtitles: boolean;
  fps?: number;
}

export interface Project {
  session_id: string;
  clips: Clip[];
  subtitles: Subtitle[];
  zoom_effect: ZoomEffectConfig;
  export_settings: ExportSettings;
}

export interface ExportProgress {
  percent: number;
  current_frame: number;
  total_frames: number;
  status: string;
}

export interface ExportComplete {
  output_path: string;
  file_size_mb: number;
}

export interface ExportError {
  message: string;
}

export interface PermissionStatus {
  granted: boolean;
}

export interface MonitorInfo {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  scale_factor: number;
}

export interface SessionInfo {
  session_id: string;
  duration_secs: number;
  file_size_mb: number;
  created_at: string;
  has_project: boolean;
  thumbnail_path: string | null;
}

export const ipc = {
  checkPermission: () => invoke<PermissionStatus>("check_permission"),
  requestPermission: () => invoke<PermissionStatus>("request_permission"),
  listCaptureSources: () => invoke<CaptureSource[]>("list_capture_sources"),

  startRecording: (config: RecordingConfig) =>
    invoke<SessionId>("start_recording", { config }),

  stopRecording: () => invoke<SessionSummary>("stop_recording"),

  getRecordingStatus: () => invoke<RecordingStatus>("get_recording_status"),

  getMouseMetadata: (sessionId: string) =>
    invoke<MouseEvent[]>("get_mouse_metadata", { sessionId }),

  getCaptureRegion: (sessionId: string) =>
    invoke<CaptureRegion | null>("get_capture_region", { sessionId }),

  getWaveform: (sessionId: string, samplesPerSec = 100) =>
    invoke<number[]>("get_waveform", { sessionId, samplesPerSec }),

  getVideoDuration: (sessionId: string) =>
    invoke<number>("get_video_duration", { sessionId }),

  getVideoInfo: (sessionId: string) =>
    invoke<VideoInfo>("get_video_info", { sessionId }),

  saveProject: (sessionId: string, project: Project) =>
    invoke<void>("save_project", { sessionId, project }),

  loadProject: (sessionId: string) =>
    invoke<Project | null>("load_project", { sessionId }),

  startExport: (sessionId: string, outputPath: string, project: Project) =>
    invoke<void>("start_export", { sessionId, outputPath, project }),

  cancelExport: () => invoke<void>("cancel_export"),

  fileExists: (path: string) => invoke<boolean>("file_exists", { path }),

  getDesktopPath: () => invoke<string>("get_desktop_path"),

  // Event listeners
  onExportProgress: (cb: (p: ExportProgress) => void): Promise<UnlistenFn> =>
    listen<ExportProgress>("export-progress", (e) => cb(e.payload)),

  onExportComplete: (cb: (r: ExportComplete) => void): Promise<UnlistenFn> =>
    listen<ExportComplete>("export-complete", (e) => cb(e.payload)),

  onExportError: (cb: (e: ExportError) => void): Promise<UnlistenFn> =>
    listen<ExportError>("export-error", (e) => cb(e.payload)),

  // Screenshot
  takeScreenshot: (region?: CaptureRegion) =>
    invoke<string>("take_screenshot", { region: region ?? null }),

  // Region selector overlay
  showRegionSelector: () => invoke<MonitorInfo[]>("show_region_selector"),
  dismissRegionSelector: () => invoke<void>("dismiss_region_selector"),

  // Recording region border indicator
  showRegionBorder: (region: CaptureRegion) => invoke<void>("show_region_border", { region }),
  dismissRegionBorder: () => invoke<void>("dismiss_region_border"),

  // Recording floating toolbar
  showRecordingToolbar: (region: CaptureRegion) => invoke<void>("show_recording_toolbar", { region }),
  dismissRecordingToolbar: () => invoke<void>("dismiss_recording_toolbar"),
  cancelRecording: () => invoke<void>("cancel_recording"),

  // Toolbar-initiated recording control (uses backend emit for cross-window communication)
  toolbarStopRecording: () => invoke<void>("toolbar_stop_recording"),
  toolbarCancelRecording: () => invoke<void>("toolbar_cancel_recording"),

  // Open session in Finder
  showInFinder: (sessionId: string) => invoke<void>("show_in_finder", { sessionId }),

  // Sessions browser window
  showSessionsBrowser: () => invoke<void>("show_sessions_browser"),

  // Session management
  listSessions: () => invoke<SessionInfo[]>("list_sessions"),
  deleteSession: (sessionId: string) => invoke<void>("delete_session", { sessionId }),
  generateThumbnail: (sessionId: string) => invoke<string>("generate_thumbnail", { sessionId }),
};
