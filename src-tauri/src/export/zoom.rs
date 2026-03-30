use serde::{Deserialize, Serialize};

/// Zoom effect configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZoomConfig {
    /// Zoom magnification level (e.g. 2.0 = 200%)
    pub zoom_level: f64,
    /// Follow speed: 0.0 = no follow, 1.0 = instant snap
    /// Controls the exponential smoothing alpha
    pub follow_speed: f64,
    /// Minimum distance (px) from mouse to viewport edge
    pub padding: f64,
}

impl Default for ZoomConfig {
    fn default() -> Self {
        Self {
            zoom_level: 2.0,
            follow_speed: 0.15,
            padding: 100.0,
        }
    }
}

/// Represents a 2D point
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// Represents the computed viewport for a single frame
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Viewport {
    /// Source rectangle in the original video
    pub src_x: f64,
    pub src_y: f64,
    pub src_w: f64,
    pub src_h: f64,
}

/// Stateful zoom viewport calculator.
/// Uses exponential smoothing for smooth mouse following.
pub struct ZoomCalculator {
    config: ZoomConfig,
    /// Full frame dimensions
    frame_width: f64,
    frame_height: f64,
    /// Current smoothed viewport center
    center: Point,
    initialized: bool,
}

impl ZoomCalculator {
    pub fn new(config: ZoomConfig, frame_width: f64, frame_height: f64) -> Self {
        Self {
            config,
            frame_width,
            frame_height,
            center: Point {
                x: frame_width / 2.0,
                y: frame_height / 2.0,
            },
            initialized: false,
        }
    }

    /// Compute the viewport for a frame given mouse position and time delta.
    ///
    /// `dt` is the time in seconds since the previous frame.
    /// `mouse` is the current mouse position in screen coordinates.
    ///
    /// Returns the source rectangle to crop from the original frame.
    pub fn compute(&mut self, mouse: Point, dt: f64) -> Viewport {
        if !self.initialized {
            self.center = mouse;
            self.initialized = true;
        }

        // Exponential smoothing: viewport_center moves toward mouse position
        // alpha = 1 - e^(-follow_speed * dt * 60)
        // The *60 normalizes so follow_speed feels consistent regardless of framerate
        let alpha = 1.0 - (-self.config.follow_speed * dt * 60.0).exp();
        self.center.x += (mouse.x - self.center.x) * alpha;
        self.center.y += (mouse.y - self.center.y) * alpha;

        // Viewport size at current zoom level
        let vw = self.frame_width / self.config.zoom_level;
        let vh = self.frame_height / self.config.zoom_level;

        // Compute top-left of viewport, clamped to frame bounds
        let mut sx = self.center.x - vw / 2.0;
        let mut sy = self.center.y - vh / 2.0;

        // Clamp to frame boundaries
        sx = sx.clamp(0.0, self.frame_width - vw);
        sy = sy.clamp(0.0, self.frame_height - vh);

        Viewport {
            src_x: sx,
            src_y: sy,
            src_w: vw,
            src_h: vh,
        }
    }

    pub fn reset(&mut self) {
        self.initialized = false;
        self.center = Point {
            x: self.frame_width / 2.0,
            y: self.frame_height / 2.0,
        };
    }
}

/// Batch compute viewports for an entire recording.
/// Used during export to pre-calculate all viewport positions.
pub fn compute_all_viewports(
    config: &ZoomConfig,
    frame_width: f64,
    frame_height: f64,
    mouse_events: &[(f64, f64, f64)], // (timestamp_secs, x, y)
) -> Vec<Viewport> {
    let mut calc = ZoomCalculator::new(config.clone(), frame_width, frame_height);
    let mut viewports = Vec::with_capacity(mouse_events.len());
    let mut prev_time = 0.0;

    for &(timestamp, x, y) in mouse_events {
        let dt = if timestamp > prev_time {
            timestamp - prev_time
        } else {
            1.0 / 60.0
        };
        prev_time = timestamp;
        viewports.push(calc.compute(Point { x, y }, dt));
    }

    viewports
}
