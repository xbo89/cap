import { useState, useCallback, useEffect } from "react";
import { emit } from "@tauri-apps/api/event";
import { ipc } from "@/lib/ipc";
import type { CaptureSource } from "@/lib/ipc";
import { Camera, ChevronDown, Monitor, Video } from "lucide-react";

interface OverlayToolbarProps {
  region: { x: number; y: number; w: number; h: number };
  monitorOffset: { x: number; y: number };
  onRecordingStart?: () => void;
}

export function OverlayToolbar({ region, monitorOffset, onRecordingStart }: OverlayToolbarProps) {
  const [captureAudio, setCaptureAudio] = useState(true);
  const [captureMic, setCaptureMic] = useState(false);
  const [captureMouse, setCaptureMouse] = useState(true);
  const [showDropdown, setShowDropdown] = useState(false);
  const [sources, setSources] = useState<CaptureSource[]>([]);

  // Pre-fetch capture sources on mount for fast recording start
  useEffect(() => {
    ipc.listCaptureSources().then(setSources);
  }, []);

  const handleStartRecording = useCallback(async () => {
    const primary = sources.find((s) => s.is_primary) || sources[0];
    if (!primary) return;

    // Convert window-local region to global screen coordinates
    const globalRegion = {
      x: region.x + monitorOffset.x,
      y: region.y + monitorOffset.y,
      width: region.w,
      height: region.h,
    };

    // Signal parent to hide overlay visuals
    onRecordingStart?.();

    // Emit recording config to main window — let it handle start_recording.
    // We cannot call startRecording here because dismissRegionSelector
    // destroys this window's JS context, killing any subsequent IPC calls.
    await emit("request-start-recording", {
      source_id: primary.id,
      fps: 60,
      capture_audio: captureAudio,
      capture_mic: captureMic,
      capture_mouse: captureMouse,
      region: globalRegion,
    });

    // Brief delay for the event to be received, then dismiss overlay
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await ipc.dismissRegionSelector();
  }, [sources, region, monitorOffset, captureAudio, captureMic, captureMouse, onRecordingStart]);

  const handleScreenshotRegion = useCallback(async () => {
    await ipc.takeScreenshot({
      x: region.x + monitorOffset.x,
      y: region.y + monitorOffset.y,
      width: region.w,
      height: region.h,
    });
    await ipc.dismissRegionSelector();
  }, [region, monitorOffset]);

  const handleScreenshotFull = useCallback(async () => {
    await ipc.takeScreenshot();
    await ipc.dismissRegionSelector();
  }, []);

  return (
    <div
      className="absolute flex items-center gap-2 bg-gray-900/95 backdrop-blur-sm rounded-lg px-3 py-2 shadow-2xl border border-white/10"
      style={{
        left: region.x + region.w / 2,
        top: region.y + region.h + 12,
        transform: "translateX(-50%)",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Record button group */}
      <div className="flex items-center">
        <button
          className="flex items-center gap-1.5 h-8 px-3 bg-red-600 hover:bg-red-500 text-white text-sm font-medium rounded-l-md transition-colors disabled:opacity-50"
          onClick={handleStartRecording}
          disabled={sources.length === 0}
        >
          <Video className="h-3.5 w-3.5" />
          Record
        </button>
        <button
          className="flex items-center justify-center h-8 w-8 bg-red-600 hover:bg-red-500 text-white border-l border-red-700 rounded-r-md transition-colors"
          onClick={() => setShowDropdown(!showDropdown)}
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>

        {/* Recording config dropdown */}
        {showDropdown && (
          <div className="absolute bottom-full left-0 mb-2 w-48 bg-gray-900/95 backdrop-blur-sm border border-white/10 rounded-lg shadow-xl overflow-hidden">
            <label className="flex items-center gap-2 px-3 py-2 hover:bg-white/5 cursor-pointer text-sm text-white/90">
              <input
                type="checkbox"
                checked={captureAudio}
                onChange={(e) => setCaptureAudio(e.target.checked)}
                className="rounded"
              />
              System Audio
            </label>
            <label className="flex items-center gap-2 px-3 py-2 hover:bg-white/5 cursor-pointer text-sm text-white/90">
              <input
                type="checkbox"
                checked={captureMic}
                onChange={(e) => setCaptureMic(e.target.checked)}
                className="rounded"
              />
              Microphone
            </label>
            <div className="h-px bg-white/10" />
            <label className="flex items-center gap-2 px-3 py-2 hover:bg-white/5 cursor-pointer text-sm text-white/90">
              <input
                type="checkbox"
                checked={captureMouse}
                onChange={(e) => setCaptureMouse(e.target.checked)}
                className="rounded"
              />
              Mouse Cursor
            </label>
          </div>
        )}
      </div>

      <div className="w-px h-5 bg-white/20" />

      {/* Screenshot buttons */}
      <button
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-white/80 hover:text-white hover:bg-white/10 text-sm rounded-md transition-colors"
        onClick={handleScreenshotRegion}
        title="Screenshot region"
      >
        <Camera className="h-3.5 w-3.5" />
        Region
      </button>

      <button
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-white/80 hover:text-white hover:bg-white/10 text-sm rounded-md transition-colors"
        onClick={handleScreenshotFull}
        title="Screenshot full screen"
      >
        <Monitor className="h-3.5 w-3.5" />
        Full
      </button>
    </div>
  );
}
