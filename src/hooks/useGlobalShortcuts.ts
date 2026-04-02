import { useEffect } from "react";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { ipc } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function useGlobalShortcuts() {
  useEffect(() => {
    const shortcuts: string[] = [];

    async function setup() {
      // Cmd+Shift+5: Open region selector
      try {
        await register("CommandOrControl+Shift+5", async () => {
          // Check backend recording status (authoritative) instead of local state
          const status = await ipc.getRecordingStatus();
          if (!status.is_recording) {
            try {
              await ipc.showRegionSelector();
            } catch (e) {
              console.warn("showRegionSelector failed (overlay may already exist):", e);
            }
          }
        });
        shortcuts.push("CommandOrControl+Shift+5");
      } catch (e) {
        console.warn("Failed to register Cmd+Shift+5:", e);
      }

      // Cmd+Shift+R: Toggle recording
      try {
        await register("CommandOrControl+Shift+R", async () => {
          // Always check backend for authoritative recording state
          const status = await ipc.getRecordingStatus();
          if (status.is_recording) {
            // Stop recording → open editor
            try {
              const summary = await ipc.stopRecording();
              const store = useAppStore.getState();
              store.setRecording(false);
              store.setCurrentSession(summary);

              const events = await ipc.getMouseMetadata(summary.session_id);
              store.setMouseEvents(events);

              store.setView("editor");

              const win = getCurrentWindow();
              await win.show();
              await win.setFocus();
            } catch (e) {
              console.error("Stop recording failed:", e);
            }
          } else {
            // Open region selector
            try {
              await ipc.showRegionSelector();
            } catch (e) {
              console.warn("showRegionSelector failed (overlay may already exist):", e);
            }
          }
        });
        shortcuts.push("CommandOrControl+Shift+R");
      } catch (e) {
        console.warn("Failed to register Cmd+Shift+R:", e);
      }
    }

    setup();

    return () => {
      shortcuts.forEach((s) => {
        unregister(s).catch(() => {});
      });
    };
  }, []);
}
