/**
 * Zoom viewport calculator - must match the Rust implementation exactly.
 *
 * Uses exponential smoothing for smooth mouse-following zoom effect.
 * Supports per-segment zoom with critically-damped spring transitions.
 */

// Import and re-export from ipc to keep a single source of truth
import type { ZoomSegment } from "./ipc";
export type { ZoomSegment };

export interface Viewport {
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;
}

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

/**
 * Zoom states:
 * - idle: no zoom, center = frame center
 * - active: inside a zoom segment (locked or following mouse)
 * - recovering: segment ended, center smoothly returns to frame center
 *               while spring eases zoomLevel back to 1.0
 */
type ZoomState = "idle" | "active" | "recovering";

export class ZoomCalculator {
  private frameWidth: number;
  private frameHeight: number;
  private centerX: number;
  private centerY: number;
  private initialized = false;
  private state: ZoomState = "idle";

  /** The raw target set by snapCenter — preserved across clamp changes. */
  private targetX: number;
  private targetY: number;

  private static RECOVERY_SPEED = 0.12;

  constructor(frameWidth: number, frameHeight: number) {
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;
    this.centerX = frameWidth / 2;
    this.centerY = frameHeight / 2;
    this.targetX = frameWidth / 2;
    this.targetY = frameHeight / 2;
  }

  compute(focusX: number, focusY: number, dt: number, zoomLevel: number, followMouse: boolean, followSpeed: number): Viewport {
    const vw = this.frameWidth / zoomLevel;
    const vh = this.frameHeight / zoomLevel;

    // Valid center range for current zoom level
    const minCX = vw / 2;
    const maxCX = this.frameWidth - vw / 2;
    const minCY = vh / 2;
    const maxCY = this.frameHeight - vh / 2;

    if (this.state === "active") {
      if (followMouse) {
        // Follow mode: smooth toward current mouse position
        const tx = Math.max(minCX, Math.min(focusX, maxCX));
        const ty = Math.max(minCY, Math.min(focusY, maxCY));

        if (!this.initialized) {
          this.centerX = tx;
          this.centerY = ty;
          this.initialized = true;
        }

        const alpha = 1.0 - Math.exp(-followSpeed * dt * 60.0);
        this.centerX += (tx - this.centerX) * alpha;
        this.centerY += (ty - this.centerY) * alpha;
      } else {
        // Locked mode: clamp the stored target to the current valid range,
        // then snap center there. As zoom increases the range widens,
        // so center progressively reaches the true target.
        this.centerX = Math.max(minCX, Math.min(this.targetX, maxCX));
        this.centerY = Math.max(minCY, Math.min(this.targetY, maxCY));
      }
    } else if (this.state === "recovering") {
      const midX = this.frameWidth / 2;
      const midY = this.frameHeight / 2;
      const alpha = 1.0 - Math.exp(-ZoomCalculator.RECOVERY_SPEED * dt * 60.0);
      this.centerX += (midX - this.centerX) * alpha;
      this.centerY += (midY - this.centerY) * alpha;

      if (zoomLevel < 1.01) {
        this.state = "idle";
        this.centerX = midX;
        this.centerY = midY;
        this.initialized = false;
      }
    }

    // Final clamp (safety net for follow/recovery modes)
    this.centerX = Math.max(minCX, Math.min(this.centerX, maxCX));
    this.centerY = Math.max(minCY, Math.min(this.centerY, maxCY));

    return {
      srcX: this.centerX - vw / 2,
      srcY: this.centerY - vh / 2,
      srcW: vw,
      srcH: vh,
    };
  }

  /** Snap center to a point and enter active state. */
  snapCenter(x: number, y: number) {
    this.targetX = x;
    this.targetY = y;
    this.centerX = x;
    this.centerY = y;
    this.initialized = true;
    this.state = "active";
  }

  /** Begin smooth recovery back to frame center. */
  beginRecovery() {
    this.state = "recovering";
  }

  /** Hard reset to idle. */
  reset() {
    this.initialized = false;
    this.state = "idle";
    this.centerX = this.frameWidth / 2;
    this.centerY = this.frameHeight / 2;
    this.targetX = this.frameWidth / 2;
    this.targetY = this.frameHeight / 2;
  }
}
