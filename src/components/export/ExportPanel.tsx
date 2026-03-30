import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { ipc } from "@/lib/ipc";
import type { Project, ExportProgress } from "@/lib/ipc";
import { open } from "@tauri-apps/plugin-dialog";
import { Download, X, FolderOpen, Check } from "lucide-react";

interface ExportPanelProps {
  sessionId: string;
  project: Project;
  onClose: () => void;
}

type ExportFormat = "Mp4H264" | "Mp4H265" | "WebmVp9";
type ExportQuality = "Low" | "Medium" | "High" | "Ultra";

export function ExportPanel({ sessionId, project, onClose }: ExportPanelProps) {
  const [format, setFormat] = useState<ExportFormat>("Mp4H264");
  const [quality, setQuality] = useState<ExportQuality>("High");
  const [fps, setFps] = useState(60);
  const [burnSubs, setBurnSubs] = useState(true);
  const [outputDir, setOutputDir] = useState("");
  const [fileName, setFileName] = useState("recording");
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [completed, setCompleted] = useState<{ path: string; size: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Default output directory to Desktop
  useEffect(() => {
    ipc.getDesktopPath().then(setOutputDir).catch(() => {});
  }, []);

  // Listen for export events
  useEffect(() => {
    const unsubs: (() => void)[] = [];
    ipc.onExportProgress(setProgress).then((u) => unsubs.push(u));
    ipc.onExportComplete((r) => {
      setExporting(false);
      setCompleted({ path: r.output_path, size: r.file_size_mb });
    }).then((u) => unsubs.push(u));
    ipc.onExportError((e) => {
      setExporting(false);
      setError(e.message);
    }).then((u) => unsubs.push(u));
    return () => unsubs.forEach((u) => u());
  }, []);

  const pickDirectory = useCallback(async () => {
    const dir = await open({ directory: true, multiple: false });
    if (dir) setOutputDir(dir as string);
  }, []);

  const ext = format === "WebmVp9" ? "webm" : "mp4";

  // Generate unique output path by appending sequence number if file exists
  const getUniqueOutputPath = useCallback(async (dir: string, name: string, extension: string): Promise<string> => {
    // We'll try the base name first, then append _1, _2, etc.
    // Use ipc invoke to check file existence on the Rust side
    let candidate = `${dir}/${name}.${extension}`;
    let seq = 0;
    // Try up to 100 sequence numbers
    while (seq < 100) {
      try {
        const exists = await ipc.fileExists(candidate);
        if (!exists) return candidate;
      } catch {
        // If fileExists is not available, just return the candidate
        return candidate;
      }
      seq++;
      candidate = `${dir}/${name}_${seq}.${extension}`;
    }
    return candidate;
  }, []);

  const handleExport = useCallback(async () => {
    if (!outputDir) return;
    setExporting(true);
    setProgress(null);
    setCompleted(null);
    setError(null);

    const outputPath = await getUniqueOutputPath(outputDir, fileName, ext);
    const exportProject: Project = {
      ...project,
      export_settings: {
        format,
        quality,
        resolution: null,
        burn_subtitles: burnSubs,
        fps,
      },
    };

    try {
      await ipc.startExport(sessionId, outputPath, exportProject);
    } catch (e) {
      setExporting(false);
      setError(String(e));
    }
  }, [outputDir, fileName, ext, format, quality, fps, burnSubs, project, sessionId, getUniqueOutputPath]);

  const handleCancel = useCallback(async () => {
    await ipc.cancelExport();
    setExporting(false);
  }, []);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-card border border-border rounded-lg w-[480px] max-h-[80vh] overflow-y-auto shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="text-base font-medium">Export Video</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Format */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Format</label>
            <div className="flex gap-2">
              {([
                ["Mp4H264", "MP4 (H.264)"],
                ["Mp4H265", "MP4 (H.265)"],
                ["WebmVp9", "WebM (VP9)"],
              ] as const).map(([val, label]) => (
                <button
                  key={val}
                  className={`flex-1 px-3 py-1.5 rounded text-xs border ${
                    format === val
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-input text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setFormat(val)}
                  disabled={exporting}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Quality */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Quality</label>
            <div className="flex gap-2">
              {(["Low", "Medium", "High", "Ultra"] as const).map((q) => (
                <button
                  key={q}
                  className={`flex-1 px-3 py-1.5 rounded text-xs border ${
                    quality === q
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-input text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setQuality(q)}
                  disabled={exporting}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>

          {/* Frame Rate */}
          <Slider
            label="Frame Rate"
            value={fps}
            min={24}
            max={120}
            step={1}
            displayValue={`${fps} fps`}
            onChange={setFps}
          />

          {/* Subtitles */}
          {project.subtitles.length > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-sm">Burn subtitles ({project.subtitles.length})</span>
              <button
                onClick={() => setBurnSubs(!burnSubs)}
                disabled={exporting}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                  burnSubs ? "bg-primary" : "bg-secondary"
                }`}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background transition-transform ${
                    burnSubs ? "translate-x-4.5" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
          )}

          {/* Output directory */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Save to</label>
            <div className="flex gap-2">
              <div
                className="flex-1 bg-secondary/50 border border-input rounded px-3 py-1.5 text-sm text-muted-foreground truncate cursor-pointer hover:border-primary/50"
                onClick={pickDirectory}
              >
                {outputDir || "Choose output directory..."}
              </div>
              <Button variant="outline" size="sm" onClick={pickDirectory} disabled={exporting}>
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* File name */}
          <div className="space-y-2">
            <label className="text-sm font-medium">File name</label>
            <div className="flex items-center gap-1">
              <input
                className="flex-1 bg-background border border-input rounded px-3 py-1.5 text-sm"
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
                disabled={exporting}
              />
              <span className="text-sm text-muted-foreground">.{ext}</span>
            </div>
          </div>

          {/* Progress */}
          {exporting && progress && (
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{progress.status}</span>
                <span>{progress.percent.toFixed(1)}%</span>
              </div>
              <div className="h-2 bg-secondary rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
              <div className="text-xs text-muted-foreground text-center">
                Frame {progress.current_frame} / {progress.total_frames}
              </div>
            </div>
          )}

          {/* Completed */}
          {completed && (
            <div className="flex items-center gap-2 p-3 rounded bg-green-500/10 border border-green-500/30">
              <Check className="h-4 w-4 text-green-500" />
              <div className="flex-1 text-sm">
                <p className="text-green-400">Export complete!</p>
                <p className="text-xs text-muted-foreground truncate">{completed.path}</p>
                <p className="text-xs text-muted-foreground">{completed.size.toFixed(1)} MB</p>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="p-3 rounded bg-red-500/10 border border-red-500/30 text-sm text-red-400">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            {exporting ? (
              <Button variant="destructive" onClick={handleCancel}>
                Cancel
              </Button>
            ) : (
              <>
                <Button variant="outline" onClick={onClose}>
                  Close
                </Button>
                <Button
                  onClick={handleExport}
                  disabled={!outputDir || !fileName}
                >
                  <Download className="mr-2 h-4 w-4" />
                  Export
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
