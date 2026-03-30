import { create } from "zustand";
import type { CaptureSource, SessionSummary, MouseEvent } from "./ipc";
import { type ZoomConfig, defaultZoomConfig } from "./zoom";

type AppView = "recording" | "editor";

interface AppState {
  // Navigation
  view: AppView;
  setView: (view: AppView) => void;

  // Error
  error: string | null;
  setError: (error: string | null) => void;

  // Recording
  isRecording: boolean;
  isPaused: boolean;
  durationSecs: number;
  selectedSource: CaptureSource | null;
  sources: CaptureSource[];
  setSources: (sources: CaptureSource[]) => void;
  setSelectedSource: (source: CaptureSource | null) => void;
  setRecording: (recording: boolean) => void;
  setPaused: (paused: boolean) => void;
  setDuration: (secs: number) => void;

  // Session
  currentSession: SessionSummary | null;
  setCurrentSession: (session: SessionSummary | null) => void;

  // Mouse metadata
  mouseEvents: MouseEvent[];
  setMouseEvents: (events: MouseEvent[]) => void;

  // Zoom
  zoomEnabled: boolean;
  zoomConfig: ZoomConfig;
  setZoomEnabled: (enabled: boolean) => void;
  setZoomConfig: (config: ZoomConfig) => void;
}

export const useAppStore = create<AppState>((set) => ({
  view: "recording",
  setView: (view) => set({ view }),

  error: null,
  setError: (error) => set({ error }),

  isRecording: false,
  isPaused: false,
  durationSecs: 0,
  selectedSource: null,
  sources: [],
  setSources: (sources) => set({ sources }),
  setSelectedSource: (source) => set({ selectedSource: source }),
  setRecording: (recording) => set({ isRecording: recording }),
  setPaused: (paused) => set({ isPaused: paused }),
  setDuration: (secs) => set({ durationSecs: secs }),

  currentSession: null,
  setCurrentSession: (session) => set({ currentSession: session }),

  mouseEvents: [],
  setMouseEvents: (events) => set({ mouseEvents: events }),

  zoomEnabled: true,
  zoomConfig: { ...defaultZoomConfig },
  setZoomEnabled: (enabled) => set({ zoomEnabled: enabled }),
  setZoomConfig: (config) => set({ zoomConfig: config }),
}));
