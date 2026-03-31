import React from "react";
import ReactDOM from "react-dom/client";
import { SessionSidebar } from "@/components/editor/SessionSidebar";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <div className="h-screen w-screen flex flex-col overflow-hidden select-none bg-background">
      {/* Draggable titlebar region — traffic lights are overlay style */}
      <div
        data-tauri-drag-region
        className="h-8 shrink-0 flex items-center justify-center"
      />
      <div className="flex-1 min-h-0">
        <SessionSidebar standalone />
      </div>
    </div>
  </React.StrictMode>
);
