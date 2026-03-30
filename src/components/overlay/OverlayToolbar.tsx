import { useState, useCallback } from "react";
import { emit } from "@tauri-apps/api/event";
import { ipc } from "@/lib/ipc";
import { Camera, ChevronDown, Monitor, Video } from "lucide-react";

interface OverlayToolbarProps {
  region: { x: number; y: number; w: number; h: number };
}

export function OverlayToolbar({ region }: OverlayToolbarProps) {
  const [captureAudio, setCaptureAudio] = useState(true);
  const [captureMic, setCaptureMic] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);

  const handleStartRecording = useCallback(async () => {
    const sources = await ipc.listCaptureSources();
    const primary = sources.find((s) => s.is_primary) || sources[0];
    if (!primary) return;

    const sessionId = await ipc.startRecording({
      source_id: primary.id,
      fps: 60,
      capture_audio: captureAudio,
      capture_mic: captureMic,
      region: {
        x: region.x,
        y: region.y,
        width: region.w,
        height: region.h,
      },
    });

    // Notify main window that recording has started
    await emit("recording-started", {
      session_id: sessionId,
      region: { x: region.x, y: region.y, width: region.w, height: region.h },
    });

    await ipc.dismissRegionSelector();
  }, [region, captureAudio, captureMic]);

  const handleScreenshotRegion = useCallback(async () => {
    await ipc.takeScreenshot({
      x: region.x,
      y: region.y,
      width: region.w,
      height: region.h,
    });
    await ipc.dismissRegionSelector();
  }, [region]);

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
          className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white text-sm font-medium rounded-l-md transition-colors"
          onClick={handleStartRecording}
        >
          <Video className="h-3.5 w-3.5" />
          Record
        </button>
        <button
          className="flex items-center px-1.5 py-1.5 bg-red-600 hover:bg-red-500 text-white border-l border-red-700 rounded-r-md transition-colors"
          onClick={() => setShowDropdown(!showDropdown)}
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>

        {/* Audio config dropdown */}
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
