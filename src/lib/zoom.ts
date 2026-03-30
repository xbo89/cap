/**
 * Zoom viewport calculator - must match the Rust implementation exactly.
 *
 * Uses exponential smoothing for smooth mouse-following zoom effect.
 */

export interface ZoomConfig {
  /** Zoom magnification (e.g. 2.0 = 200%) */
  zoomLevel: number;
  /** Follow speed: 0 = no follow, 1 = instant snap */
  followSpeed: number;
  /** Min distance (px) from mouse to viewport edge */
  padding: number;
}

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

export class ZoomCalculator {
  private config: ZoomConfig;
  private frameWidth: number;
  private frameHeight: number;
  private centerX: number;
  private centerY: number;
  private initialized = false;

  constructor(config: ZoomConfig, frameWidth: number, frameHeight: number) {
    this.config = config;
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
   */
  compute(mouseX: number, mouseY: number, dt: number): Viewport {
    if (!this.initialized) {
      this.centerX = mouseX;
      this.centerY = mouseY;
      this.initialized = true;
    }

    // Exponential smoothing - must match Rust: alpha = 1 - e^(-followSpeed * dt * 60)
    const alpha = 1.0 - Math.exp(-this.config.followSpeed * dt * 60.0);
    this.centerX += (mouseX - this.centerX) * alpha;
    this.centerY += (mouseY - this.centerY) * alpha;

    // Viewport size
    const vw = this.frameWidth / this.config.zoomLevel;
    const vh = this.frameHeight / this.config.zoomLevel;

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

  updateConfig(config: Partial<ZoomConfig>) {
    Object.assign(this.config, config);
  }
}
