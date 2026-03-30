import { useRef, useEffect, useCallback, useState } from "react";
import { ZoomCalculator, type ZoomConfig } from "@/lib/zoom";
import type { MouseEvent as MouseEventData, Clip, Subtitle, SubtitleStyle } from "@/lib/ipc";
import { defaultSubtitleStyle } from "@/lib/ipc";

interface SubtitleBounds {
  index: number;
  x: number; y: number; w: number; h: number; // in CSS coords
  rotation: number;
}

interface PreviewCanvasProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  mouseEvents: MouseEventData[];
  clips?: Clip[];
  subtitles?: Subtitle[];
  timelineTime?: number;
  isPlaying?: boolean;
  zoomConfig: ZoomConfig;
  zoomEnabled: boolean;
  selectedSubtitleIndex: number | null;
  onSubtitleSelect: (index: number | null) => void;
  onSubtitleStyleChange: (index: number, style: SubtitleStyle) => void;
  width?: number;
  height?: number;
}

type HandleType = "move" | "tl" | "tr" | "bl" | "br" | "t" | "b" | "l" | "r" | "rotate";

export function PreviewCanvas({
  videoRef,
  mouseEvents,
  clips,
  subtitles = [],
  timelineTime,
  isPlaying = false,
  zoomConfig,
  zoomEnabled,
  selectedSubtitleIndex,
  onSubtitleSelect,
  onSubtitleStyleChange,
  width = 640,
  height = 360,
}: PreviewCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const animFrameRef = useRef<number>(0);
  const zoomCalcRef = useRef<ZoomCalculator | null>(null);
  const subtitleBoundsRef = useRef<SubtitleBounds[]>([]);
  const tlTimeRef = useRef(timelineTime ?? 0);
  if (timelineTime !== undefined) tlTimeRef.current = timelineTime;
  const [videoDims, setVideoDims] = useState<{ w: number; h: number } | null>(null);
  const [dragging, setDragging] = useState<{
    type: HandleType;
    index: number;
    startMouseX: number;
    startMouseY: number;
    startStyle: SubtitleStyle;
  } | null>(null);

  const getStyle = (sub: Subtitle): SubtitleStyle => ({
    ...defaultSubtitleStyle,
    ...sub.style,
  });

  // Get CSS-to-canvas scale factor
  const getCSSScale = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return { sx: 1, sy: 1 };
    const rect = canvas.getBoundingClientRect();
    return { sx: canvas.width / rect.width, sy: canvas.height / rect.height };
  }, []);

  // Draw a styled subtitle, returns bounding box in canvas coords
  const drawStyledSubtitle = useCallback((
    ctx: CanvasRenderingContext2D,
    sub: Subtitle,
    canvasW: number,
    canvasH: number,
  ): { x: number; y: number; w: number; h: number } => {
    const s = getStyle(sub);
    const scaledFontSize = s.fontSize * s.scale;
    const cx = s.x * canvasW;
    const cy = s.y * canvasH;

    ctx.save();
    ctx.globalAlpha = s.opacity;
    ctx.globalCompositeOperation = s.blendMode as GlobalCompositeOperation;
    ctx.translate(cx, cy);
    if (s.rotation !== 0) ctx.rotate((s.rotation * Math.PI) / 180);

    ctx.font = `bold ${scaledFontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Measure text
    const metrics = ctx.measureText(sub.text || " ");
    const textW = metrics.width + s.letterSpacing * (sub.text.length - 1);
    const textH = scaledFontSize * s.lineHeight;

    // Background
    if (s.bgColor && s.bgColor !== "transparent") {
      ctx.fillStyle = s.bgColor;
      ctx.fillRect(-textW / 2 - 6, -textH / 2 - 2, textW + 12, textH + 4);
    }

    // Draw text with letter spacing
    if (s.letterSpacing !== 0 && sub.text.length > 1) {
      let xOff = -textW / 2;
      for (const char of sub.text) {
        const cw = ctx.measureText(char).width;
        // Stroke
        if (s.strokeWidth > 0) {
          ctx.strokeStyle = s.strokeColor;
          ctx.lineWidth = s.strokeWidth * s.scale;
          ctx.lineJoin = "round";
          ctx.strokeText(char, xOff + cw / 2, 0);
        }
        ctx.fillStyle = s.fontColor;
        ctx.fillText(char, xOff + cw / 2, 0);
        xOff += cw + s.letterSpacing;
      }
    } else {
      // Stroke
      if (s.strokeWidth > 0) {
        ctx.strokeStyle = s.strokeColor;
        ctx.lineWidth = s.strokeWidth * s.scale;
        ctx.lineJoin = "round";
        ctx.strokeText(sub.text || " ", 0, 0);
      }
      ctx.fillStyle = s.fontColor;
      ctx.fillText(sub.text || " ", 0, 0);
    }

    ctx.restore();

    return { x: cx - textW / 2, y: cy - textH / 2, w: textW, h: textH };
  }, []);

  // Draw selection handles
  const drawSelectionHandles = useCallback((
    ctx: CanvasRenderingContext2D,
    bounds: { x: number; y: number; w: number; h: number },
    style: SubtitleStyle,
    canvasW: number,
    canvasH: number,
  ) => {
    const cx = style.x * canvasW;
    const cy = style.y * canvasH;

    ctx.save();
    ctx.translate(cx, cy);
    if (style.rotation !== 0) ctx.rotate((style.rotation * Math.PI) / 180);

    const hw = bounds.w / 2 + 8;
    const hh = bounds.h / 2 + 8;

    // Dashed selection border
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
    ctx.setLineDash([]);

    // Corner + midpoint handles
    const handleSize = 6;
    const positions = [
      [-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh], // corners
      [0, -hh], [0, hh], [-hw, 0], [hw, 0],        // midpoints
    ];
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 1.5;
    for (const [px, py] of positions) {
      ctx.fillRect(px - handleSize / 2, py - handleSize / 2, handleSize, handleSize);
      ctx.strokeRect(px - handleSize / 2, py - handleSize / 2, handleSize, handleSize);
    }

    // Rotation handle
    const rotY = -hh - 24;
    ctx.beginPath();
    ctx.moveTo(0, -hh);
    ctx.lineTo(0, rotY);
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, rotY, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#3b82f6";
    ctx.fill();

    ctx.restore();
  }, []);

  // Draw cursor indicator
  const drawCursor = useCallback((ctx: CanvasRenderingContext2D, x: number, y: number) => {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
    ctx.fill();
    ctx.restore();
  }, []);

  const findMouseEvent = useCallback(
    (timeUs: number): MouseEventData | null => {
      if (mouseEvents.length === 0) return null;
      let lo = 0;
      let hi = mouseEvents.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (mouseEvents[mid].timestamp_us < timeUs) lo = mid + 1;
        else hi = mid;
      }
      return mouseEvents[lo];
    },
    [mouseEvents]
  );

  // Draw a single frame
  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw === 0 || vh === 0) return;

    if (!zoomCalcRef.current) {
      zoomCalcRef.current = new ZoomCalculator(zoomConfig, vw, vh);
    }

    // Use timeline time for gap/subtitle checks (source time for video frame is already set by EditorView)
    const tlTime = timelineTime !== undefined ? tlTimeRef.current : video.currentTime;

    // Check if timeline time is within any clip (gap = show black)
    const inClip = !clips || clips.length === 0 || clips.some(c => tlTime >= c.start_time && tlTime <= c.end_time);

    if (!inClip) {
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else if (zoomEnabled) {
      const currentTimeUs = video.currentTime * 1_000_000;
      const mouseEvent = findMouseEvent(currentTimeUs);
      if (mouseEvent) {
        const sf = 2;
        const mpx = mouseEvent.x * sf;
        const mpy = mouseEvent.y * sf;
        const vp = zoomCalcRef.current.compute(mpx, mpy, 1 / 60);
        ctx.drawImage(video, vp.srcX, vp.srcY, vp.srcW, vp.srcH, 0, 0, canvas.width, canvas.height);
        const cx = ((mpx - vp.srcX) / vp.srcW) * canvas.width;
        const cy = ((mpy - vp.srcY) / vp.srcH) * canvas.height;
        drawCursor(ctx, cx, cy);
      } else {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      }
    } else {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    }

    // Draw all active subtitles (use timeline time, not source time)
    const time = tlTime;
    const newBounds: SubtitleBounds[] = [];
    const { sx, sy } = getCSSScale();

    for (let i = 0; i < subtitles.length; i++) {
      const sub = subtitles[i];
      if (time >= sub.start_time && time <= sub.end_time) {
        const bounds = drawStyledSubtitle(ctx, sub, canvas.width, canvas.height);
        const style = getStyle(sub);
        newBounds.push({
          index: i,
          x: bounds.x / sx, y: bounds.y / sy,
          w: bounds.w / sx, h: bounds.h / sy,
          rotation: style.rotation,
        });

        // Draw selection handles for selected subtitle
        if (selectedSubtitleIndex === i) {
          drawSelectionHandles(ctx, bounds, style, canvas.width, canvas.height);
        }
      }
    }
    subtitleBoundsRef.current = newBounds;
  }, [videoRef, zoomConfig, zoomEnabled, findMouseEvent, clips, subtitles, selectedSubtitleIndex, drawCursor, drawStyledSubtitle, drawSelectionHandles, getCSSScale]);

  useEffect(() => {
    if (zoomCalcRef.current) zoomCalcRef.current.updateConfig(zoomConfig);
  }, [zoomConfig]);

  useEffect(() => { zoomCalcRef.current = null; }, [videoRef]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onLoaded = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0)
        setVideoDims({ w: video.videoWidth, h: video.videoHeight });
    };
    video.addEventListener("loadedmetadata", onLoaded);
    if (video.videoWidth > 0) onLoaded();
    return () => video.removeEventListener("loadedmetadata", onLoaded);
  }, [videoRef]);

  // Render loop driven by isPlaying prop (not video play/pause events).
  // This ensures we keep rendering during gaps (video paused, show black).
  useEffect(() => {
    if (!isPlaying) {
      cancelAnimationFrame(animFrameRef.current);
      drawFrame(); // draw current state when stopped
      return;
    }
    const loop = () => {
      drawFrame();
      animFrameRef.current = requestAnimationFrame(loop);
    };
    animFrameRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [isPlaying, drawFrame]);

  // Redraw on seek or when subtitles/selection change while paused
  useEffect(() => {
    if (!isPlaying) drawFrame();
  }, [timelineTime, subtitles, selectedSubtitleIndex, drawFrame, isPlaying]);

  // Redraw after video seek completes (for accurate frame)
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onSeeked = () => { drawFrame(); };
    video.addEventListener("seeked", onSeeked);
    return () => video.removeEventListener("seeked", onSeeked);
  }, [drawFrame, videoRef]);

  // --- Overlay mouse interaction ---
  const hitTest = useCallback((cssX: number, cssY: number): { index: number; handle: HandleType } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const { sx, sy } = getCSSScale();

    // Check selected subtitle handles first
    if (selectedSubtitleIndex !== null) {
      const b = subtitleBoundsRef.current.find(b => b.index === selectedSubtitleIndex);
      if (b) {
        const sub = subtitles[selectedSubtitleIndex];
        if (sub) {
          const style = getStyle(sub);
          const cxN = style.x * canvas.width / sx;
          const cyN = style.y * canvas.height / sy;
          const hw = b.w / 2 + 8;
          const hh = b.h / 2 + 8;

          // Rotation handle
          const rotY = cyN - hh - 24;
          if (Math.hypot(cssX - cxN, cssY - rotY) < 10) return { index: selectedSubtitleIndex, handle: "rotate" };

          // Corner handles
          const corners: [number, number, HandleType][] = [
            [cxN - hw, cyN - hh, "tl"], [cxN + hw, cyN - hh, "tr"],
            [cxN - hw, cyN + hh, "bl"], [cxN + hw, cyN + hh, "br"],
          ];
          for (const [hx, hy, ht] of corners) {
            if (Math.abs(cssX - hx) < 8 && Math.abs(cssY - hy) < 8) return { index: selectedSubtitleIndex, handle: ht };
          }

          // Midpoint handles
          const mids: [number, number, HandleType][] = [
            [cxN, cyN - hh, "t"], [cxN, cyN + hh, "b"],
            [cxN - hw, cyN, "l"], [cxN + hw, cyN, "r"],
          ];
          for (const [hx, hy, ht] of mids) {
            if (Math.abs(cssX - hx) < 8 && Math.abs(cssY - hy) < 8) return { index: selectedSubtitleIndex, handle: ht };
          }
        }
      }
    }

    // Hit test subtitle bodies (reverse order = top-most first)
    for (let i = subtitleBoundsRef.current.length - 1; i >= 0; i--) {
      const b = subtitleBoundsRef.current[i];
      if (cssX >= b.x && cssX <= b.x + b.w && cssY >= b.y && cssY <= b.y + b.h) {
        return { index: b.index, handle: "move" };
      }
    }
    return null;
  }, [selectedSubtitleIndex, subtitles, getCSSScale]);

  const handleOverlayMouseDown = useCallback((e: React.MouseEvent) => {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;

    const hit = hitTest(cssX, cssY);
    if (hit) {
      e.preventDefault();
      onSubtitleSelect(hit.index);
      const sub = subtitles[hit.index];
      if (sub) {
        setDragging({
          type: hit.handle,
          index: hit.index,
          startMouseX: cssX,
          startMouseY: cssY,
          startStyle: getStyle(sub),
        });
      }
    } else {
      onSubtitleSelect(null);
    }
  }, [hitTest, subtitles, onSubtitleSelect]);

  const handleOverlayMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    const rect = overlayRef.current?.getBoundingClientRect();
    const canvas = canvasRef.current;
    if (!rect || !canvas) return;
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    const dx = cssX - dragging.startMouseX;
    const dy = cssY - dragging.startMouseY;
    const s = dragging.startStyle;

    const normDx = dx / rect.width;
    const normDy = dy / rect.height;

    let newStyle = { ...s };

    switch (dragging.type) {
      case "move":
        newStyle.x = Math.max(0.05, Math.min(0.95, s.x + normDx));
        newStyle.y = Math.max(0.05, Math.min(0.95, s.y + normDy));
        break;
      case "tl": case "tr": case "bl": case "br": {
        const dist0 = Math.hypot(dragging.startMouseX - s.x * rect.width, dragging.startMouseY - s.y * rect.height);
        const dist1 = Math.hypot(cssX - s.x * rect.width, cssY - s.y * rect.height);
        newStyle.scale = Math.max(0.1, Math.min(5, s.scale * (dist1 / Math.max(dist0, 1))));
        break;
      }
      case "t": case "b":
        newStyle.scale = Math.max(0.1, Math.min(5, s.scale * (1 + dy / 100 * (dragging.type === "t" ? -1 : 1))));
        break;
      case "l": case "r":
        newStyle.scale = Math.max(0.1, Math.min(5, s.scale * (1 + dx / 100 * (dragging.type === "l" ? -1 : 1))));
        break;
      case "rotate": {
        const centerX = s.x * rect.width;
        const centerY = s.y * rect.height;
        const angle0 = Math.atan2(dragging.startMouseY - centerY, dragging.startMouseX - centerX);
        const angle1 = Math.atan2(cssY - centerY, cssX - centerX);
        newStyle.rotation = s.rotation + ((angle1 - angle0) * 180) / Math.PI;
        break;
      }
    }

    onSubtitleStyleChange(dragging.index, newStyle);
  }, [dragging, onSubtitleStyleChange]);

  const handleOverlayMouseUp = useCallback(() => {
    setDragging(null);
  }, []);

  // Cursor style based on hover
  const [cursorStyle, setCursorStyle] = useState("default");
  const handleOverlayHover = useCallback((e: React.MouseEvent) => {
    if (dragging) return;
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect) return;
    const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) { setCursorStyle("default"); return; }
    const cursorMap: Record<HandleType, string> = {
      move: "move", tl: "nwse-resize", tr: "nesw-resize",
      bl: "nesw-resize", br: "nwse-resize",
      t: "ns-resize", b: "ns-resize", l: "ew-resize", r: "ew-resize",
      rotate: "crosshair",
    };
    setCursorStyle(cursorMap[hit.handle]);
  }, [dragging, hitTest]);

  const canvasWidth = videoDims ? Math.min(width, videoDims.w) : width;
  const canvasHeight = videoDims
    ? Math.round(canvasWidth * (videoDims.h / videoDims.w))
    : height;

  return (
    <div
      className="relative max-w-full max-h-full"
      style={{ aspectRatio: `${canvasWidth} / ${canvasHeight}` }}
    >
      <canvas
        ref={canvasRef}
        width={canvasWidth}
        height={canvasHeight}
        className="rounded-lg bg-black w-full h-full"
      />
      {/* Transparent overlay for subtitle interaction */}
      <div
        ref={overlayRef}
        className="absolute inset-0 rounded-lg"
        style={{ cursor: cursorStyle }}
        onMouseDown={handleOverlayMouseDown}
        onMouseMove={dragging ? handleOverlayMouseMove : handleOverlayHover}
        onMouseUp={handleOverlayMouseUp}
        onMouseLeave={handleOverlayMouseUp}
      />
    </div>
  );
}
