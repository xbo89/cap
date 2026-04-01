import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { SessionSidebar } from "@/components/editor/SessionSidebar";
import "./index.css";

/** Manual drag — data-tauri-drag-region doesn't work reliably on
 *  programmatically created overlay-titlebar windows on macOS. */
function handleDragStart(e: React.MouseEvent) {
  // Only drag from the header area, not from buttons
  if ((e.target as HTMLElement).closest("button")) return;
  e.preventDefault();
  getCurrentWindow().startDragging();
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <div className="h-screen w-screen flex flex-col overflow-hidden select-none bg-background">
      {/* Header — uses manual startDragging for reliable window drag */}
      <div
        onMouseDown={handleDragStart}
        className="flex items-center px-4 py-3 border-b border-white/[0.08] shrink-0 cursor-default"
      >
        <div className="w-[70px] shrink-0" />
        <span className="text-sm font-medium text-white/90">Recordings</span>
      </div>
      <div className="flex-1 min-h-0">
        <SessionSidebar standalone />
      </div>
    </div>
  </React.StrictMode>
);
