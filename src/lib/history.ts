import type { Clip, Subtitle, ZoomSegment } from "./ipc";

export interface EditorSnapshot {
  clips: Clip[];
  subtitles: Subtitle[];
  zoomSegments: ZoomSegment[];
}

const MAX_HISTORY = 50;

/**
 * Snapshot-based undo/redo history for the editor.
 * Push a snapshot after each meaningful edit. Undo/redo navigates the stack.
 */
export class HistoryManager {
  private stack: EditorSnapshot[] = [];
  private index = -1;

  /** Push a new snapshot. Truncates any redo history beyond the current position. */
  push(snapshot: EditorSnapshot): void {
    // Truncate redo tail
    this.stack = this.stack.slice(0, this.index + 1);
    this.stack.push(structuredClone(snapshot));
    this.index = this.stack.length - 1;

    // Enforce max depth
    if (this.stack.length > MAX_HISTORY) {
      this.stack.shift();
      this.index--;
    }
  }

  /** Undo: return the previous snapshot, or null if at the start. */
  undo(): EditorSnapshot | null {
    if (this.index <= 0) return null;
    this.index--;
    return structuredClone(this.stack[this.index]);
  }

  /** Redo: return the next snapshot, or null if at the end. */
  redo(): EditorSnapshot | null {
    if (this.index >= this.stack.length - 1) return null;
    this.index++;
    return structuredClone(this.stack[this.index]);
  }

  canUndo(): boolean { return this.index > 0; }
  canRedo(): boolean { return this.index < this.stack.length - 1; }

  /** Reset history (e.g., when loading a new session). */
  clear(): void {
    this.stack = [];
    this.index = -1;
  }
}
