import { useState, useCallback, useRef, useEffect } from "react";
import { ipc } from "@/lib/ipc";
import { OverlayToolbar } from "./OverlayToolbar";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type DragMode =
  | { type: "draw"; startX: number; startY: number }
  | { type: "move"; offsetX: number; offsetY: number }
  | { type: "resize"; handle: string; startRect: Rect; startX: number; startY: number }
  | null;

const HANDLE_SIZE = 8;
const MIN_SIZE = 40;

/** Read monitor offset from URL query params (set by show_region_selector). */
function getMonitorOffset(): { x: number; y: number } {
  const params = new URLSearchParams(window.location.search);
  return {
    x: parseFloat(params.get("monitorX") || "0"),
    y: parseFloat(params.get("monitorY") || "0"),
  };
}

export function RegionSelector() {
  const [region, setRegion] = useState<Rect | null>(null);
  const [drag, setDrag] = useState<DragMode>(null);
  const [cursor, setCursor] = useState("crosshair");
  const [startingRecording, setStartingRecording] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const monitorOffset = useRef(getMonitorOffset());

  // Escape to dismiss
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        ipc.dismissRegionSelector();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const hitTestHandle = useCallback(
    (mx: number, my: number): string | null => {
      if (!region) return null;
      const { x, y, w, h } = region;
      const handles: Record<string, [number, number]> = {
        nw: [x, y],
        ne: [x + w, y],
        sw: [x, y + h],
        se: [x + w, y + h],
        n: [x + w / 2, y],
        s: [x + w / 2, y + h],
        w: [x, y + h / 2],
        e: [x + w, y + h / 2],
      };
      for (const [name, [hx, hy]] of Object.entries(handles)) {
        if (Math.abs(mx - hx) <= HANDLE_SIZE && Math.abs(my - hy) <= HANDLE_SIZE) {
          return name;
        }
      }
      return null;
    },
    [region]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (startingRecording) return;
      const mx = e.clientX;
      const my = e.clientY;

      if (region) {
        const handle = hitTestHandle(mx, my);
        if (handle) {
          setDrag({ type: "resize", handle, startRect: { ...region }, startX: mx, startY: my });
          return;
        }
        // Inside region: move
        if (mx >= region.x && mx <= region.x + region.w && my >= region.y && my <= region.y + region.h) {
          setDrag({ type: "move", offsetX: mx - region.x, offsetY: my - region.y });
          return;
        }
      }

      // Start drawing new region
      setRegion(null);
      setDrag({ type: "draw", startX: mx, startY: my });
    },
    [region, hitTestHandle, startingRecording]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const mx = e.clientX;
      const my = e.clientY;

      if (!drag) {
        // Update cursor
        if (region) {
          const handle = hitTestHandle(mx, my);
          if (handle) {
            const cursors: Record<string, string> = {
              nw: "nwse-resize", se: "nwse-resize",
              ne: "nesw-resize", sw: "nesw-resize",
              n: "ns-resize", s: "ns-resize",
              w: "ew-resize", e: "ew-resize",
            };
            setCursor(cursors[handle] || "default");
          } else if (
            mx >= region.x && mx <= region.x + region.w &&
            my >= region.y && my <= region.y + region.h
          ) {
            setCursor("move");
          } else {
            setCursor("crosshair");
          }
        }
        return;
      }

      if (drag.type === "draw") {
        const x = Math.min(drag.startX, mx);
        const y = Math.min(drag.startY, my);
        const w = Math.abs(mx - drag.startX);
        const h = Math.abs(my - drag.startY);
        setRegion({ x, y, w, h });
      } else if (drag.type === "move" && region) {
        setRegion({
          ...region,
          x: mx - drag.offsetX,
          y: my - drag.offsetY,
        });
      } else if (drag.type === "resize" && region) {
        const { handle, startRect, startX, startY } = drag;
        const dx = mx - startX;
        const dy = my - startY;
        let { x, y, w, h } = startRect;

        if (handle.includes("w")) { x += dx; w -= dx; }
        if (handle.includes("e")) { w += dx; }
        if (handle.includes("n")) { y += dy; h -= dy; }
        if (handle.includes("s")) { h += dy; }

        if (w < MIN_SIZE) { w = MIN_SIZE; }
        if (h < MIN_SIZE) { h = MIN_SIZE; }

        setRegion({ x, y, w, h });
      }
    },
    [drag, region, hitTestHandle]
  );

  const handleMouseUp = useCallback(() => {
    setDrag(null);
  }, []);

  // When starting recording, hide all visuals immediately
  if (startingRecording) {
    return <div className="fixed inset-0" style={{ background: "transparent" }} />;
  }

  // Build clip-path for the darkened overlay (everything except the region).
  // Expand cutout by 1px to prevent sub-pixel dark seams at edges.
  const maskStyle: React.CSSProperties = region
    ? {
        clipPath: `polygon(
          0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%,
          ${region.x - 1}px ${region.y - 1}px,
          ${region.x - 1}px ${region.y + region.h + 1}px,
          ${region.x + region.w + 1}px ${region.y + region.h + 1}px,
          ${region.x + region.w + 1}px ${region.y - 1}px,
          ${region.x - 1}px ${region.y - 1}px
        )`,
        clipRule: "evenodd",
      }
    : {};

  const handles = region
    ? [
        { name: "nw", x: region.x, y: region.y },
        { name: "ne", x: region.x + region.w, y: region.y },
        { name: "sw", x: region.x, y: region.y + region.h },
        { name: "se", x: region.x + region.w, y: region.y + region.h },
        { name: "n", x: region.x + region.w / 2, y: region.y },
        { name: "s", x: region.x + region.w / 2, y: region.y + region.h },
        { name: "w", x: region.x, y: region.y + region.h / 2 },
        { name: "e", x: region.x + region.w, y: region.y + region.h / 2 },
      ]
    : [];

  return (
    <div
      ref={containerRef}
      className="fixed inset-0"
      style={{ cursor, userSelect: "none" }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* Dark overlay with cutout for region */}
      <div
        className="absolute inset-0 bg-black/40"
        style={maskStyle}
      />

      {/* Prompt text when no region drawn */}
      {!region && !drag && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-white/80 text-lg font-medium drop-shadow-lg pointer-events-none">
            Drag to select recording area &middot; Esc to cancel
          </span>
        </div>
      )}

      {/* Region border */}
      {region && region.w > 2 && region.h > 2 && (
        <>
          <div
            className="absolute rounded-sm pointer-events-none"
            style={{
              left: region.x,
              top: region.y,
              width: region.w,
              height: region.h,
              outline: "2px solid rgba(255, 255, 255, 0.9)",
              outlineOffset: "0px",
            }}
          />

          {/* Dimension label */}
          <div
            className="absolute text-xs text-white/70 bg-black/60 px-2 py-0.5 rounded pointer-events-none"
            style={{
              left: region.x + region.w / 2,
              top: region.y - 24,
              transform: "translateX(-50%)",
            }}
          >
            {Math.round(region.w)} &times; {Math.round(region.h)}
          </div>

          {/* Resize handles */}
          {!drag &&
            handles.map((h) => (
              <div
                key={h.name}
                className="absolute w-2.5 h-2.5 bg-white border border-gray-400 rounded-sm pointer-events-none"
                style={{
                  left: h.x - 5,
                  top: h.y - 5,
                }}
              />
            ))}

          {/* Toolbar below region */}
          {!drag && (
            <OverlayToolbar
              region={region}
              monitorOffset={monitorOffset.current}
              onRecordingStart={() => setStartingRecording(true)}
            />
          )}
        </>
      )}
    </div>
  );
}
