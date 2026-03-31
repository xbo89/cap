import { useState, useEffect, useCallback } from "react";
import { emit } from "@tauri-apps/api/event";
import { ipc, type SessionInfo } from "@/lib/ipc";
import { Trash2, FolderOpen } from "lucide-react";

interface SessionSidebarProps {
  currentSessionId?: string;
  onOpenSession?: (sessionId: string) => void;
  standalone?: boolean;
}

export function SessionSidebar({ currentSessionId, onOpenSession, standalone }: SessionSidebarProps) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      const list = await ipc.listSessions();
      setSessions(list);

      // Generate thumbnails for sessions that don't have one
      for (const s of list) {
        if (!s.thumbnail_path) {
          ipc.generateThumbnail(s.session_id).catch(() => {});
        }
      }
    } catch (e) {
      console.error("Failed to list sessions:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const handleDelete = useCallback(async (sessionId: string) => {
    try {
      await ipc.deleteSession(sessionId);
      setSessions((prev) => prev.filter((s) => s.session_id !== sessionId));
      setConfirmDelete(null);
    } catch (e) {
      console.error("Failed to delete session:", e);
    }
  }, []);

  const formatDate = (timestamp: string) => {
    const secs = parseInt(timestamp, 10);
    if (isNaN(secs) || secs === 0) return "Unknown";
    const d = new Date(secs * 1000);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  const formatDuration = (secs: number) => {
    if (secs <= 0) return "\u2014"; // em-dash for unknown
    if (secs < 60) return `${Math.round(secs)}s`;
    const m = Math.floor(secs / 60);
    const s = Math.round(secs % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <div className={`${standalone ? "w-full h-full" : "w-64 border-r border-border"} flex flex-col bg-background`}>
      <div className="px-3 py-2 border-b border-border">
        <h3 className="text-sm font-medium text-foreground">Recordings</h3>
        <p className="text-xs text-muted-foreground mt-0.5">{sessions.length} sessions</p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="p-4 text-sm text-muted-foreground text-center">Loading...</div>
        )}

        {!loading && sessions.length === 0 && (
          <div className="p-4 text-sm text-muted-foreground text-center">No recordings yet</div>
        )}

        {sessions.map((session) => {
          const isCurrent = session.session_id === currentSessionId;
          const thumbUrl = session.thumbnail_path
            ? `stream://localhost/${encodeURIComponent(session.thumbnail_path)}`
            : undefined;

          return (
            <div
              key={session.session_id}
              className={`group flex items-start gap-2 px-3 py-2 border-b border-border/50 hover:bg-accent/50 cursor-pointer ${
                isCurrent ? "bg-accent" : ""
              }`}
              onClick={() => {
                if (onOpenSession) {
                  onOpenSession(session.session_id);
                } else {
                  emit("open-session", { session_id: session.session_id });
                }
              }}
            >
              {/* Thumbnail */}
              <div className="w-16 h-10 rounded bg-muted flex-shrink-0 overflow-hidden">
                {thumbUrl ? (
                  <img src={thumbUrl} className="w-full h-full object-cover" alt="" />
                ) : (
                  <div className="w-full h-full bg-muted-foreground/10" />
                )}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="text-xs text-foreground truncate">
                  {formatDuration(session.duration_secs)} &middot; {session.file_size_mb.toFixed(1)} MB
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  {formatDate(session.created_at)}
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded"
                  onClick={(e) => { e.stopPropagation(); ipc.showInFinder(session.session_id); }}
                  title="Open in Finder"
                >
                  <FolderOpen className="h-3 w-3" />
                </button>
                {confirmDelete === session.session_id ? (
                  <button
                    className="p-1 text-red-500 hover:bg-red-500/10 rounded text-[10px] font-medium"
                    onClick={(e) => { e.stopPropagation(); handleDelete(session.session_id); }}
                  >
                    Confirm
                  </button>
                ) : (
                  <button
                    className="p-1 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 rounded"
                    onClick={(e) => { e.stopPropagation(); setConfirmDelete(session.session_id); }}
                    title="Delete"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
