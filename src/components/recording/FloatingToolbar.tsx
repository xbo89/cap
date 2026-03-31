import { useState, useEffect, useRef, useCallback } from "react";
import { ipc } from "@/lib/ipc";
import { Square, X } from "lucide-react";

export function FloatingToolbar() {
  const [durationSecs, setDurationSecs] = useState(0);
  const [stopping, setStopping] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);

  // Poll recording status for timer
  useEffect(() => {
    timerRef.current = setInterval(async () => {
      try {
        const status = await ipc.getRecordingStatus();
        setDurationSecs(status.duration_secs);
      } catch {
        // Recording may have stopped
      }
    }, 500);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const handleStop = useCallback(async () => {
    if (stopping) return;
    setStopping(true);
    try {
      // Call Rust command directly — it stops recording, dismisses UI,
      // and emits "toolbar-recording-stopped" to the main window via app.emit()
      await ipc.toolbarStopRecording();
    } catch (e) {
      console.error("Stop failed:", e);
      setStopping(false);
    }
  }, [stopping]);

  const handleCancel = useCallback(async () => {
    if (stopping) return;
    setStopping(true);
    try {
      // Call Rust command directly — it cancels recording, deletes session,
      // and emits "toolbar-recording-cancelled" to the main window via app.emit()
      await ipc.toolbarCancelRecording();
    } catch (e) {
      console.error("Cancel failed:", e);
      setStopping(false);
    }
  }, [stopping]);

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ userSelect: "none" }}
    >
      <div
        data-tauri-drag-region
        className="flex items-center gap-3 bg-gray-900/95 backdrop-blur-sm rounded-full px-4 py-2 shadow-2xl border border-white/10"
      >
        {/* Recording indicator + timer */}
        <div className="flex items-center gap-2 pointer-events-none">
          <span className="h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse" />
          <span className="text-sm font-mono text-white/90 tabular-nums">
            {formatTime(durationSecs)}
          </span>
        </div>

        <div className="w-px h-4 bg-white/20 pointer-events-none" />

        {/* Stop recording */}
        <button
          className="flex items-center gap-1.5 h-7 px-3 bg-red-600 hover:bg-red-500 text-white text-xs font-medium rounded-full transition-colors disabled:opacity-50"
          onClick={handleStop}
          disabled={stopping}
          title="Stop recording"
        >
          <Square className="h-3 w-3 fill-current" />
          Stop
        </button>

        {/* Cancel recording */}
        <button
          className="flex items-center justify-center h-7 w-7 text-white/60 hover:text-white hover:bg-white/10 rounded-full transition-colors disabled:opacity-50"
          onClick={handleCancel}
          disabled={stopping}
          title="Cancel recording"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
