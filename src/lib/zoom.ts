/**
 * Zoom viewport calculator - must match the Rust implementation exactly.
 *
 * Uses exponential smoothing for smooth mouse-following zoom effect.
 * Supports per-segment zoom with critically-damped spring transitions.
 */

export interface ZoomConfig {
  /** Zoom magnification (e.g. 2.0 = 200%) */
  zoomLevel: number;
  /** Follow speed: 0 = no follow, 1 = instant snap */
  followSpeed: number;
  /** Min distance (px) from mouse to viewport edge */
  padding: number;
}

// Import and re-export from ipc to keep a single source of truth
import type { ZoomSegment } from "./ipc";
export type { ZoomSegment };

export interface Viewport {
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;
}

export const defaultZoomConfig: ZoomConfig = {
  zoomLevel: 2.0,
  followSpeed: 0.15,
  padding: 100.0,
};

export const defaultZoomSegment: Omit<ZoomSegment, "start_time" | "end_time"> = {
  zoom_level: 2.0,
  follow_speed: 0.15,
  padding: 100.0,
};

/**
 * Critically-damped spring (zeta = 1.0, no overshoot).
 * Must match the Rust implementation in export/zoom.rs.
 */
export class CriticallyDampedSpring {
  value: number;
  velocity: number;
  private omega: number;

  constructor(initialValue: number, omega = 10.0) {
    this.value = initialValue;
    this.velocity = 0;
    this.omega = omega;
  }

  /**
   * Advance the spring toward `target` by `dt` seconds.
   * Critically-damped: x(t) converges without oscillation.
   */
  advance(target: number, dt: number): number {
    const x = this.value - target;
    const v = this.velocity;
    const w = this.omega;
    const expTerm = Math.exp(-w * dt);
    this.value = target + (x + (v + w * x) * dt) * expTerm;
    this.velocity = (v - w * (v + w * x) * dt) * expTerm;
    return this.value;
  }

  reset(value: number) {
    this.value = value;
    this.velocity = 0;
  }
}

/** Find the active zoom segment at a given time, or null if none. */
export function findActiveSegment(segments: ZoomSegment[], time: number): ZoomSegment | null {
  for (const seg of segments) {
    if (time >= seg.start_time && time <= seg.end_time) {
      return seg;
    }
  }
  return null;
}

export class ZoomCalculator {
  private frameWidth: number;
  private frameHeight: number;
  private centerX: number;
  private centerY: number;
  private initialized = false;

  constructor(frameWidth: number, frameHeight: number) {
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;
    this.centerX = frameWidth / 2;
    this.centerY = frameHeight / 2;
  }

  /**
   * Compute viewport for a frame.
   * @param mouseX Mouse X position (screen coords)
   * @param mouseY Mouse Y position (screen coords)
   * @param dt Time delta in seconds since previous frame
   * @param zoomLevel Current (spring-interpolated) zoom level
   * @param followSpeed Follow speed for exponential smoothing
   */
  /**
   * @param anchorPos If provided, zoom anchors to this fixed point (no mouse follow).
   */
  compute(mouseX: number, mouseY: number, dt: number, zoomLevel: number, followSpeed: number, anchorPos?: { x: number; y: number }): Viewport {
    // Determine focus point: anchor or mouse
    const focusX = anchorPos ? anchorPos.x : mouseX;
    const focusY = anchorPos ? anchorPos.y : mouseY;

    if (!this.initialized) {
      this.centerX = focusX;
      this.centerY = focusY;
      this.initialized = true;
    }

    // Exponential smoothing - must match Rust: alpha = 1 - e^(-followSpeed * dt * 60)
    const speed = anchorPos ? Math.min(followSpeed, 0.03) : followSpeed; // anchored = very slow transition
    const alpha = 1.0 - Math.exp(-speed * dt * 60.0);
    this.centerX += (focusX - this.centerX) * alpha;
    this.centerY += (focusY - this.centerY) * alpha;

    // Viewport size
    const vw = this.frameWidth / zoomLevel;
    const vh = this.frameHeight / zoomLevel;

    // Top-left, clamped to frame
    let sx = this.centerX - vw / 2;
    let sy = this.centerY - vh / 2;
    sx = Math.max(0, Math.min(sx, this.frameWidth - vw));
    sy = Math.max(0, Math.min(sy, this.frameHeight - vh));

    return { srcX: sx, srcY: sy, srcW: vw, srcH: vh };
  }

  reset() {
    this.initialized = false;
    this.centerX = this.frameWidth / 2;
    this.centerY = this.frameHeight / 2;
  }
}
