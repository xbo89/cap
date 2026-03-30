import { useEffect, useRef, useCallback, useState } from "react";
import { Circle, Square, Monitor, Mic, Volume2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/lib/store";
import { useKeyboard } from "@/hooks/useKeyboard";
import { ipc } from "@/lib/ipc";

export function RecordingControls() {
  const {
    isRecording,
    durationSecs,
    selectedSource,
    sources,
    setSources,
    setSelectedSource,
    setRecording,
    setDuration,
    setCurrentSession,
    setView,
    error,
    setError,
  } = useAppStore();

  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const [permissionGranted, setPermissionGranted] = useState<boolean | null>(null);

  // Check permission and load sources on mount
  useEffect(() => {
    ipc.checkPermission().then((status) => {
      setPermissionGranted(status.granted);
    });
    ipc.listCaptureSources().then((sources) => {
      setSources(sources);
      const primary = sources.find((s) => s.is_primary);
      setSelectedSource(primary || sources[0] || null);
    });
  }, [setSources, setSelectedSource]);

  const handleRequestPermission = useCallback(async () => {
    const status = await ipc.requestPermission();
    setPermissionGranted(status.granted);
    // Re-check after a delay (user may grant in System Settings)
    setTimeout(async () => {
      const s = await ipc.checkPermission();
      setPermissionGranted(s.granted);
    }, 3000);
  }, []);

  // Timer for recording duration
  useEffect(() => {
    if (isRecording) {
      timerRef.current = setInterval(async () => {
        const status = await ipc.getRecordingStatus();
        setDuration(status.duration_secs);
      }, 500);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      setDuration(0);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isRecording, setDuration]);

  const handleStart = useCallback(async () => {
    if (!selectedSource) return;
    try {
      await ipc.startRecording({
        source_id: selectedSource.id,
        fps: 60,
        capture_audio: true,
        capture_mic: true,
      });
      setRecording(true);
      setError(null);
    } catch (e) {
      console.error("Failed to start recording:", e);
      setError(String(e));
    }
  }, [selectedSource, setRecording]);

  const handleStop = useCallback(async () => {
    try {
      const summary = await ipc.stopRecording();
      setRecording(false);
      setCurrentSession(summary);
      setView("editor");
    } catch (e) {
      console.error("Failed to stop recording:", e);
    }
  }, [setRecording, setCurrentSession, setView]);

  const handleToggle = useCallback(() => {
    if (isRecording) handleStop();
    else handleStart();
  }, [isRecording, handleStart, handleStop]);

  // Global shortcut: Cmd+Shift+R to toggle recording
  useKeyboard([
    { key: "r", meta: true, shift: true, action: handleToggle },
  ]);

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  // Permission not granted — show guide
  if (permissionGranted === false) {
    return (
      <div className="flex flex-col items-center gap-6 p-8 max-w-sm text-center">
        <ShieldAlert className="h-12 w-12 text-yellow-500" />
        <div>
          <h2 className="text-lg font-semibold">Screen Recording Permission Required</h2>
          <p className="text-sm text-muted-foreground mt-2">
            ScreenCap needs permission to record your screen. Please grant access in System Settings.
          </p>
        </div>
        <Button onClick={handleRequestPermission}>
          Open System Settings
        </Button>
        <button
          className="text-xs text-muted-foreground hover:text-foreground underline"
          onClick={async () => {
            const s = await ipc.checkPermission();
            setPermissionGranted(s.granted);
          }}
        >
          I've granted permission, check again
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-8 p-8">
      {/* App title */}
      {!isRecording && (
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">ScreenCap</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Lightweight screen recorder with zoom focus
          </p>
        </div>
      )}

      {/* Source selector */}
      {!isRecording && (
        <div className="flex flex-col gap-3 w-64">
          <div className="flex items-center gap-2">
            <Monitor className="h-4 w-4 text-muted-foreground" />
            <select
              className="flex-1 bg-secondary text-foreground rounded-md px-3 py-1.5 text-sm border border-input focus:outline-none focus:ring-1 focus:ring-ring"
              value={selectedSource?.id || ""}
              onChange={(e) => {
                const source = sources.find((s) => s.id === e.target.value);
                setSelectedSource(source || null);
              }}
            >
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name} ({source.width}×{source.height})
                </option>
              ))}
            </select>
          </div>

          {/* Audio indicators */}
          <div className="flex items-center gap-4 justify-center text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Volume2 className="h-3 w-3" /> System Audio
            </span>
            <span className="flex items-center gap-1">
              <Mic className="h-3 w-3" /> Microphone
            </span>
          </div>
        </div>
      )}

      {/* Timer display */}
      {isRecording && (
        <div className="flex flex-col items-center gap-2">
          <div className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-full bg-red-500 animate-pulse" />
            <span className="text-sm text-red-400 font-medium">Recording</span>
          </div>
          <div className="text-5xl font-mono font-light tracking-wider text-foreground">
            {formatTime(durationSecs)}
          </div>
        </div>
      )}

      {/* Record / Stop button */}
      <div className="flex items-center gap-4">
        {!isRecording ? (
          <Button
            size="lg"
            onClick={handleStart}
            disabled={!selectedSource}
            className="bg-red-600 hover:bg-red-700 text-white rounded-full h-20 w-20 p-0 shadow-lg shadow-red-600/20 transition-all hover:scale-105 active:scale-95"
          >
            <Circle className="h-8 w-8 fill-current" />
          </Button>
        ) : (
          <Button
            size="lg"
            onClick={handleStop}
            className="bg-red-600 hover:bg-red-700 text-white rounded-full h-20 w-20 p-0 shadow-lg shadow-red-600/20 transition-all hover:scale-105 active:scale-95"
          >
            <Square className="h-6 w-6 fill-current" />
          </Button>
        )}
      </div>

      {/* Error display */}
      {error && (
        <div className="max-w-sm p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-400 text-center">
          {error}
        </div>
      )}

      {/* Hint */}
      <p className="text-xs text-muted-foreground">
        {isRecording ? (
          "Click to stop or press ⌘⇧R"
        ) : (
          <>
            Press <kbd className="px-1 py-0.5 bg-secondary rounded text-[10px]">⌘⇧R</kbd> to start recording
          </>
        )}
      </p>
    </div>
  );
}
