import { useRef, useEffect, useCallback, useState } from "react";
import { cn } from "@/lib/utils";
import type { Clip, Subtitle, ZoomSegment } from "@/lib/ipc";
import { Scissors, Trash2, Subtitles, Eye, Grid3X3, Maximize2, Keyboard } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

interface TimelineProps {
  duration: number;
  sourceDuration: number;
  currentTime: number;
  waveform: number[];
  clips: Clip[];
  thumbnails?: Map<number, ImageBitmap>;
  subtitles: Subtitle[];
  selectedSubtitleIndex: number | null;
  onSubtitleSelect: (index: number | null) => void;
  zoomSegments: ZoomSegment[];
  selectedZoomSegmentIndex: number | null;
  onZoomSegmentSelect: (index: number | null) => void;
  onZoomSegmentsChange: (segments: ZoomSegment[]) => void;
  onSeek: (time: number) => void;
  onClipsChange: (clips: Clip[]) => void;
  onSubtitlesChange: (subtitles: Subtitle[]) => void;
  onSplit: () => void;
  showGrid?: boolean;
  onShowGridChange?: (show: boolean) => void;
  /** Returns the mouse screen position at a given source time (seconds), or null. */
  getMouseAtSourceTime?: (sourceTimeSecs: number) => { x: number; y: number } | null;
  className?: string;
}

const TRACK_HEIGHT = 32;
const CLIP_HEIGHT = 52; // Video clip element height
const RULER_HEIGHT = 28;
const TRACK_GAP = 6;
const CANVAS_PAD_LEFT = 8; // Left padding inside canvas (avoids playhead clipping)
const TRACK_PAD_TOP = 8;  // Space between ruler and first track

/** Compute distinct sorted video track IDs from clips. Always includes track 0. */
function getVideoTrackIds(clips: Clip[]): number[] {
  const ids = new Set<number>();
  ids.add(0);
  for (const c of clips) ids.add(c.track_id ?? 0);
  return Array.from(ids).sort((a, b) => a - b);
}

/** Get Y position for a video track */
function videoTrackY(trackIndex: number): number {
  return RULER_HEIGHT + TRACK_PAD_TOP + trackIndex * (CLIP_HEIGHT + TRACK_GAP);
}

/** Y offsets below video tracks are computed dynamically in draw code */

type DragType =
  | "playhead"
  | "clip-start" | "clip-end" | "clip-move"
  | "subtitle-start" | "subtitle-end" | "subtitle-move"
  | "zoom-start" | "zoom-end" | "zoom-move";

/** Draw rounded rect on canvas */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  if (w <= 0 || h <= 0) return;
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

export function Timeline({
  duration,
  sourceDuration,
  currentTime,
  waveform,
  clips,
  thumbnails,
  subtitles,
  selectedSubtitleIndex,
  onSubtitleSelect,
  zoomSegments,
  selectedZoomSegmentIndex,
  onZoomSegmentSelect,
  onZoomSegmentsChange,
  onSeek,
  onClipsChange,
  onSubtitlesChange,
  onSplit,
  showGrid: showGridProp,
  onShowGridChange,
  getMouseAtSourceTime,
  className,
}: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [containerHeight, setContainerHeight] = useState(200);
  const [zoom, setZoom] = useState(1);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [dragging, setDragging] = useState<{
    type: DragType;
    index: number;
    startX: number;
    startTime: number;
  } | null>(null);
  const [selectedClip, setSelectedClip] = useState<number | null>(null);
  const [canvasCursor, setCanvasCursor] = useState("crosshair");
  // Use external grid state if provided, otherwise local fallback
  const [localShowGrid, setLocalShowGrid] = useState(false);
  const showGrid = showGridProp ?? localShowGrid;
  const setShowGrid = onShowGridChange ?? setLocalShowGrid;

  // Popover state for double-click text edit
  const [popover, setPopover] = useState<{
    index: number;
    x: number;
    y: number;
  } | null>(null);
  const popoverInputRef = useRef<HTMLInputElement>(null);

  // Track container size via ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setContainerHeight(entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const containerWidth = containerRef.current?.clientWidth || 800;
  const pixelsPerSecond = Math.max(containerWidth / duration, 20) * zoom;
  const totalWidth = Math.max(duration * pixelsPerSecond, containerWidth);
  const videoTrackIds = getVideoTrackIds(clips);
  const videoTrackCount = videoTrackIds.length;
  const totalTracks = videoTrackCount + 3; // + zoom + subtitle + audio
  const canvasHeight = Math.max(RULER_HEIGHT + TRACK_PAD_TOP + (TRACK_HEIGHT + TRACK_GAP) * totalTracks + TRACK_PAD_TOP, containerHeight);

  const timeToX = useCallback(
    (time: number) => time * pixelsPerSecond - scrollLeft + CANVAS_PAD_LEFT,
    [pixelsPerSecond, scrollLeft]
  );

  const xToTime = useCallback(
    (x: number) => Math.max(0, (x - CANVAS_PAD_LEFT + scrollLeft) / pixelsPerSecond),
    [pixelsPerSecond, scrollLeft]
  );

  // Draw timeline
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(containerWidth * dpr);
    const ch = Math.round(canvasHeight * dpr);
    if (cw <= 0 || ch <= 0 || !isFinite(cw) || !isFinite(ch)) return;
    canvas.width = cw;
    canvas.height = ch;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, containerWidth, canvasHeight);

    // --- Ruler ---
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fillRect(0, RULER_HEIGHT - 0.5, containerWidth, 0.5);

    ctx.fillStyle = "#6e6e6e";
    ctx.font = "10px -apple-system, 'Inter', sans-serif";
    ctx.textAlign = "center";

    const step = getTimeStep(pixelsPerSecond);
    const startTime = scrollLeft / pixelsPerSecond;
    const endTime = (scrollLeft + containerWidth) / pixelsPerSecond;
    const divisions = 8;
    const subStep = step / divisions;

    for (let t = Math.floor(startTime / step) * step; t <= endTime; t += step) {
      const x = timeToX(t);
      if (x < -50 || x > containerWidth + 50) continue;

      // Major tick + label
      ctx.fillStyle = "#6e6e6e";
      ctx.fillRect(x, RULER_HEIGHT - 10, 0.5, 10);
      ctx.fillText(formatTimeRuler(t), x, RULER_HEIGHT - 14);

      // Sub-ticks
      for (let st = 1; st < divisions; st++) {
        const sx = timeToX(t + st * subStep);
        if (sx < 0 || sx > containerWidth) continue;
        if (st === divisions / 2) {
          // Half-step tick (taller)
          ctx.fillStyle = "rgba(255,255,255,0.2)";
          ctx.fillRect(sx, RULER_HEIGHT - 7, 0.5, 7);
        } else {
          ctx.fillStyle = "rgba(255,255,255,0.1)";
          ctx.fillRect(sx, RULER_HEIGHT - 4, 0.5, 4);
        }
      }
    }

    // --- Video tracks ---
    const thumbInterval = 2;
    const CLIP_RADIUS = 8;
    const CLIP_PAD_X = 8;  // left/right inner padding (drag handle zone)
    const CLIP_PAD_Y = 2;  // top/bottom inner padding
    const HANDLE_LINE_H = 12;

    for (let ti = 0; ti < videoTrackIds.length; ti++) {
      const trackId = videoTrackIds[ti];
      const tY = videoTrackY(ti);

      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        if ((clip.track_id ?? 0) !== trackId) continue;
        const x1 = timeToX(clip.start_time);
        const x2 = timeToX(clip.end_time);
        const w = x2 - x1;
        if (x2 < 0 || x1 > containerWidth) continue;

        const isSelected = selectedClip === i;
        const clipTop = tY;

        ctx.save();

        // Parent container background
        roundRect(ctx, x1, clipTop, w, CLIP_HEIGHT, CLIP_RADIUS);
        ctx.fillStyle = isSelected ? "#5B5BD6" : "#313131";
        ctx.fill();

        // Thumbnail filmstrip inside (inset by padding)
        const innerX = x1 + CLIP_PAD_X;
        const innerY = clipTop + CLIP_PAD_Y;
        const innerW = w - CLIP_PAD_X * 2;
        const innerH = CLIP_HEIGHT - CLIP_PAD_Y * 2;

        if (innerW > 0) {
          if (thumbnails && thumbnails.size > 0) {
            ctx.save();
            roundRect(ctx, innerX, innerY, innerW, innerH, CLIP_RADIUS);
            ctx.clip();

            // Fill behind thumbnails
            ctx.fillStyle = isSelected ? "#5B5BD6" : "#313131";
            ctx.fillRect(innerX, innerY, innerW, innerH);

            // Tile thumbnails across the inner container, preserving aspect ratio (cover style)
            const srcStart = clip.media_offset;
            const srcEnd = clip.media_offset + (clip.end_time - clip.start_time);
            const firstThumb = Math.floor(srcStart / thumbInterval) * thumbInterval;
            for (let t = firstThumb; t < srcEnd; t += thumbInterval) {
              const bmp = thumbnails.get(t);
              if (!bmp) continue;
              const tlTime = clip.start_time + (t - clip.media_offset);
              const tx = timeToX(tlTime);
              const tw = thumbInterval * pixelsPerSecond;

              if (tw <= 0 || innerH <= 0) continue;
              // "Cover" draw: scale bitmap to fill tw×innerH without stretching
              const bmpAspect = bmp.width / bmp.height;
              const slotAspect = tw / innerH;
              let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height;
              if (bmpAspect > slotAspect) {
                // Bitmap is wider — crop sides
                sw = bmp.height * slotAspect;
                sx = (bmp.width - sw) / 2;
              } else {
                // Bitmap is taller — crop top/bottom
                sh = bmp.width / slotAspect;
                sy = (bmp.height - sh) / 2;
              }
              if (sw <= 0 || sh <= 0) continue;
              ctx.globalAlpha = 0.9;
              ctx.drawImage(bmp, sx, sy, sw, sh, tx, innerY, tw, innerH);
            }
            ctx.globalAlpha = 1.0;
            ctx.restore();
          } else {
            // No thumbnails: fill inner with subtle accent
            ctx.save();
            roundRect(ctx, innerX, innerY, innerW, innerH, CLIP_RADIUS);
            ctx.fillStyle = isSelected ? "#6B6BD8" : "#3a3a3a";
            ctx.globalAlpha = 0.5;
            ctx.fill();
            ctx.globalAlpha = 1.0;
            ctx.restore();
          }
        }

        // Parent container outside border (1px)
        roundRect(ctx, x1 + 0.5, clipTop + 0.5, w - 1, CLIP_HEIGHT - 1, CLIP_RADIUS);
        ctx.strokeStyle = isSelected ? "rgba(177, 169, 255, 0.7)" : "rgba(255, 255, 255, 0.16)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // Left drag handle line (centered in left padding zone)
        const handleColor = isSelected ? "#B1A9FF" : "#6E6E6E";
        const handleLineY = clipTop + (CLIP_HEIGHT - HANDLE_LINE_H) / 2;
        ctx.fillStyle = handleColor;
        ctx.fillRect(x1 + CLIP_PAD_X / 2 - 0.5, handleLineY, 1, HANDLE_LINE_H);

        // Right drag handle line (centered in right padding zone)
        ctx.fillRect(x2 - CLIP_PAD_X / 2 - 0.5, handleLineY, 1, HANDLE_LINE_H);

        ctx.restore();
      }
    }

    // Adjust Y calculation for video tracks being taller
    const videoTrackTotalHeight = videoTrackCount * (CLIP_HEIGHT + TRACK_GAP);
    const postVideoY = RULER_HEIGHT + TRACK_PAD_TOP + videoTrackTotalHeight;

    // --- Subtitle track ---
    const subY = postVideoY;
    for (let i = 0; i < subtitles.length; i++) {
      const sub = subtitles[i];
      const x1 = timeToX(sub.start_time);
      const x2 = timeToX(sub.end_time);
      if (x2 < 0 || x1 > containerWidth) continue;
      const isSelected = selectedSubtitleIndex === i;
      const w = x2 - x1;

      ctx.save();
      roundRect(ctx, x1, subY, w, TRACK_HEIGHT, 16);
      ctx.fillStyle = isSelected ? "#5b5bd6" : "#313131";
      ctx.fill();
      ctx.strokeStyle = isSelected ? "rgba(177,169,255,0.7)" : "rgba(255,255,255,0.16)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // Subtitle icon (text lines)
      const iconX = x1 + 12;
      const iconY = subY + 8;
      ctx.fillStyle = isSelected ? "#b1a9ff" : "#6e6e6e";
      ctx.fillRect(iconX, iconY, 10, 1.5);
      ctx.fillRect(iconX, iconY + 4, 8, 1.5);
      ctx.fillRect(iconX, iconY + 8, 10, 1.5);
      ctx.fillRect(iconX + 2, iconY + 12, 6, 1.5);

      // Text label
      ctx.fillStyle = isSelected ? "#b1a9ff" : "#6e6e6e";
      ctx.font = "12px -apple-system, 'Inter', sans-serif";
      ctx.textAlign = "left";
      const textW = w - 36;
      if (textW > 10) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x1 + 30, subY, textW, TRACK_HEIGHT);
        ctx.clip();
        ctx.fillText(sub.text || "(empty)", x1 + 30, subY + TRACK_HEIGHT / 2 + 4);
        ctx.restore();
      }
      ctx.restore();
    }

    // --- Audio/Music track ---
    const audioY = postVideoY + TRACK_HEIGHT + TRACK_GAP;
    if (waveform.length > 0) {
      // Draw music pill
      const waveStart = 0;
      const waveEnd = sourceDuration;
      const wx1 = timeToX(waveStart);
      const wx2 = timeToX(waveEnd);
      const ww = wx2 - wx1;
      if (ww > 0) {
        ctx.save();
        roundRect(ctx, wx1, audioY, ww, TRACK_HEIGHT, 16);
        ctx.fillStyle = "#313131";
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.16)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // Music icon
        ctx.fillStyle = "#6e6e6e";
        ctx.font = "11px -apple-system, 'Inter', sans-serif";
        ctx.textAlign = "left";

        // Waveform inside pill
        ctx.save();
        roundRect(ctx, wx1, audioY, ww, TRACK_HEIGHT, 16);
        ctx.clip();
        ctx.fillStyle = "rgba(110,110,110,0.4)";
        const samplesPerPixel = waveform.length / totalWidth;
        for (let px = Math.max(0, wx1); px < Math.min(containerWidth, wx2); px++) {
          const sampleIdx = Math.floor((px + scrollLeft) * samplesPerPixel);
          if (sampleIdx >= 0 && sampleIdx < waveform.length) {
            const amp = waveform[sampleIdx];
            const barH = amp * (TRACK_HEIGHT - 8);
            ctx.fillRect(px, audioY + TRACK_HEIGHT / 2 - barH / 2, 1, Math.max(barH, 1));
          }
        }
        ctx.restore();
        ctx.restore();
      }
    }

    // --- Zoom/Focus track ---
    const focusY = audioY + TRACK_HEIGHT + TRACK_GAP;
    for (let i = 0; i < zoomSegments.length; i++) {
      const seg = zoomSegments[i];
      const x1 = timeToX(seg.start_time);
      const x2 = timeToX(seg.end_time);
      if (x2 < 0 || x1 > containerWidth) continue;
      const isSelected = selectedZoomSegmentIndex === i;
      const w = x2 - x1;

      ctx.save();
      roundRect(ctx, x1, focusY, w, TRACK_HEIGHT, 16);
      ctx.fillStyle = "#202248";
      ctx.fill();
      ctx.strokeStyle = isSelected ? "rgba(177,169,255,0.5)" : "rgba(255,255,255,0.12)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // Spotlight icon (circle + rays) — positioned like subtitle icon
      if (w > 30) {
        const cx = x1 + 18;
        const cy = focusY + TRACK_HEIGHT / 2;
        const r = 5;
        const color = isSelected ? "#b1a9ff" : "#6e6e6e";
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        const rayIn = r + 2;
        const rayOut = r + 5;
        for (const [dx, dy] of [[1,1],[1,-1],[-1,1],[-1,-1]]) {
          ctx.beginPath();
          ctx.moveTo(cx + dx * rayIn * 0.707, cy + dy * rayIn * 0.707);
          ctx.lineTo(cx + dx * rayOut * 0.707, cy + dy * rayOut * 0.707);
          ctx.stroke();
        }
      }

      // Zoom level text — same font/position as subtitle text
      if (w > 50) {
        ctx.font = "12px -apple-system, 'Inter', sans-serif";
        ctx.textAlign = "left";
        ctx.fillStyle = isSelected ? "#b1a9ff" : "#6e6e6e";
        ctx.fillText(`${seg.zoom_level.toFixed(1)}×`, x1 + 30, focusY + TRACK_HEIGHT / 2 + 4);
      }

      ctx.restore();
    }

    // --- Playhead ---
    const phx = timeToX(currentTime);
    if (phx >= 0 && phx <= containerWidth) {
      // Vertical line
      ctx.strokeStyle = "#ef4444";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(phx, RULER_HEIGHT);
      ctx.lineTo(phx, canvasHeight);
      ctx.stroke();

      // Red dot at top
      ctx.fillStyle = "#ef4444";
      ctx.beginPath();
      ctx.arc(phx, RULER_HEIGHT - 2, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [
    containerWidth, canvasHeight, duration, currentTime, waveform,
    clips, subtitles, zoomSegments, thumbnails, pixelsPerSecond, scrollLeft, timeToX, totalWidth,
    selectedSubtitleIndex, selectedClip, selectedZoomSegmentIndex, sourceDuration,
  ]);

  // Mouse handlers
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const time = xToTime(x);

      const videoTrackTotalHeight = videoTrackCount * (CLIP_HEIGHT + TRACK_GAP);
      const postVideoY = RULER_HEIGHT + TRACK_PAD_TOP + videoTrackTotalHeight;
      const subY = postVideoY;
      const audioY = postVideoY + TRACK_HEIGHT + TRACK_GAP;
      const focusY = audioY + TRACK_HEIGHT + TRACK_GAP;

      // Zoom/Focus track
      if (y >= focusY && y < focusY + TRACK_HEIGHT) {
        for (let i = 0; i < zoomSegments.length; i++) {
          const seg = zoomSegments[i];
          const x1 = timeToX(seg.start_time);
          const x2 = timeToX(seg.end_time);
          if (Math.abs(x - x1) < 5) {
            onZoomSegmentSelect(i); onSubtitleSelect(null); setSelectedClip(null);
            setDragging({ type: "zoom-start", index: i, startX: x, startTime: seg.start_time });
            return;
          }
          if (Math.abs(x - x2) < 5) {
            onZoomSegmentSelect(i); onSubtitleSelect(null); setSelectedClip(null);
            setDragging({ type: "zoom-end", index: i, startX: x, startTime: seg.end_time });
            return;
          }
          if (x >= x1 && x <= x2) {
            onZoomSegmentSelect(i); onSubtitleSelect(null); setSelectedClip(null);
            setDragging({ type: "zoom-move", index: i, startX: x, startTime: time });
            return;
          }
        }
        onZoomSegmentSelect(null); onSubtitleSelect(null); setPopover(null);
      }

      // Subtitle track
      if (y >= subY && y < subY + TRACK_HEIGHT) {
        for (let i = 0; i < subtitles.length; i++) {
          const sub = subtitles[i];
          const x1 = timeToX(sub.start_time);
          const x2 = timeToX(sub.end_time);
          if (Math.abs(x - x1) < 5) {
            onSubtitleSelect(i); onZoomSegmentSelect(null); setSelectedClip(null);
            setDragging({ type: "subtitle-start", index: i, startX: x, startTime: sub.start_time });
            return;
          }
          if (Math.abs(x - x2) < 5) {
            onSubtitleSelect(i); onZoomSegmentSelect(null); setSelectedClip(null);
            setDragging({ type: "subtitle-end", index: i, startX: x, startTime: sub.end_time });
            return;
          }
          if (x >= x1 && x <= x2) {
            if (e.detail === 2) {
              onSubtitleSelect(i);
              setPopover({ index: i, x: e.clientX - rect.left, y: subY });
              return;
            }
            onSubtitleSelect(i); onZoomSegmentSelect(null); setSelectedClip(null);
            setDragging({ type: "subtitle-move", index: i, startX: x, startTime: time });
            return;
          }
        }
        onSubtitleSelect(null); onZoomSegmentSelect(null); setPopover(null);
      }

      // Video tracks
      const videoBottom = RULER_HEIGHT + TRACK_PAD_TOP + videoTrackCount * (CLIP_HEIGHT + TRACK_GAP);
      if (y >= RULER_HEIGHT + TRACK_PAD_TOP && y < videoBottom) {
        const clickedTrackIndex = Math.floor((y - RULER_HEIGHT - TRACK_PAD_TOP) / (CLIP_HEIGHT + TRACK_GAP));
        const clickedTrackId = videoTrackIds[clickedTrackIndex] ?? 0;

        for (let i = 0; i < clips.length; i++) {
          const clip = clips[i];
          if ((clip.track_id ?? 0) !== clickedTrackId) continue;
          const x1 = timeToX(clip.start_time);
          const x2 = timeToX(clip.end_time);
          if (Math.abs(x - x1) < 5) {
            setSelectedClip(i); onSubtitleSelect(null); onZoomSegmentSelect(null);
            setDragging({ type: "clip-start", index: i, startX: x, startTime: clip.start_time });
            return;
          }
          if (Math.abs(x - x2) < 5) {
            setSelectedClip(i); onSubtitleSelect(null); onZoomSegmentSelect(null);
            setDragging({ type: "clip-end", index: i, startX: x, startTime: clip.end_time });
            return;
          }
          if (x >= x1 && x <= x2) {
            setSelectedClip(i); onSubtitleSelect(null); onZoomSegmentSelect(null);
            setDragging({ type: "clip-move", index: i, startX: x, startTime: time });
            return;
          }
        }
        setSelectedClip(null);
      }

      // Default: seek (keep current selection intact — only clear popover)
      setPopover(null);
      onSeek(time);
      setDragging({ type: "playhead", index: 0, startX: x, startTime: time });
    },
    [xToTime, timeToX, clips, subtitles, zoomSegments, onSeek, onSubtitleSelect, onZoomSegmentSelect, videoTrackCount, videoTrackIds]
  );

  // Get sorted neighbor boundaries for overlap prevention
  const getNeighborBounds = useCallback((items: { start_time: number; end_time: number }[], index: number) => {
    const sorted = items.map((item, i) => ({ ...item, origIndex: i })).sort((a, b) => a.start_time - b.start_time);
    const sortedPos = sorted.findIndex(s => s.origIndex === index);
    const prevEnd = sortedPos > 0 ? sorted[sortedPos - 1].end_time : 0;
    const nextStart = sortedPos < sorted.length - 1 ? sorted[sortedPos + 1].start_time : Infinity;
    return { prevEnd, nextStart };
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left;
      const time = xToTime(x);
      const MIN_DUR = 0.1;

      switch (dragging.type) {
        case "playhead": onSeek(time); break;
        case "clip-start": {
          const trackClips = clips.map((c, i) => ({ ...c, _i: i })).filter(c => (c.track_id ?? 0) === (clips[dragging.index].track_id ?? 0));
          const mappedIdx = trackClips.findIndex(c => c._i === dragging.index);
          const { prevEnd } = getNeighborBounds(trackClips, mappedIdx);
          const clip = clips[dragging.index];
          const minStart = clip.start_time - clip.media_offset;
          const newStart = Math.max(prevEnd, Math.max(minStart, Math.min(time, clip.end_time - MIN_DUR)));
          const startDelta = newStart - clip.start_time;
          const nc = [...clips];
          nc[dragging.index] = { ...clip, start_time: newStart, media_offset: clip.media_offset + startDelta };
          onClipsChange(nc);
          break;
        }
        case "clip-end": {
          const trackClips2 = clips.map((c, i) => ({ ...c, _i: i })).filter(c => (c.track_id ?? 0) === (clips[dragging.index].track_id ?? 0));
          const mappedIdx2 = trackClips2.findIndex(c => c._i === dragging.index);
          const { nextStart } = getNeighborBounds(trackClips2, mappedIdx2);
          const clip = clips[dragging.index];
          const maxEnd = clip.start_time + (sourceDuration - clip.media_offset);
          const newEnd = Math.min(nextStart, Math.min(maxEnd, Math.max(time, clip.start_time + MIN_DUR)));
          const nc = [...clips];
          nc[dragging.index] = { ...clip, end_time: newEnd };
          onClipsChange(nc);
          break;
        }
        case "clip-move": {
          const delta = time - dragging.startTime;
          const clip = clips[dragging.index];
          const dur = clip.end_time - clip.start_time;
          const trackClips3 = clips.map((c, i) => ({ ...c, _i: i })).filter(c => (c.track_id ?? 0) === (clip.track_id ?? 0));
          const mappedIdx3 = trackClips3.findIndex(c => c._i === dragging.index);
          const { prevEnd, nextStart } = getNeighborBounds(trackClips3, mappedIdx3);
          const newStart = Math.max(prevEnd, Math.min(clip.start_time + delta, nextStart - dur));
          const nc = [...clips];
          nc[dragging.index] = { ...clip, start_time: newStart, end_time: newStart + dur };
          onClipsChange(nc);
          setDragging({ ...dragging, startTime: time });
          break;
        }
        case "subtitle-start": {
          const { prevEnd } = getNeighborBounds(subtitles, dragging.index);
          const sub = subtitles[dragging.index];
          const newStart = Math.max(prevEnd, Math.min(time, sub.end_time - MIN_DUR));
          const ns = [...subtitles];
          ns[dragging.index] = { ...sub, start_time: newStart };
          onSubtitlesChange(ns);
          break;
        }
        case "subtitle-end": {
          const { nextStart } = getNeighborBounds(subtitles, dragging.index);
          const sub = subtitles[dragging.index];
          const newEnd = Math.min(nextStart, Math.max(time, sub.start_time + MIN_DUR));
          const ns = [...subtitles];
          ns[dragging.index] = { ...sub, end_time: newEnd };
          onSubtitlesChange(ns);
          break;
        }
        case "subtitle-move": {
          const delta = time - dragging.startTime;
          const sub = subtitles[dragging.index];
          const dur = sub.end_time - sub.start_time;
          const { prevEnd, nextStart } = getNeighborBounds(subtitles, dragging.index);
          const newStart = Math.max(prevEnd, Math.min(sub.start_time + delta, nextStart - dur));
          const ns = [...subtitles];
          ns[dragging.index] = { ...sub, start_time: newStart, end_time: newStart + dur };
          onSubtitlesChange(ns);
          setDragging({ ...dragging, startTime: time });
          break;
        }
        case "zoom-start": {
          const { prevEnd } = getNeighborBounds(zoomSegments, dragging.index);
          const seg = zoomSegments[dragging.index];
          const newStart = Math.max(prevEnd, Math.min(time, seg.end_time - MIN_DUR));
          const nz = [...zoomSegments];
          nz[dragging.index] = { ...seg, start_time: newStart };
          onZoomSegmentsChange(nz);
          break;
        }
        case "zoom-end": {
          const { nextStart } = getNeighborBounds(zoomSegments, dragging.index);
          const seg = zoomSegments[dragging.index];
          const newEnd = Math.min(nextStart, Math.max(time, seg.start_time + MIN_DUR));
          const nz = [...zoomSegments];
          nz[dragging.index] = { ...seg, end_time: newEnd };
          onZoomSegmentsChange(nz);
          break;
        }
        case "zoom-move": {
          const delta = time - dragging.startTime;
          const seg = zoomSegments[dragging.index];
          const dur = seg.end_time - seg.start_time;
          const { prevEnd, nextStart } = getNeighborBounds(zoomSegments, dragging.index);
          const newStart = Math.max(prevEnd, Math.min(seg.start_time + delta, nextStart - dur));
          const nz = [...zoomSegments];
          nz[dragging.index] = { ...seg, start_time: newStart, end_time: newStart + dur };
          onZoomSegmentsChange(nz);
          setDragging({ ...dragging, startTime: time });
          break;
        }
      }
    },
    [dragging, xToTime, clips, subtitles, zoomSegments, duration, sourceDuration, onSeek, onClipsChange, onSubtitlesChange, onZoomSegmentsChange, getNeighborBounds]
  );

  const handleMouseUp = useCallback(() => { setDragging(null); setCanvasCursor("crosshair"); }, []);

  const handleCanvasHover = useCallback(
    (e: React.MouseEvent) => {
      if (dragging) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const videoTrackTotalHeight = videoTrackCount * (CLIP_HEIGHT + TRACK_GAP);
      const postVideoY = RULER_HEIGHT + TRACK_PAD_TOP + videoTrackTotalHeight;
      const subY = postVideoY;
      const audioY = postVideoY + TRACK_HEIGHT + TRACK_GAP;
      const focusY = audioY + TRACK_HEIGHT + TRACK_GAP;

      // Video tracks
      if (y >= RULER_HEIGHT + TRACK_PAD_TOP && y < RULER_HEIGHT + TRACK_PAD_TOP + videoTrackTotalHeight) {
        for (const clip of clips) {
          const x1 = timeToX(clip.start_time);
          const x2 = timeToX(clip.end_time);
          if (Math.abs(x - x1) < 5 || Math.abs(x - x2) < 5) { setCanvasCursor("col-resize"); return; }
          if (x >= x1 && x <= x2) { setCanvasCursor("grab"); return; }
        }
      }
      // Focus track
      if (y >= focusY && y < focusY + TRACK_HEIGHT) {
        for (const seg of zoomSegments) {
          const x1 = timeToX(seg.start_time);
          const x2 = timeToX(seg.end_time);
          if (Math.abs(x - x1) < 5 || Math.abs(x - x2) < 5) { setCanvasCursor("col-resize"); return; }
          if (x >= x1 && x <= x2) { setCanvasCursor("grab"); return; }
        }
      }
      // Subtitle track
      if (y >= subY && y < subY + TRACK_HEIGHT) {
        for (const sub of subtitles) {
          const x1 = timeToX(sub.start_time);
          const x2 = timeToX(sub.end_time);
          if (Math.abs(x - x1) < 5 || Math.abs(x - x2) < 5) { setCanvasCursor("col-resize"); return; }
          if (x >= x1 && x <= x2) { setCanvasCursor("grab"); return; }
        }
      }
      setCanvasCursor("crosshair");
    },
    [dragging, clips, subtitles, zoomSegments, timeToX, videoTrackCount]
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setZoom((z) => Math.max(0.5, Math.min(z * (1 - e.deltaY * 0.002), 20)));
      } else {
        setScrollLeft((s) => Math.max(0, Math.min(s + e.deltaX + e.deltaY, totalWidth - containerWidth)));
      }
    },
    [totalWidth, containerWidth]
  );

  // Close popover on click outside
  useEffect(() => {
    if (!popover) return;
    const handle = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-subtitle-popover]")) return;
      setPopover(null);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [popover]);

  useEffect(() => {
    if (popover) popoverInputRef.current?.focus();
  }, [popover]);

  // Add zoom segment at playhead
  const addZoomSegment = useCallback(() => {
    const segDuration = 3;
    const newStart = currentTime;
    const newEnd = Math.min(currentTime + segDuration, duration);
    const overlaps = zoomSegments.some(s => newStart < s.end_time && newEnd > s.start_time);
    if (overlaps) return;
    // Try to anchor at the mouse position at segment start time
    const mousePos = getMouseAtSourceTime?.(currentTime);
    const newSeg: ZoomSegment = {
      start_time: newStart, end_time: newEnd,
      zoom_level: 2.0, follow_speed: 0.15, padding: 100,
      follow_mouse: false,
      ...(mousePos ? { anchor_x: mousePos.x, anchor_y: mousePos.y } : {}),
    };
    const newSegs = [...zoomSegments, newSeg].sort((a, b) => a.start_time - b.start_time);
    onZoomSegmentsChange(newSegs);
    onZoomSegmentSelect(newSegs.findIndex(s => s.start_time === newStart));
  }, [currentTime, duration, zoomSegments, onZoomSegmentsChange, onZoomSegmentSelect, getMouseAtSourceTime]);

  const hasSelection = selectedClip !== null || selectedSubtitleIndex !== null || selectedZoomSegmentIndex !== null;

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-1.5">
        {/* Left: action buttons */}
        <div className="flex items-center gap-2">
          <ToolbarButton icon={<Scissors className="size-4" />} onClick={onSplit} title="Split (S)" />

          <ToolbarButton icon={<Trash2 className="size-4" />} onClick={() => {
            if (selectedZoomSegmentIndex !== null) {
              onZoomSegmentsChange(zoomSegments.filter((_, i) => i !== selectedZoomSegmentIndex));
              onZoomSegmentSelect(null);
            } else if (selectedSubtitleIndex !== null) {
              onSubtitlesChange(subtitles.filter((_, i) => i !== selectedSubtitleIndex));
              onSubtitleSelect(null);
            } else if (selectedClip !== null) {
              onClipsChange(clips.filter((_, i) => i !== selectedClip));
              setSelectedClip(null);
            }
          }} disabled={!hasSelection} title="Delete (Backspace)" />
          <ToolbarButton icon={<Subtitles className="size-4" />} onClick={() => {
            const newSub: Subtitle = {
              start_time: currentTime,
              end_time: Math.min(currentTime + 3, duration),
              text: "New subtitle",
            };
            onSubtitlesChange([...subtitles, newSub]);
          }} title="Add subtitle" />
          <ToolbarButton icon={<Eye className="size-4" />} onClick={addZoomSegment} title="Add zoom" />
        </div>

        {/* Center: timecode */}
        <div className="text-xs tracking-wider whitespace-nowrap">
          <span className="text-[#b1a9ff]">{formatTime(currentTime)}</span>
          <span className="text-[#6e6e6e] mx-2">/</span>
          <span className="text-[#6e6e6e]">{formatTime(clips.length > 0 ? Math.max(...clips.map(c => c.end_time)) : sourceDuration)}</span>
        </div>

        {/* Right: view buttons */}
        <div className="flex items-center gap-2">
          <ToolbarButton
            icon={<Grid3X3 className="size-4" />}
            active={showGrid}
            onClick={() => setShowGrid(!showGrid)}
            title="Toggle grid"
          />
          <ToolbarButton icon={<Maximize2 className="size-4" />} onClick={() => {
            // Toggle fullscreen on the document element
            if (document.fullscreenElement) {
              document.exitFullscreen();
            } else {
              document.documentElement.requestFullscreen();
            }
          }} title="Fullscreen" />
          <ToolbarButton icon={<Keyboard className="size-4" />} onClick={() => window.dispatchEvent(new Event("toggle-shortcuts-help"))} title="Keyboard shortcuts" />
        </div>
      </div>

      {/* Canvas */}
      <div
        ref={containerRef}
        className="relative overflow-hidden flex-1 min-h-0"
        style={{ cursor: canvasCursor }}
        onWheel={handleWheel}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("application/x-session-id")) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={(e) => {
          const sessionId = e.dataTransfer.getData("application/x-session-id");
          if (!sessionId) return;
          e.preventDefault();
          const rect = containerRef.current?.getBoundingClientRect();
          if (!rect) return;
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          const dropTime = xToTime(x);
          let targetTrackId = 0;
          const videoBottom = RULER_HEIGHT + TRACK_PAD_TOP + videoTrackCount * (CLIP_HEIGHT + TRACK_GAP);
          if (y >= RULER_HEIGHT + TRACK_PAD_TOP && y < videoBottom) {
            const trackIdx = Math.floor((y - RULER_HEIGHT - TRACK_PAD_TOP) / (CLIP_HEIGHT + TRACK_GAP));
            targetTrackId = videoTrackIds[trackIdx] ?? 0;
          } else {
            targetTrackId = Math.max(...videoTrackIds, 0) + 1;
          }
          const newClip: Clip = {
            start_time: dropTime, end_time: dropTime + 10, media_offset: 0,
            track_id: targetTrackId, source_session_id: sessionId,
          };
          onClipsChange([...clips, newClip]);
        }}
      >
        <canvas
          ref={canvasRef}
          style={{ width: "100%", height: "100%" }}
          onMouseDown={handleMouseDown}
          onMouseMove={dragging ? handleMouseMove : handleCanvasHover}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        />

        {/* Floating popover for subtitle text editing */}
        {popover && popover.index < subtitles.length && (
          <div
            data-subtitle-popover
            className="absolute z-10 backdrop-blur-[60px] bg-[rgba(25,25,25,0.9)] border border-white/[0.12] rounded-xl shadow-lg p-3 flex flex-col gap-2"
            style={{
              left: Math.min(popover.x, containerWidth - 260),
              top: popover.y + TRACK_HEIGHT + 4,
              width: 250,
            }}
          >
            <input
              ref={popoverInputRef}
              className="w-full bg-white/[0.06] rounded-[10px] px-2 py-1.5 text-sm text-white border-none outline-none"
              value={subtitles[popover.index].text}
              onChange={(e) => {
                const ns = [...subtitles];
                ns[popover.index] = { ...ns[popover.index], text: e.target.value };
                onSubtitlesChange(ns);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "Escape") setPopover(null);
              }}
            />
            <div className="flex justify-between">
              <span className="text-[10px] text-[#6e6e6e]">
                {formatTime(subtitles[popover.index].start_time)} - {formatTime(subtitles[popover.index].end_time)}
              </span>
              <button
                className="text-[10px] text-red-400 hover:text-red-300"
                onClick={() => {
                  onSubtitlesChange(subtitles.filter((_, i) => i !== popover.index));
                  onSubtitleSelect(null);
                  setPopover(null);
                }}
              >
                Delete
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Glass-morphism toolbar button matching the design */
function ToolbarButton({
  icon, onClick, title, active, disabled,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  title?: string;
  active?: boolean;
  disabled?: boolean;
}) {
  const btn = (
    <button
      className={cn(
        "flex items-center justify-center size-8 rounded-full backdrop-blur-[60px] transition-colors",
        active
          ? "bg-[rgba(91,91,214,0.16)] text-[#b1a9ff]"
          : "bg-white/[0.04] text-white/60 hover:bg-white/[0.08] hover:text-white/80",
        disabled && "opacity-30 pointer-events-none"
      )}
      onClick={onClick}
      disabled={disabled}
    >
      {icon}
    </button>
  );

  if (!title) return btn;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{btn}</TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}

function getTimeStep(pxPerSec: number): number {
  if (pxPerSec > 400) return 0.25;
  if (pxPerSec > 200) return 0.5;
  if (pxPerSec > 100) return 1;
  if (pxPerSec > 50) return 2;
  if (pxPerSec > 25) return 5;
  if (pxPerSec > 12) return 10;
  return 30;
}

function formatTime(secs: number, fps = 30): string {
  const totalSeconds = Math.max(0, secs);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const frames = Math.floor((totalSeconds % 1) * fps);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}:${frames.toString().padStart(2, "0")}`;
}

function formatTimeRuler(secs: number): string {
  const totalSeconds = Math.max(0, secs);
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  const frac = totalSeconds % 1;
  const mm = m.toString().padStart(2, "0");
  const ss = s.toString().padStart(2, "0");
  if (frac > 0.01) {
    const frames = Math.round(frac * 30);
    return `${mm}:${ss}:${frames.toString().padStart(2, "0")}f`;
  }
  return `${mm}:${ss}`;
}
