import { useEffect, useRef, useCallback, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/lib/store";
import { ipc } from "@/lib/ipc";
import type { Clip, Subtitle, SubtitleStyle, ZoomSegment, CaptureRegion, MouseEvent as MouseEventData } from "@/lib/ipc";
import { HistoryManager } from "@/lib/history";
import { PreviewCanvas } from "@/components/recording/PreviewCanvas";
import { ZoomSettings } from "@/components/zoom/ZoomSettings";
import { SubtitleProperties } from "@/components/subtitle/SubtitleProperties";
import { Timeline } from "@/components/editor/Timeline";
import { ExportPanel } from "@/components/export/ExportPanel";
import { useKeyboard } from "@/hooks/useKeyboard";
import { videoUrl } from "@/lib/video-url";
import { useThumbnails } from "@/hooks/useThumbnails";
import { Film, Save, Check, Play, Pause, FolderOpen } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";

/**
 * Detect clean single-clicks from mouse events and generate zoom segments.
 * Filters out: rapid clicks (<500ms apart), long presses (>200ms hold).
 */
function generateZoomFromClicks(events: MouseEventData[], duration: number): ZoomSegment[] {
  if (events.length === 0) return [];

  // Find click-down transitions (buttons 0→1)
  const clicks: { time: number; x: number; y: number }[] = [];
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const curr = events[i];
    // Left button press (0 → has bit 1)
    if ((prev.buttons & 1) === 0 && (curr.buttons & 1) === 1) {
      const timeSec = curr.timestamp_us / 1_000_000;
      // Find release: next frame where button goes back to 0
      let releaseIdx = i + 1;
      while (releaseIdx < events.length && (events[releaseIdx].buttons & 1) === 1) {
        releaseIdx++;
      }
      const holdDurationMs = releaseIdx < events.length
        ? (events[releaseIdx].timestamp_us - curr.timestamp_us) / 1000
        : 999;

      // Filter: skip long presses (>200ms hold = likely drag)
      if (holdDurationMs <= 200) {
        clicks.push({ time: timeSec, x: curr.x, y: curr.y });
      }
    }
  }

  // Filter: skip rapid clicks (<500ms apart, keep first)
  const filtered: typeof clicks = [];
  for (const click of clicks) {
    const last = filtered[filtered.length - 1];
    if (!last || (click.time - last.time) >= 0.5) {
      filtered.push(click);
    }
  }

  // Generate zoom segments with anchored focus
  const segments: ZoomSegment[] = [];
  for (const click of filtered) {
    const start = Math.max(0, click.time - 0.3);
    const end = Math.min(duration, click.time + 1.5);
    // Skip if overlaps with previous segment
    const prev = segments[segments.length - 1];
    if (prev && start < prev.end_time) continue;

    segments.push({
      start_time: start,
      end_time: end,
      zoom_level: 2.0,
      follow_speed: 0.15,
      padding: 100,
      follow_mouse: false,
      anchor_x: click.x,
      anchor_y: click.y,
    });
  }

  return segments;
}

export function EditorView() {
  const {
    currentSession,
    mouseEvents,
    setMouseEvents,
    zoomSegments,
    setZoomSegments,
    selectedZoomSegmentIndex,
    setSelectedZoomSegmentIndex,
  } = useAppStore();

  const [waveform, setWaveform] = useState<number[]>([]);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [clips, setClips] = useState<Clip[]>([]);
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [showExport, setShowExport] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [selectedSubtitleIndex, setSelectedSubtitleIndex] = useState<number | null>(null);
  const [captureRegion, setCaptureRegion] = useState<CaptureRegion | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [showGrid, setShowGrid] = useState(false);
  const [timelineHeight, setTimelineHeight] = useState(260);
  const timelineDragRef = useRef<{ startY: number; startH: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  // Refs for playback loop (avoid stale closures in RAF)
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;

  const sessionId = currentSession?.session_id;

  // --- Undo/Redo ---
  const historyRef = useRef(new HistoryManager());
  const historyPushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRestoringRef = useRef(false); // prevent re-pushing during undo/redo restore

  // Push snapshot when clips/subtitles/zoomSegments change (debounced 300ms)
  useEffect(() => {
    if (isRestoringRef.current) return; // skip push during undo/redo
    if (clips.length === 0 && subtitles.length === 0 && zoomSegments.length === 0) return;
    if (historyPushTimer.current) clearTimeout(historyPushTimer.current);
    historyPushTimer.current = setTimeout(() => {
      historyRef.current.push({ clips, subtitles, zoomSegments });
    }, 300);
    return () => { if (historyPushTimer.current) clearTimeout(historyPushTimer.current); };
  }, [clips, subtitles, zoomSegments]);

  const handleUndo = useCallback(() => {
    const snapshot = historyRef.current.undo();
    if (!snapshot) return;
    isRestoringRef.current = true;
    setClips(snapshot.clips);
    setSubtitles(snapshot.subtitles);
    setZoomSegments(snapshot.zoomSegments);
    // Reset flag after React processes the state updates
    requestAnimationFrame(() => { isRestoringRef.current = false; });
  }, [setZoomSegments]);

  const handleRedo = useCallback(() => {
    const snapshot = historyRef.current.redo();
    if (!snapshot) return;
    isRestoringRef.current = true;
    setClips(snapshot.clips);
    setSubtitles(snapshot.subtitles);
    setZoomSegments(snapshot.zoomSegments);
    requestAnimationFrame(() => { isRestoringRef.current = false; });
  }, [setZoomSegments]);

  // Clear history when session changes
  useEffect(() => {
    historyRef.current.clear();
  }, [sessionId]);

  // Dynamic timeline duration: expand beyond source when clips are moved
  const timelineDuration = Math.max(
    duration,
    ...clips.map(c => c.end_time),
  ) + 10; // 10s buffer for dragging room

  // Capture first frame as background
  useEffect(() => {
    const video = videoRef.current;
    const canvas = bgCanvasRef.current;
    if (!video || !canvas) return;

    const handleLoaded = () => {
      // Seek to first frame
      video.currentTime = 0;
    };
    const handleSeeked = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      canvas.width = video.videoWidth || 1920;
      canvas.height = video.videoHeight || 1080;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    };

    video.addEventListener("loadeddata", handleLoaded);
    video.addEventListener("seeked", handleSeeked);

    // If video is already loaded
    if (video.readyState >= 2) {
      handleLoaded();
    }

    return () => {
      video.removeEventListener("loadeddata", handleLoaded);
      video.removeEventListener("seeked", handleSeeked);
    };
  }, [sessionId]);

  // Load session data — reset ALL state first to prevent stale data from previous session
  useEffect(() => {
    if (!sessionId) return;

    // Reset all state immediately when session changes
    setWaveform([]);
    setDuration(0);
    setCurrentTime(0);
    setClips([]);
    setSubtitles([]);
    setIsPlaying(false);
    setSelectedSubtitleIndex(null);
    setSelectedZoomSegmentIndex(null);
    setCaptureRegion(null);
    setSaveStatus("idle");
    setShowExport(false);
    setZoomSegments([]);
    setMouseEvents([]);

    // Load new session data — all in one Promise.all to enable auto-zoom from clicks
    ipc.getCaptureRegion(sessionId).then(setCaptureRegion).catch(console.error);
    ipc.getWaveform(sessionId, 100).then(setWaveform).catch(console.error);

    Promise.all([
      ipc.getVideoDuration(sessionId),
      ipc.loadProject(sessionId),
      ipc.getMouseMetadata(sessionId),
    ]).then(([d, project, events]) => {
      setDuration(d);
      setMouseEvents(events);

      if (project) {
        setClips(project.clips.map(c => ({
          ...c,
          media_offset: c.media_offset ?? c.start_time,
        })));
        setSubtitles(project.subtitles);
        if (project.zoom_effect) {
          const ze = project.zoom_effect as any;
          if (ze.segments) {
            setZoomSegments(ze.segments);
          } else if (ze.enabled) {
            setZoomSegments([{
              start_time: 0,
              end_time: project.clips.length > 0
                ? Math.max(...project.clips.map(c => c.end_time))
                : 30,
              zoom_level: ze.zoom_level,
              follow_speed: ze.follow_speed,
              padding: ze.padding,
            }]);
          }
        }
      } else {
        // No saved project — create default clip spanning full video
        setClips([{ start_time: 0, end_time: d, media_offset: 0 }]);

        // Auto-generate zoom segments from mouse clicks
        const autoZooms = generateZoomFromClicks(events, d);
        if (autoZooms.length > 0) {
          setZoomSegments(autoZooms);
        }
      }
    }).catch(console.error);
  }, [sessionId, setMouseEvents, setZoomSegments, setSelectedZoomSegmentIndex]);

  // Map timeline time → source video time via clip media_offset
  const timelineToSource = useCallback((tlTime: number): number | null => {
    const sorted = [...clips].sort((a, b) => a.start_time - b.start_time);
    for (const clip of sorted) {
      if (tlTime >= clip.start_time && tlTime <= clip.end_time) {
        return clip.media_offset + (tlTime - clip.start_time);
      }
    }
    return null;
  }, [clips]);

  // Seek: set timeline time and sync video to source time
  const handleSeek = useCallback((time: number) => {
    setCurrentTime(time);
    currentTimeRef.current = time;
    const video = videoRef.current;
    if (!video) return;
    const srcTime = timelineToSource(time);
    if (srcTime !== null) {
      video.currentTime = srcTime;
    }
  }, [timelineToSource]);

  const togglePlay = useCallback(() => {
    const curClips = clipsRef.current;
    const curTime = currentTimeRef.current;

    // If at or past the end, restart from beginning before playing
    const sorted = [...curClips].sort((a, b) => a.start_time - b.start_time);
    const lastClip = sorted[sorted.length - 1];
    if (lastClip && curTime >= lastClip.end_time - 0.05) {
      setCurrentTime(0);
      currentTimeRef.current = 0;
      const video = videoRef.current;
      if (video) video.currentTime = 0;
    }

    setIsPlaying(prev => !prev);
  }, []);

  // Playback engine: let <video> drive timing via its own clock for smooth audio.
  // RAF reads video.currentTime and maps it back to timeline time for the UI.
  // We only seek when entering a new clip or when drift is excessive.
  useEffect(() => {
    if (!isPlaying) return;
    const video = videoRef.current;
    if (!video) return;

    let rafId: number;
    let lastActiveClipStart = -1;
    let inGap = false;
    let gapLastTs = 0; // for advancing timeline time through gaps

    const sorted = [...clipsRef.current].sort((a, b) => a.start_time - b.start_time);

    // Find the active clip at current timeline time
    const findClipAt = (tlTime: number) =>
      sorted.find(c => tlTime >= c.start_time && tlTime <= c.end_time) ?? null;

    // Initial seek + play
    const initClip = findClipAt(currentTimeRef.current);
    if (initClip) {
      video.currentTime = initClip.media_offset + (currentTimeRef.current - initClip.start_time);
      video.play().catch(() => {});
      lastActiveClipStart = initClip.start_time;
      inGap = false;
    } else {
      // Starting in a gap
      video.pause();
      inGap = true;
      gapLastTs = performance.now();
    }

    const tick = (ts: number) => {
      const clips = [...clipsRef.current].sort((a, b) => a.start_time - b.start_time);
      const lastClip = clips[clips.length - 1];

      let newTime: number;

      if (inGap) {
        // Advance timeline time manually during gaps (video is paused)
        const dt = Math.min((ts - gapLastTs) / 1000, 0.1);
        gapLastTs = ts;
        newTime = currentTimeRef.current + dt;
      } else {
        // Derive timeline time from video's own currentTime (smooth, no jitter)
        const activeClip = clips.find(c => c.start_time === lastActiveClipStart);
        if (activeClip) {
          const srcOffset = video.currentTime - activeClip.media_offset;
          newTime = activeClip.start_time + srcOffset;
        } else {
          newTime = currentTimeRef.current;
        }
      }

      // End of timeline
      if (!lastClip || newTime >= lastClip.end_time) {
        video.pause();
        currentTimeRef.current = lastClip?.end_time ?? 0;
        setCurrentTime(currentTimeRef.current);
        setIsPlaying(false);
        return;
      }

      const activeClip = clips.find(c => newTime >= c.start_time && newTime <= c.end_time);

      if (activeClip) {
        if (inGap || lastActiveClipStart !== activeClip.start_time) {
          // Entering a new clip (from gap or different clip): seek once
          const seekTo = activeClip.media_offset + (newTime - activeClip.start_time);
          video.currentTime = seekTo;
          video.play().catch(() => {});
          lastActiveClipStart = activeClip.start_time;
          inGap = false;
        }
        // Within the same clip: let video play freely (no seeking!)
      } else {
        // In a gap
        if (!inGap) {
          video.pause();
          inGap = true;
          gapLastTs = ts;
          lastActiveClipStart = -1;
        }
      }

      currentTimeRef.current = newTime;
      setCurrentTime(newTime);
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      video.pause();
    };
  }, [isPlaying]);

  const handleSplit = useCallback(() => {
    // Split selected subtitle if playhead is within it
    if (selectedSubtitleIndex !== null) {
      const sub = subtitles[selectedSubtitleIndex];
      if (sub && currentTime > sub.start_time + 0.1 && currentTime < sub.end_time - 0.1) {
        const newSubs = [...subtitles];
        const left = { ...sub, end_time: currentTime };
        const right = { ...sub, start_time: currentTime };
        newSubs.splice(selectedSubtitleIndex, 1, left, right);
        setSubtitles(newSubs);
        return;
      }
    }
    // Split selected zoom segment if playhead is within it
    if (selectedZoomSegmentIndex !== null) {
      const seg = zoomSegments[selectedZoomSegmentIndex];
      if (seg && currentTime > seg.start_time + 0.1 && currentTime < seg.end_time - 0.1) {
        const newSegs = [...zoomSegments];
        const left = { ...seg, end_time: currentTime };
        const right = { ...seg, start_time: currentTime };
        newSegs.splice(selectedZoomSegmentIndex, 1, left, right);
        setZoomSegments(newSegs);
        return;
      }
    }
    // Otherwise split video clip
    const newClips: Clip[] = [];
    for (const clip of clips) {
      if (currentTime > clip.start_time + 0.1 && currentTime < clip.end_time - 0.1) {
        const leftDur = currentTime - clip.start_time;
        newClips.push({ start_time: clip.start_time, end_time: currentTime, media_offset: clip.media_offset });
        newClips.push({ start_time: currentTime, end_time: clip.end_time, media_offset: clip.media_offset + leftDur });
      } else {
        newClips.push(clip);
      }
    }
    setClips(newClips);
  }, [clips, subtitles, zoomSegments, currentTime, selectedSubtitleIndex, selectedZoomSegmentIndex, setZoomSegments]);

  const handleSave = useCallback(async () => {
    if (!sessionId) return;
    setSaveStatus("saving");
    await ipc.saveProject(sessionId, {
      session_id: sessionId,
      clips,
      subtitles,
      zoom_effect: {
        segments: zoomSegments,
      },
      export_settings: {
        format: "Mp4H264",
        quality: "High",
        resolution: null,
        burn_subtitles: true,
      },
    });
    setSaveStatus("saved");
    setTimeout(() => setSaveStatus("idle"), 2000);
  }, [sessionId, clips, subtitles, zoomSegments]);

  // Auto-save: debounce 3s after edits
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!sessionId || clips.length === 0) return;
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => { handleSave(); }, 3000);
    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current); };
  }, [clips, subtitles, zoomSegments, sessionId, handleSave]);

  // Listen for save-current-project event (triggered before loading a new session)
  useEffect(() => {
    const unlisten = listen("save-current-project", () => {
      handleSave();
    });
    return () => { unlisten.then((u) => u()); };
  }, [handleSave]);

  // Subtitle style change from canvas drag or properties panel
  const handleSubtitleStyleChange = useCallback((index: number, style: SubtitleStyle) => {
    setSubtitles(prev => {
      const newSubs = [...prev];
      newSubs[index] = { ...newSubs[index], style };
      return newSubs;
    });
  }, []);

  // Subtitle text change from properties panel
  const handleSubtitleTextChange = useCallback((index: number, text: string) => {
    setSubtitles(prev => {
      const newSubs = [...prev];
      newSubs[index] = { ...newSubs[index], text };
      return newSubs;
    });
  }, []);

  // Zoom segment change from settings panel
  const handleZoomSegmentChange = useCallback((segment: ZoomSegment) => {
    if (selectedZoomSegmentIndex === null) return;
    const newSegs = [...zoomSegments];
    newSegs[selectedZoomSegmentIndex] = segment;
    setZoomSegments(newSegs);
  }, [zoomSegments, selectedZoomSegmentIndex, setZoomSegments]);

  // When selecting a zoom segment, deselect subtitle and vice versa
  const handleZoomSegmentSelect = useCallback((index: number | null) => {
    setSelectedZoomSegmentIndex(index);
    if (index !== null) setSelectedSubtitleIndex(null);
  }, [setSelectedZoomSegmentIndex]);

  const handleSubtitleSelect = useCallback((index: number | null) => {
    setSelectedSubtitleIndex(index);
    if (index !== null) setSelectedZoomSegmentIndex(null);
  }, [setSelectedZoomSegmentIndex]);

  useKeyboard([
    { key: " ", action: togglePlay },
    { key: "s", action: handleSplit },
    { key: "s", meta: true, action: handleSave },
    { key: "z", meta: true, action: handleUndo },
    { key: "z", meta: true, shift: true, action: handleRedo },
    { key: "e", meta: true, action: () => setShowExport(true) },
    {
      key: "Backspace",
      action: () => {
        if (selectedSubtitleIndex !== null) {
          setSubtitles((prev) => prev.filter((_, i) => i !== selectedSubtitleIndex));
          setSelectedSubtitleIndex(null);
        } else if (selectedZoomSegmentIndex !== null) {
          const newSegs = zoomSegments.filter((_, i) => i !== selectedZoomSegmentIndex);
          setZoomSegments(newSegs);
          setSelectedZoomSegmentIndex(null);
        } else {
          setClips((prev) =>
            prev.filter((c) => !(currentTime >= c.start_time && currentTime <= c.end_time))
          );
        }
      },
    },
    {
      key: "Escape",
      action: () => {
        setSelectedSubtitleIndex(null);
        setSelectedZoomSegmentIndex(null);
      },
    },
  ]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    timelineDragRef.current = { startY: e.clientY, startH: timelineHeight };
    const onMove = (ev: MouseEvent) => {
      if (!timelineDragRef.current) return;
      const delta = timelineDragRef.current.startY - ev.clientY;
      const newH = Math.max(120, Math.min(600, timelineDragRef.current.startH + delta));
      setTimelineHeight(newH);
    };
    const onUp = () => {
      timelineDragRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [timelineHeight]);

  if (!currentSession) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <p className="text-muted-foreground">No recording loaded</p>
      </div>
    );
  }

  const videoSrcUrl = videoUrl(currentSession.video_path);
  const thumbnails = useThumbnails(videoSrcUrl, duration);
  const selectedSub = selectedSubtitleIndex !== null ? subtitles[selectedSubtitleIndex] : null;
  const selectedZoomSeg = selectedZoomSegmentIndex !== null ? zoomSegments[selectedZoomSegmentIndex] : null;

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* Background: video first frame, oversized to allow blur bleed */}
      <canvas
        ref={bgCanvasRef}
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 min-w-[calc(100%+500px)] min-h-[calc(100%+500px)] object-cover pointer-events-none"
      />

      {/* Glass morphism app frame */}
      <div className="absolute inset-0 backdrop-blur-[60px] bg-[rgba(25,25,25,0.88)] flex flex-col overflow-hidden">
        {/* Header */}
        <div
          data-tauri-drag-region
          className="flex items-center justify-between px-4 py-3 border-b border-white/[0.08] shrink-0"
        >
          {/* Left: spacer for native traffic lights */}
          <div className="w-[70px]" data-tauri-drag-region />

          {/* Right: action buttons */}
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="flex items-center justify-center size-9 rounded-full border border-white/[0.08] hover:bg-white/[0.06] transition-colors"
                  onClick={() => sessionId && ipc.showInFinder(sessionId)}
                >
                  <FolderOpen className="size-4 text-white/70" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Show in Finder</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="flex items-center justify-center size-9 rounded-full border border-white/[0.08] hover:bg-white/[0.06] transition-colors"
                  onClick={() => ipc.showSessionsBrowser()}
                >
                  <Film className="size-4 text-white/70" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Recordings</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="flex items-center justify-center size-9 rounded-full border border-white/[0.08] hover:bg-white/[0.06] transition-colors"
                  onClick={handleSave}
                  disabled={saveStatus === "saving"}
                >
                  {saveStatus === "saved" ? (
                    <Check className="size-4 text-green-400" />
                  ) : (
                    <Save className="size-4 text-white/70" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent>Save (&#8984;S)</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="flex items-center justify-center h-9 px-5 rounded-full bg-[#5b5bd6] hover:bg-[#6e6ede] text-white text-sm transition-colors"
                  onClick={() => setShowExport(true)}
                >
                  Export
                </button>
              </TooltipTrigger>
              <TooltipContent>Export video (&#8984;E)</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Main content area */}
        <div className="flex-1 flex min-h-[200px]">
          {/* Left: Video preview + play controls */}
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            {/* Video preview area */}
            <div className="flex-1 flex items-center justify-center p-4 min-h-0">
              <video key={`video-${sessionId}`} ref={videoRef} src={videoSrcUrl} className="hidden" playsInline preload="auto" />
              <PreviewCanvas
                key={`preview-${sessionId}`}
                videoRef={videoRef}
                mouseEvents={mouseEvents}
                clips={clips}
                subtitles={subtitles}
                timelineTime={currentTime}
                isPlaying={isPlaying}
                zoomSegments={zoomSegments}
                captureRegion={captureRegion}
                selectedSubtitleIndex={selectedSubtitleIndex}
                onSubtitleSelect={handleSubtitleSelect}
                onSubtitleStyleChange={handleSubtitleStyleChange}
                showGrid={showGrid}
                width={1920}
                height={1080}
              />
            </div>

            {/* Play/Pause button */}
            <div className="flex-none flex justify-center py-2">
              <button
                className="flex items-center justify-center size-9 rounded-full border border-white/[0.08] hover:bg-white/[0.06] transition-colors"
                onClick={togglePlay}
              >
                {isPlaying ? (
                  <Pause className="size-4 text-white/70" />
                ) : (
                  <Play className="size-4 text-white/70" />
                )}
              </button>
            </div>
          </div>

          {/* Right sidebar: properties panel */}
          {(selectedSub || selectedZoomSeg) && (
            <div className="w-60 border-l border-white/[0.08]">
              <ScrollArea className="h-full px-3 py-1">
                {selectedSub ? (
                  <SubtitleProperties
                    subtitle={selectedSub}
                    onTextChange={(text) => handleSubtitleTextChange(selectedSubtitleIndex!, text)}
                    onStyleChange={(style) => handleSubtitleStyleChange(selectedSubtitleIndex!, style)}
                  />
                ) : (
                  <ZoomSettings
                    segment={selectedZoomSeg}
                    onSegmentChange={handleZoomSegmentChange}
                  />
                )}
              </ScrollArea>
            </div>
          )}
        </div>

        {/* Timeline resize handle */}
        <div
          className="shrink-0 h-1.5 cursor-row-resize border-t border-white/[0.08] flex items-center justify-center group hover:bg-white/[0.04] transition-colors"
          onMouseDown={handleResizeStart}
        >
          <div className="w-8 h-0.5 rounded-full bg-white/20 group-hover:bg-white/40 transition-colors" />
        </div>

        {/* Timeline */}
        <div className="shrink-0 overflow-y-auto" style={{ height: timelineHeight }}>
          <Timeline
            duration={timelineDuration}
            sourceDuration={duration}
            currentTime={currentTime}
            waveform={waveform}
            clips={clips}
            thumbnails={thumbnails}
            subtitles={subtitles}
            selectedSubtitleIndex={selectedSubtitleIndex}
            onSubtitleSelect={handleSubtitleSelect}
            zoomSegments={zoomSegments}
            selectedZoomSegmentIndex={selectedZoomSegmentIndex}
            onZoomSegmentSelect={handleZoomSegmentSelect}
            onZoomSegmentsChange={setZoomSegments}
            onSeek={handleSeek}
            onClipsChange={setClips}
            onSubtitlesChange={setSubtitles}
            onSplit={handleSplit}
            showGrid={showGrid}
            onShowGridChange={setShowGrid}
            getMouseAtSourceTime={(tlTime) => {
              if (mouseEvents.length === 0) return null;
              // Convert timeline time → source time, then look up mouse event
              const srcTime = timelineToSource(tlTime);
              if (srcTime === null) return null;
              const timeUs = srcTime * 1_000_000;
              let lo = 0, hi = mouseEvents.length - 1;
              while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (mouseEvents[mid].timestamp_us < timeUs) lo = mid + 1;
                else hi = mid;
              }
              const ev = mouseEvents[lo];
              return ev ? { x: ev.x, y: ev.y } : null;
            }}
          />
        </div>
      </div>

      {/* Export modal */}
      {showExport && sessionId && (
        <ExportPanel
          sessionId={sessionId}
          project={{
            session_id: sessionId,
            clips,
            subtitles,
            zoom_effect: {
              segments: zoomSegments,
            },
            export_settings: {
              format: "Mp4H264",
              quality: "High",
              resolution: null,
              burn_subtitles: true,
            },
          }}
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  );
}
