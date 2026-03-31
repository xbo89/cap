use serde::{Deserialize, Serialize};
use crate::project::ZoomSegment;

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

/// Critically-damped spring (zeta = 1.0, no overshoot).
/// Must match the TypeScript implementation in lib/zoom.ts.
pub struct CriticallyDampedSpring {
    pub value: f64,
    pub velocity: f64,
    omega: f64,
}

impl CriticallyDampedSpring {
    pub fn new(initial_value: f64, omega: f64) -> Self {
        Self {
            value: initial_value,
            velocity: 0.0,
            omega,
        }
    }

    /// Advance the spring toward `target` by `dt` seconds.
    pub fn advance(&mut self, target: f64, dt: f64) -> f64 {
        let x = self.value - target;
        let v = self.velocity;
        let w = self.omega;
        let exp_term = (-w * dt).exp();
        self.value = target + (x + (v + w * x) * dt) * exp_term;
        self.velocity = (v - w * (v + w * x) * dt) * exp_term;
        self.value
    }

    pub fn reset(&mut self, value: f64) {
        self.value = value;
        self.velocity = 0.0;
    }
}

/// Find the active zoom segment at a given time.
pub fn find_active_segment(segments: &[ZoomSegment], time: f64) -> Option<&ZoomSegment> {
    segments.iter().find(|s| time >= s.start_time && time <= s.end_time)
}

/// Stateful zoom viewport calculator.
/// Uses exponential smoothing for smooth mouse following.
pub struct ZoomCalculator {
    frame_width: f64,
    frame_height: f64,
    center: Point,
    initialized: bool,
}

impl ZoomCalculator {
    pub fn new(frame_width: f64, frame_height: f64) -> Self {
        Self {
            frame_width,
            frame_height,
            center: Point {
                x: frame_width / 2.0,
                y: frame_height / 2.0,
            },
            initialized: false,
        }
    }

    /// Compute the viewport for a frame given mouse position, time delta,
    /// and the current spring-interpolated zoom level + follow speed.
    pub fn compute(&mut self, mouse: Point, dt: f64, zoom_level: f64, follow_speed: f64) -> Viewport {
        if !self.initialized {
            self.center = mouse;
            self.initialized = true;
        }

        let alpha = 1.0 - (-follow_speed * dt * 60.0).exp();
        self.center.x += (mouse.x - self.center.x) * alpha;
        self.center.y += (mouse.y - self.center.y) * alpha;

        let vw = self.frame_width / zoom_level;
        let vh = self.frame_height / zoom_level;

        let mut sx = self.center.x - vw / 2.0;
        let mut sy = self.center.y - vh / 2.0;

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

/// Batch compute viewports for an entire recording with segment-based zoom.
/// Used during export to pre-calculate all viewport positions.
pub fn compute_all_viewports(
    segments: &[ZoomSegment],
    frame_width: f64,
    frame_height: f64,
    mouse_events: &[(f64, f64, f64)], // (timestamp_secs, x, y)
) -> Vec<(f64, Viewport)> {
    let mut calc = ZoomCalculator::new(frame_width, frame_height);
    let mut spring = CriticallyDampedSpring::new(1.0, 10.0);
    let mut viewports = Vec::with_capacity(mouse_events.len());
    let mut prev_time = 0.0;

    for &(timestamp, x, y) in mouse_events {
        let dt = if timestamp > prev_time {
            timestamp - prev_time
        } else {
            1.0 / 60.0
        };
        prev_time = timestamp;

        let active = find_active_segment(segments, timestamp);
        let target_level = active.map(|s| s.zoom_level).unwrap_or(1.0);
        let follow_speed = active.map(|s| s.follow_speed).unwrap_or(0.15);

        let current_level = spring.advance(target_level, dt).max(1.0);

        // Always compute viewport — when level ≈ 1.0 it returns the full frame,
        // avoiding discontinuities at zoom transitions.
        let vp = calc.compute(Point { x, y }, dt, current_level, follow_speed);
        viewports.push((timestamp, vp));
    }

    viewports
}
