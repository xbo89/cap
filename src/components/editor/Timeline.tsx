import { useRef, useEffect, useCallback, useState } from "react";
import { cn } from "@/lib/utils";
import type { Clip, Subtitle } from "@/lib/ipc";
import { ZoomIn, ZoomOut, Scissors, Plus, Trash2 } from "lucide-react";

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
  onSeek: (time: number) => void;
  onClipsChange: (clips: Clip[]) => void;
  onSubtitlesChange: (subtitles: Subtitle[]) => void;
  onSplit: () => void;
  className?: string;
}

const TRACK_HEIGHT = 32;
const RULER_HEIGHT = 24;

/** Compute distinct sorted video track IDs from clips. Always includes track 0. */
function getVideoTrackIds(clips: Clip[]): number[] {
  const ids = new Set<number>();
  ids.add(0);
  for (const c of clips) ids.add(c.track_id ?? 0);
  return Array.from(ids).sort((a, b) => a - b);
}

/** Get Y position for a video track by its index in the sorted track list */
function videoTrackY(trackIndex: number): number {
  return RULER_HEIGHT + trackIndex * TRACK_HEIGHT;
}

/** Get subtitle track Y given the number of video tracks */
function subtitleTrackY(videoTrackCount: number): number {
  return RULER_HEIGHT + videoTrackCount * TRACK_HEIGHT;
}

/** Get audio track Y given the number of video tracks */
function audioTrackY(videoTrackCount: number): number {
  return RULER_HEIGHT + (videoTrackCount + 1) * TRACK_HEIGHT;
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
  onSeek,
  onClipsChange,
  onSubtitlesChange,
  onSplit,
  className,
}: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(1);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [dragging, setDragging] = useState<{
    type: "playhead" | "clip-start" | "clip-end" | "clip-move" | "subtitle-start" | "subtitle-end" | "subtitle-move";
    index: number;
    startX: number;
    startTime: number;
  } | null>(null);
  const [selectedClip, setSelectedClip] = useState<number | null>(null);
  const [canvasCursor, setCanvasCursor] = useState("crosshair");

  // Popover state for double-click text edit
  const [popover, setPopover] = useState<{
    index: number;
    x: number;
    y: number;
  } | null>(null);
  const popoverInputRef = useRef<HTMLInputElement>(null);

  const containerWidth = containerRef.current?.clientWidth || 800;
  const pixelsPerSecond = Math.max(containerWidth / duration, 20) * zoom;
  const totalWidth = Math.max(duration * pixelsPerSecond, containerWidth);
  const videoTrackIds = getVideoTrackIds(clips);
  const videoTrackCount = videoTrackIds.length;
  const totalTracks = videoTrackCount + 2; // + subtitle + audio
  const canvasHeight = RULER_HEIGHT + TRACK_HEIGHT * totalTracks + 8;

  const timeToX = useCallback(
    (time: number) => time * pixelsPerSecond - scrollLeft,
    [pixelsPerSecond, scrollLeft]
  );

  const xToTime = useCallback(
    (x: number) => Math.max(0, (x + scrollLeft) / pixelsPerSecond),
    [pixelsPerSecond, scrollLeft]
  );

  // Draw timeline
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = containerWidth * dpr;
    canvas.height = canvasHeight * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, containerWidth, canvasHeight);

    // --- Ruler ---
    ctx.fillStyle = "#18181b";
    ctx.fillRect(0, 0, containerWidth, RULER_HEIGHT);
    ctx.fillStyle = "#71717a";
    ctx.font = "10px -apple-system, sans-serif";
    ctx.textAlign = "center";

    const step = getTimeStep(pixelsPerSecond);
    const startTime = scrollLeft / pixelsPerSecond;
    const endTime = (scrollLeft + containerWidth) / pixelsPerSecond;
    for (let t = Math.floor(startTime / step) * step; t <= endTime; t += step) {
      const x = timeToX(t);
      if (x < 0 || x > containerWidth) continue;
      ctx.fillStyle = "#52525b";
      ctx.fillRect(x, RULER_HEIGHT - 6, 1, 6);
      ctx.fillStyle = "#71717a";
      ctx.fillText(formatTime(t), x, RULER_HEIGHT - 10);
    }

    // --- Video tracks (dynamic count) ---
    const thumbInterval = 2;
    const trackColors = ["#1a1a2e", "#1a2a1e", "#2a1a1e", "#1a1a3e"];
    for (let ti = 0; ti < videoTrackIds.length; ti++) {
      const trackId = videoTrackIds[ti];
      const tY = videoTrackY(ti);

      ctx.fillStyle = trackColors[ti % trackColors.length];
      ctx.fillRect(0, tY, containerWidth, TRACK_HEIGHT);

      // Track label
      ctx.fillStyle = "#52525b";
      ctx.font = "9px -apple-system, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(ti === 0 ? "VIDEO" : `V${trackId}`, 4, tY + 14);

      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        if ((clip.track_id ?? 0) !== trackId) continue;
        const x1 = timeToX(clip.start_time);
        const x2 = timeToX(clip.end_time);
        const w = x2 - x1;
        if (x2 < 0 || x1 > containerWidth) continue;

        const clipTop = tY + 2;
        const clipH = TRACK_HEIGHT - 4;

        ctx.fillStyle = selectedClip === i ? "#2563eb" : "#1e3a5f";
        ctx.globalAlpha = 1.0;
        ctx.fillRect(x1, clipTop, w, clipH);

        if (thumbnails && thumbnails.size > 0) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x1, clipTop, w, clipH);
          ctx.clip();

          const srcStart = clip.media_offset;
          const srcEnd = clip.media_offset + (clip.end_time - clip.start_time);
          const firstThumb = Math.floor(srcStart / thumbInterval) * thumbInterval;
          for (let t = firstThumb; t < srcEnd; t += thumbInterval) {
            const bmp = thumbnails.get(t);
            if (!bmp) continue;
            const tlTime = clip.start_time + (t - clip.media_offset);
            const tx = timeToX(tlTime);
            const tw = thumbInterval * pixelsPerSecond;
            ctx.globalAlpha = 0.7;
            ctx.drawImage(bmp, tx, clipTop, tw, clipH);
          }
          ctx.globalAlpha = 1.0;
          ctx.restore();
        }

        if (selectedClip === i) {
          ctx.strokeStyle = "#93c5fd";
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x1, clipTop, w, clipH);
        }
        ctx.fillStyle = "#60a5fa";
        ctx.globalAlpha = 0.8;
        ctx.fillRect(x1, clipTop, 3, clipH);
        ctx.fillRect(x2 - 3, clipTop, 3, clipH);
        ctx.globalAlpha = 1.0;
      }
    }

    // --- Subtitle track ---
    const subY = subtitleTrackY(videoTrackCount);
    ctx.fillStyle = "#18181b";
    ctx.fillRect(0, subY, containerWidth, TRACK_HEIGHT);
    for (let i = 0; i < subtitles.length; i++) {
      const sub = subtitles[i];
      const x1 = timeToX(sub.start_time);
      const x2 = timeToX(sub.end_time);
      if (x2 < 0 || x1 > containerWidth) continue;
      const isSelected = selectedSubtitleIndex === i;
      ctx.fillStyle = isSelected ? "#c084fc" : "#a855f7";
      ctx.globalAlpha = isSelected ? 0.85 : 0.7;
      ctx.fillRect(x1, subY + 4, x2 - x1, TRACK_HEIGHT - 8);
      ctx.globalAlpha = 1.0;
      if (isSelected) {
        ctx.strokeStyle = "#e9d5ff";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x1, subY + 4, x2 - x1, TRACK_HEIGHT - 8);
      }
      ctx.fillStyle = "#fff";
      ctx.font = "10px -apple-system, sans-serif";
      ctx.textAlign = "left";
      const textW = x2 - x1 - 8;
      if (textW > 10) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x1 + 4, subY + 4, textW, TRACK_HEIGHT - 8);
        ctx.clip();
        ctx.fillText(sub.text || "(empty)", x1 + 4, subY + TRACK_HEIGHT / 2 + 3);
        ctx.restore();
      }
    }

    // --- Audio waveform ---
    const audioY = audioTrackY(videoTrackCount);
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, audioY, containerWidth, TRACK_HEIGHT);
    if (waveform.length > 0) {
      ctx.fillStyle = "#22c55e";
      ctx.globalAlpha = 0.7;
      const samplesPerPixel = waveform.length / totalWidth;
      for (let px = 0; px < containerWidth; px++) {
        const sampleIdx = Math.floor((px + scrollLeft) * samplesPerPixel);
        if (sampleIdx >= 0 && sampleIdx < waveform.length) {
          const amp = waveform[sampleIdx];
          const barH = amp * (TRACK_HEIGHT - 4);
          ctx.fillRect(px, audioY + TRACK_HEIGHT / 2 - barH / 2, 1, Math.max(barH, 1));
        }
      }
      ctx.globalAlpha = 1.0;
    }

    // --- Playhead ---
    const phx = timeToX(currentTime);
    if (phx >= 0 && phx <= containerWidth) {
      ctx.strokeStyle = "#ef4444";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(phx, 0);
      ctx.lineTo(phx, canvasHeight);
      ctx.stroke();
      ctx.fillStyle = "#ef4444";
      ctx.beginPath();
      ctx.moveTo(phx - 5, 0);
      ctx.lineTo(phx + 5, 0);
      ctx.lineTo(phx, 8);
      ctx.closePath();
      ctx.fill();
    }

    // Track labels for subtitle and audio
    ctx.fillStyle = "#52525b";
    ctx.font = "9px -apple-system, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("SUBS", 4, subY + 14);
    ctx.fillText("AUDIO", 4, audioY + 14);
  }, [
    containerWidth, canvasHeight, duration, currentTime, waveform,
    clips, subtitles, thumbnails, pixelsPerSecond, scrollLeft, timeToX, totalWidth,
    selectedSubtitleIndex, selectedClip,
  ]);

  // Mouse handlers
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const time = xToTime(x);

      // Subtitle track
      const subY = subtitleTrackY(videoTrackCount);
      if (y >= subY && y < subY + TRACK_HEIGHT) {
        for (let i = 0; i < subtitles.length; i++) {
          const sub = subtitles[i];
          const x1 = timeToX(sub.start_time);
          const x2 = timeToX(sub.end_time);
          if (Math.abs(x - x1) < 5) {
            onSubtitleSelect(i);
            setSelectedClip(null);
            setDragging({ type: "subtitle-start", index: i, startX: x, startTime: sub.start_time });
            return;
          }
          if (Math.abs(x - x2) < 5) {
            onSubtitleSelect(i);
            setSelectedClip(null);
            setDragging({ type: "subtitle-end", index: i, startX: x, startTime: sub.end_time });
            return;
          }
          if (x >= x1 && x <= x2) {
            if (e.detail === 2) {
              // Double-click: show popover for text editing
              onSubtitleSelect(i);
              setPopover({ index: i, x: e.clientX - rect.left, y: subY });
              return;
            }
            // Single click: select + drag
            onSubtitleSelect(i);
            setSelectedClip(null);
            setDragging({ type: "subtitle-move", index: i, startX: x, startTime: time });
            return;
          }
        }
        onSubtitleSelect(null);
        setPopover(null);
      }

      // Video tracks (dynamic)
      const allVideoTop = RULER_HEIGHT;
      const allVideoBottom = RULER_HEIGHT + videoTrackCount * TRACK_HEIGHT;
      if (y >= allVideoTop && y < allVideoBottom) {
        // Determine which track was clicked
        const clickedTrackIndex = Math.floor((y - RULER_HEIGHT) / TRACK_HEIGHT);
        const clickedTrackId = videoTrackIds[clickedTrackIndex] ?? 0;

        for (let i = 0; i < clips.length; i++) {
          const clip = clips[i];
          if ((clip.track_id ?? 0) !== clickedTrackId) continue;
          const x1 = timeToX(clip.start_time);
          const x2 = timeToX(clip.end_time);
          if (Math.abs(x - x1) < 5) {
            setSelectedClip(i);
            onSubtitleSelect(null);
            setDragging({ type: "clip-start", index: i, startX: x, startTime: clip.start_time });
            return;
          }
          if (Math.abs(x - x2) < 5) {
            setSelectedClip(i);
            onSubtitleSelect(null);
            setDragging({ type: "clip-end", index: i, startX: x, startTime: clip.end_time });
            return;
          }
          if (x >= x1 && x <= x2) {
            setSelectedClip(i);
            onSubtitleSelect(null);
            setDragging({ type: "clip-move", index: i, startX: x, startTime: time });
            return;
          }
        }
        setSelectedClip(null);
      }

      // Default: seek
      onSubtitleSelect(null);
      setPopover(null);
      onSeek(time);
      setDragging({ type: "playhead", index: 0, startX: x, startTime: time });
    },
    [xToTime, timeToX, clips, subtitles, onSeek, onSubtitleSelect]
  );

  // Get sorted neighbor boundaries for overlap prevention
  const getNeighborBounds = useCallback((items: { start_time: number; end_time: number }[], index: number) => {
    const sorted = items
      .map((item, i) => ({ ...item, origIndex: i }))
      .sort((a, b) => a.start_time - b.start_time);
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

        // --- Clip trimming: constrain to neighbors on same track ---
        case "clip-start": {
          const trackClips = clips.map((c, i) => ({ ...c, _i: i })).filter(c => (c.track_id ?? 0) === (clips[dragging.index].track_id ?? 0));
          const mappedIdx = trackClips.findIndex(c => c._i === dragging.index);
          const { prevEnd } = getNeighborBounds(trackClips, mappedIdx);
          const clip = clips[dragging.index];
          // Can't trim left beyond source start (media_offset >= 0)
          const minStart = clip.start_time - clip.media_offset;
          const newStart = Math.max(prevEnd, Math.max(minStart, Math.min(time, clip.end_time - MIN_DUR)));
          const startDelta = newStart - clip.start_time;
          const nc = [...clips];
          nc[dragging.index] = {
            ...clip,
            start_time: newStart,
            media_offset: clip.media_offset + startDelta,
          };
          onClipsChange(nc);
          break;
        }
        case "clip-end": {
          const trackClips2 = clips.map((c, i) => ({ ...c, _i: i })).filter(c => (c.track_id ?? 0) === (clips[dragging.index].track_id ?? 0));
          const mappedIdx2 = trackClips2.findIndex(c => c._i === dragging.index);
          const { nextStart } = getNeighborBounds(trackClips2, mappedIdx2);
          const clip = clips[dragging.index];
          // Can't extend past source end
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

        // --- Subtitle trimming: constrain to neighbors ---
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
      }
    },
    [dragging, xToTime, clips, subtitles, duration, onSeek, onClipsChange, onSubtitlesChange, getNeighborBounds]
  );

  const handleMouseUp = useCallback(() => { setDragging(null); setCanvasCursor("crosshair"); }, []);

  // Cursor feedback: detect edge vs body on hover
  const handleCanvasHover = useCallback(
    (e: React.MouseEvent) => {
      if (dragging) return; // cursor handled by drag type
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const allVideoBottom = RULER_HEIGHT + videoTrackCount * TRACK_HEIGHT;
      const subY = subtitleTrackY(videoTrackCount);

      // Check video tracks
      if (y >= RULER_HEIGHT && y < allVideoBottom) {
        const hoverTrackIndex = Math.floor((y - RULER_HEIGHT) / TRACK_HEIGHT);
        const hoverTrackId = videoTrackIds[hoverTrackIndex] ?? 0;
        for (const clip of clips) {
          if ((clip.track_id ?? 0) !== hoverTrackId) continue;
          const x1 = timeToX(clip.start_time);
          const x2 = timeToX(clip.end_time);
          if (Math.abs(x - x1) < 5 || Math.abs(x - x2) < 5) {
            setCanvasCursor("col-resize"); return;
          }
          if (x >= x1 && x <= x2) {
            setCanvasCursor("grab"); return;
          }
        }
      }
      // Check subtitle track
      if (y >= subY && y < subY + TRACK_HEIGHT) {
        for (const sub of subtitles) {
          const x1 = timeToX(sub.start_time);
          const x2 = timeToX(sub.end_time);
          if (Math.abs(x - x1) < 5 || Math.abs(x - x2) < 5) {
            setCanvasCursor("col-resize"); return;
          }
          if (x >= x1 && x <= x2) {
            setCanvasCursor("grab"); return;
          }
        }
      }
      setCanvasCursor("crosshair");
    },
    [dragging, clips, subtitles, timeToX]
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

  // Focus popover input when it appears
  useEffect(() => {
    if (popover) popoverInputRef.current?.focus();
  }, [popover]);

  return (
    <div className={cn("flex flex-col", className)}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1 border-b border-border text-xs">
        <span className="text-muted-foreground">{formatTime(currentTime)} / {formatTime(duration)}</span>
        <div className="w-px h-4 bg-border" />
        <button
          className="flex items-center gap-1 px-2 py-0.5 bg-secondary rounded text-muted-foreground hover:text-foreground"
          onClick={onSplit}
          title="Split at playhead (S)"
        >
          <Scissors className="h-3 w-3" />
          Split
        </button>
        <button
          className={cn(
            "flex items-center gap-1 px-2 py-0.5 rounded",
            selectedClip !== null || selectedSubtitleIndex !== null
              ? "bg-destructive/20 text-destructive hover:bg-destructive/30"
              : "bg-secondary text-muted-foreground opacity-50 cursor-not-allowed"
          )}
          onClick={() => {
            if (selectedSubtitleIndex !== null) {
              onSubtitlesChange(subtitles.filter((_, i) => i !== selectedSubtitleIndex));
              onSubtitleSelect(null);
            } else if (selectedClip !== null) {
              onClipsChange(clips.filter((_, i) => i !== selectedClip));
              setSelectedClip(null);
            }
          }}
          disabled={selectedClip === null && selectedSubtitleIndex === null}
          title="Delete selected (Backspace)"
        >
          <Trash2 className="h-3 w-3" />
          Delete
        </button>
        <div className="w-px h-4 bg-border" />
        <button
          className="flex items-center gap-1 px-2 py-0.5 bg-secondary rounded text-muted-foreground hover:text-foreground"
          onClick={() => {
            const newSub: Subtitle = {
              start_time: currentTime,
              end_time: Math.min(currentTime + 3, duration),
              text: "New subtitle",
            };
            onSubtitlesChange([...subtitles, newSub]);
          }}
          title="Add subtitle at playhead"
        >
          <Plus className="h-3 w-3" />
          Subtitle
        </button>
        <div className="flex-1" />
        <button
          className="p-0.5 bg-secondary rounded text-muted-foreground hover:text-foreground"
          onClick={() => setZoom((z) => Math.max(0.5, z / 1.3))}
          title="Zoom out"
        >
          <ZoomOut className="h-3.5 w-3.5" />
        </button>
        <input
          type="range"
          min={-3} max={13} step={0.1}
          value={Math.log(zoom) / Math.log(1.3)}
          onChange={(e) => setZoom(Math.pow(1.3, parseFloat(e.target.value)))}
          className="w-20 h-1 accent-primary"
          title={`Zoom: ${zoom.toFixed(1)}×`}
        />
        <button
          className="p-0.5 bg-secondary rounded text-muted-foreground hover:text-foreground"
          onClick={() => setZoom((z) => Math.min(20, z * 1.3))}
          title="Zoom in"
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </button>
        <span className="text-muted-foreground w-10 text-right">{zoom.toFixed(1)}×</span>
      </div>

      {/* Canvas */}
      <div
        ref={containerRef}
        className="relative overflow-hidden"
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

          // Determine target track
          let targetTrackId = 0;
          if (y >= RULER_HEIGHT && y < RULER_HEIGHT + videoTrackCount * TRACK_HEIGHT) {
            const trackIdx = Math.floor((y - RULER_HEIGHT) / TRACK_HEIGHT);
            targetTrackId = videoTrackIds[trackIdx] ?? 0;
          } else {
            // Dropped below existing tracks — create new track
            targetTrackId = Math.max(...videoTrackIds, 0) + 1;
          }

          // Create a new clip for the dragged session (duration will be set by parent)
          const newClip: Clip = {
            start_time: dropTime,
            end_time: dropTime + 10, // placeholder, parent should update with real duration
            media_offset: 0,
            track_id: targetTrackId,
            source_session_id: sessionId,
          };
          onClipsChange([...clips, newClip]);
        }}
      >
        <canvas
          ref={canvasRef}
          style={{ width: "100%", height: canvasHeight }}
          onMouseDown={handleMouseDown}
          onMouseMove={dragging ? handleMouseMove : handleCanvasHover}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        />

        {/* Floating popover for subtitle text editing */}
        {popover && popover.index < subtitles.length && (
          <div
            data-subtitle-popover
            className="absolute z-10 bg-card border border-border rounded-lg shadow-lg p-2 flex flex-col gap-1.5"
            style={{
              left: Math.min(popover.x, containerWidth - 260),
              top: popover.y + TRACK_HEIGHT + 4,
              width: 250,
            }}
          >
            <input
              ref={popoverInputRef}
              className="w-full bg-background border border-input rounded px-2 py-1 text-sm"
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
              <span className="text-[10px] text-muted-foreground">
                {formatTime(subtitles[popover.index].start_time)} - {formatTime(subtitles[popover.index].end_time)}
              </span>
              <button
                className="text-[10px] text-destructive hover:underline"
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

function getTimeStep(pxPerSec: number): number {
  if (pxPerSec > 200) return 0.5;
  if (pxPerSec > 100) return 1;
  if (pxPerSec > 40) return 5;
  if (pxPerSec > 15) return 10;
  return 30;
}

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  const ms = Math.floor((secs % 1) * 10);
  return `${m}:${s.toString().padStart(2, "0")}.${ms}`;
}
