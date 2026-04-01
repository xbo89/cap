import { useEffect } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { useAppStore } from "@/lib/store";
import { ipc, type SessionSummary } from "@/lib/ipc";
import { RecordingControls } from "@/components/recording/RecordingControls";
import { EditorView } from "@/components/editor/EditorView";
import { ShortcutsHelp } from "@/components/ui/shortcuts-help";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import "./index.css";

/** Shared stop-recording logic: stop backend, update store, show editor */
async function stopAndOpenEditor() {
  const store = useAppStore.getState();
  try {
    // Auto-save current project before loading new session
    if (store.currentSession) {
      await emit("save-current-project");
    }
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

    // Overlay toolbar requests recording start — main window handles it
    // because the overlay window destroys itself (dismissRegionSelector)
    // and can't make IPC calls after that.
    listen<{
      source_id: string;
      fps: number;
      capture_audio: boolean;
      capture_mic: boolean;
      capture_mouse: boolean;
      region: { x: number; y: number; width: number; height: number };
    }>("request-start-recording", async (event) => {
      const store = useAppStore.getState();
      const config = event.payload;
      try {
        // Auto-save current project if editor is open before starting new recording
        if (store.currentSession) {
          await emit("save-current-project");
        }
        // Brief delay to ensure overlay windows are fully closed
        await new Promise((r) => setTimeout(r, 50));
        await ipc.startRecording(config);
        store.setRecording(true);
      } catch (e) {
        console.error("Start recording failed:", e);
      }
    }).then((u) => unlisteners.push(u));

    // Legacy: sync isRecording when recording-started is emitted
    listen("recording-started", () => {
      const store = useAppStore.getState();
      store.setRecording(true);
    }).then((u) => unlisteners.push(u));

    // Tray stop: always try to stop (don't check isRecording — backend is authoritative)
    listen("tray-stop-recording", () => {
      stopAndOpenEditor();
    }).then((u) => unlisteners.push(u));

    // Floating toolbar: stop recording (emitted by Rust backend via app.emit)
    listen<SessionSummary>("toolbar-recording-stopped", async (event) => {
      const store = useAppStore.getState();
      const summary = event.payload;
      try {
        // Auto-save current project before loading new session
        if (store.currentSession) {
          await emit("save-current-project");
        }
        store.setRecording(false);
        store.setCurrentSession(summary);
        const events = await ipc.getMouseMetadata(summary.session_id);
        store.setMouseEvents(events);
        store.setView("editor");

        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        await win.show();
        await win.setFocus();
      } catch (e) {
        console.error("Toolbar stop failed:", e);
      }
    }).then((u) => unlisteners.push(u));

    // Floating toolbar: cancel recording (emitted by Rust backend via app.emit)
    listen("toolbar-recording-cancelled", () => {
      const store = useAppStore.getState();
      store.setRecording(false);
      store.setCurrentSession(null);
    }).then((u) => unlisteners.push(u));

    // Sessions browser: open a session in the editor
    listen<{ session_id: string }>("open-session", async (event) => {
      const { session_id: sid } = event.payload;
      const store = useAppStore.getState();
      try {
        const dur = await ipc.getVideoDuration(sid);
        const currentPath = store.currentSession?.video_path || "";
        const basePath = currentPath.replace(/\/[^/]+\/video\.mp4$/, "");
        const sessBase = basePath || "";
        store.setCurrentSession({
          session_id: sid,
          duration_secs: dur,
          video_path: `${sessBase}/${sid}/video.mp4`,
          metadata_path: `${sessBase}/${sid}/metadata.json`,
          file_size_mb: 0,
        });
        const events = await ipc.getMouseMetadata(sid);
        store.setMouseEvents(events);
        store.setView("editor");

        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        await win.show();
        await win.setFocus();
      } catch (e) {
        console.error("Failed to open session:", e);
      }
    }).then((u) => unlisteners.push(u));

    // .capcap file opened from OS
    listen<{ session_id: string; session_path: string }>("capcap-opened", async (event) => {
      const { session_id: sid, session_path } = event.payload;
      const store = useAppStore.getState();
      try {
        const dur = await ipc.getVideoDuration(sid);
        store.setCurrentSession({
          session_id: sid,
          duration_secs: dur,
          video_path: `${session_path}/video.mp4`,
          metadata_path: `${session_path}/metadata.json`,
          file_size_mb: 0,
        });
        const events = await ipc.getMouseMetadata(sid);
        store.setMouseEvents(events);
        store.setView("editor");
      } catch (e) {
        console.error("Failed to open .capcap file:", e);
      }
    }).then((u) => unlisteners.push(u));

    return () => unlisteners.forEach((u) => u());
  }, [setView]);

  return (
    <TooltipProvider delayDuration={400}>
    <div className="h-screen w-screen flex flex-col overflow-hidden select-none">
      {view === "recording" ? (
        <>
          {/* Draggable titlebar region for macOS overlay style */}
          <div
            data-tauri-drag-region
            className="h-8 shrink-0 flex items-center justify-center"
          />
          <div className="flex-1 min-h-0 flex items-center justify-center">
            <RecordingControls />
          </div>
        </>
      ) : (
        <EditorView />
      )}

      <ShortcutsHelp />
    </div>
    </TooltipProvider>
  );
}

export default App;
