import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/lib/store";
import { ipc } from "@/lib/ipc";
import { RecordingControls } from "@/components/recording/RecordingControls";
import { EditorView } from "@/components/editor/EditorView";
import { ShortcutsHelp } from "@/components/ui/shortcuts-help";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import "./index.css";

/** Shared stop-recording logic: stop backend, update store, show editor */
async function stopAndOpenEditor() {
  const store = useAppStore.getState();
  try {
    const summary = await ipc.stopRecording();
    store.setRecording(false);
    store.setCurrentSession(summary);
    const events = await ipc.getMouseMetadata(summary.session_id);
    store.setMouseEvents(events);
    store.setView("editor");

    // Border indicator is dismissed by the Rust stop_recording command automatically

    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    await win.show();
    await win.setFocus();
  } catch (e) {
    console.error("Stop recording failed:", e);
  }
}

function App() {
  const { view, setView } = useAppStore();

  // Register system-wide global shortcuts
  useGlobalShortcuts();

  // Listen for cross-window and tray events
  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    listen("tray-open-editor", () => {
      setView("editor");
    }).then((u) => unlisteners.push(u));

    // When overlay starts recording, sync isRecording to main window store
    listen("recording-started", () => {
      const store = useAppStore.getState();
      store.setRecording(true);
      // Border indicator is created by the Rust start_recording command automatically
    }).then((u) => unlisteners.push(u));

    // Tray stop: always try to stop (don't check isRecording — backend is authoritative)
    listen("tray-stop-recording", () => {
      stopAndOpenEditor();
    }).then((u) => unlisteners.push(u));

    return () => unlisteners.forEach((u) => u());
  }, [setView]);

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden select-none">
      {/* Draggable titlebar region for macOS overlay style */}
      <div
        data-tauri-drag-region
        className="h-8 shrink-0 flex items-center justify-center"
      >
        {view === "editor" && (
          <span className="text-[11px] text-muted-foreground/50 pointer-events-none">
            ScreenCap
          </span>
        )}
      </div>

      {/* Main content */}
      <div className="flex-1 min-h-0">
        {view === "recording" ? (
          <div className="h-full flex items-center justify-center">
            <RecordingControls />
          </div>
        ) : (
          <EditorView />
        )}
      </div>

      <ShortcutsHelp />
    </div>
  );
}

export default App;
