import { useState } from "react";
import { Keyboard, X } from "lucide-react";

const shortcuts = [
  { keys: "⌘⇧R", desc: "Start/Stop recording" },
  { keys: "Space", desc: "Play/Pause preview" },
  { keys: "S", desc: "Split at playhead" },
  { keys: "⌫", desc: "Delete clip at playhead" },
  { keys: "⌘S", desc: "Save project" },
  { keys: "⌘E", desc: "Open export" },
  { keys: "⌘+Scroll", desc: "Zoom timeline" },
];

export function ShortcutsHelp() {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-3 right-3 p-2.5 rounded-md bg-secondary/80 text-muted-foreground hover:text-foreground transition-colors z-40"
        title="Keyboard shortcuts"
      >
        <Keyboard className="h-5 w-5" />
      </button>
    );
  }

  return (
    <div className="fixed bottom-3 right-3 w-56 rounded-lg border border-border bg-card shadow-xl z-40">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-medium">Shortcuts</span>
        <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground">
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="p-2">
        {shortcuts.map((s) => (
          <div key={s.keys} className="flex items-center justify-between py-1 px-1">
            <span className="text-[11px] text-muted-foreground">{s.desc}</span>
            <kbd className="text-[10px] px-1.5 py-0.5 bg-secondary rounded font-mono">
              {s.keys}
            </kbd>
          </div>
        ))}
      </div>
    </div>
  );
}
