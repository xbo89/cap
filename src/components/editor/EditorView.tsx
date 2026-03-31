import { useEffect, useRef, useCallback, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/lib/store";
import { ipc } from "@/lib/ipc";
import type { Clip, Subtitle, SubtitleStyle, ZoomSegment, CaptureRegion } from "@/lib/ipc";
import { Button } from "@/components/ui/button";
import { PreviewCanvas } from "@/components/recording/PreviewCanvas";
import { ZoomSettings } from "@/components/zoom/ZoomSettings";
import { SubtitleProperties } from "@/components/subtitle/SubtitleProperties";
import { Timeline } from "@/components/editor/Timeline";
import { ExportPanel } from "@/components/export/ExportPanel";
import { useKeyboard } from "@/hooks/useKeyboard";
import { videoUrl } from "@/lib/video-url";
import { useThumbnails } from "@/hooks/useThumbnails";
import { PanelLeft, Download, Save, Check, Play, Pause, FolderOpen } from "lucide-react";

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
  const videoRef = useRef<HTMLVideoElement>(null);
  // Refs for playback loop (avoid stale closures in RAF)
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;

  const sessionId = currentSession?.session_id;

  // Dynamic timeline duration: expand beyond source when clips are moved
  const timelineDuration = Math.max(
    duration,
    ...clips.map(c => c.end_time),
  ) + 10; // 10s buffer for dragging room

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

    // Load new session data — use Promise.all for duration + project to avoid race conditions
    ipc.getMouseMetadata(sessionId).then(setMouseEvents).catch(console.error);
    ipc.getCaptureRegion(sessionId).then(setCaptureRegion).catch(console.error);
    ipc.getWaveform(sessionId, 100).then(setWaveform).catch(console.error);

    Promise.all([
      ipc.getVideoDuration(sessionId),
      ipc.loadProject(sessionId),
    ]).then(([d, project]) => {
      setDuration(d);

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

  // Playback engine: RAF-driven timeline clock, syncing video to source time.
  // Plays through gaps as black frames (no skipping).
  useEffect(() => {
    if (!isPlaying) return;
    const video = videoRef.current;
    if (!video) return;

    let rafId: number;
    let lastTs = performance.now();
    let lastActiveClipStart = -1; // track clip transitions to re-seek

    // Initial seek if starting inside a clip
    const initClips = [...clipsRef.current].sort((a, b) => a.start_time - b.start_time);
    const initClip = initClips.find(c => currentTimeRef.current >= c.start_time && currentTimeRef.current <= c.end_time);
    if (initClip) {
      video.currentTime = initClip.media_offset + (currentTimeRef.current - initClip.start_time);
      video.play().catch(() => {});
      lastActiveClipStart = initClip.start_time;
    }

    const tick = (ts: number) => {
      const dt = Math.min((ts - lastTs) / 1000, 0.1);
      lastTs = ts;

      const sorted = [...clipsRef.current].sort((a, b) => a.start_time - b.start_time);
      const newTime = currentTimeRef.current + dt;

      // Check if past all content (stop exactly at last clip's end)
      const lastClip = sorted[sorted.length - 1];
      if (!lastClip || newTime >= (lastClip?.end_time ?? 0)) {
        const endTime = lastClip?.end_time ?? 0;
        video.pause();
        currentTimeRef.current = endTime;
        setCurrentTime(endTime);
        setIsPlaying(false);
        return;
      }

      const activeClip = sorted.find(c => newTime >= c.start_time && newTime <= c.end_time);

      if (activeClip) {
        // Inside a clip: ensure video is playing at correct source position
        const expectedSrc = activeClip.media_offset + (newTime - activeClip.start_time);

        // Re-seek when entering a new clip or if drifted
        if (lastActiveClipStart !== activeClip.start_time || Math.abs(video.currentTime - expectedSrc) > 0.2) {
          video.currentTime = expectedSrc;
          lastActiveClipStart = activeClip.start_time;
        }
        if (video.paused) video.play().catch(() => {});
      } else {
        // In a gap: pause video, preview shows black
        if (!video.paused) video.pause();
        lastActiveClipStart = -1;
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
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => ipc.showSessionsBrowser()} title="Open recordings panel">
            <PanelLeft className="h-4 w-4" />
          </Button>
          <div className="text-sm text-muted-foreground">
            {currentSession.duration_secs.toFixed(1)}s |{" "}
            {currentSession.file_size_mb.toFixed(1)} MB
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => sessionId && ipc.showInFinder(sessionId)} title="Open in Finder">
            <FolderOpen className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={handleSave} disabled={saveStatus === "saving"}>
            {saveStatus === "saved" ? (
              <><Check className="mr-2 h-4 w-4 text-green-500" />Saved</>
            ) : (
              <><Save className="mr-2 h-4 w-4" />Save</>
            )}
          </Button>
          <Button size="sm" onClick={() => setShowExport(true)}>
            <Download className="mr-2 h-4 w-4" />
            Export
          </Button>
        </div>
      </div>

      {/* Main content: Sidebar + Preview + Settings */}
      <div className="flex-1 flex min-h-0">
        {/* Video preview */}
        <div className="flex-1 flex flex-col items-center justify-center p-4 min-h-0">
          <div className="flex-1 min-h-0 w-full max-w-3xl flex items-center justify-center">
            <video key={sessionId} ref={videoRef} src={videoSrcUrl} className="hidden" playsInline preload="auto" />
            <PreviewCanvas
              key={sessionId}
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
              width={1920}
              height={1080}
            />
          </div>
          <div className="flex-none flex justify-center mt-2">
            <button
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-secondary text-foreground hover:bg-secondary/80 text-sm"
              onClick={togglePlay}
            >
              {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              {isPlaying ? "Pause" : "Play"}
            </button>
          </div>
        </div>

        {/* Right sidebar: only shown when an element is selected */}
        {(selectedSub || selectedZoomSeg) && (
          <div className="w-72 border-l border-border p-4 overflow-y-auto">
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
          </div>
        )}
      </div>

      {/* Timeline */}
      <div className="border-t border-border">
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
        />
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
