use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MouseEvent {
    /// Timestamp in microseconds since recording start
    pub timestamp_us: u64,
    /// Mouse X position (screen coordinates)
    pub x: f64,
    /// Mouse Y position (screen coordinates)
    pub y: f64,
    /// Mouse button state (0 = none, 1 = left, 2 = right, 3 = both)
    pub buttons: u8,
}

pub struct MouseTracker {
    events: Arc<Mutex<Vec<MouseEvent>>>,
    start_time: Instant,
    running: Arc<Mutex<bool>>,
}

impl MouseTracker {
    pub fn new() -> Self {
        Self {
            events: Arc::new(Mutex::new(Vec::new())),
            start_time: Instant::now(),
            running: Arc::new(Mutex::new(false)),
        }
    }

    /// Start tracking mouse position and button state by polling
    pub fn start(&mut self) {
        self.start_time = Instant::now();
        *self.running.lock().unwrap() = true;

        let events = self.events.clone();
        let running = self.running.clone();
        let start_time = self.start_time;

        std::thread::spawn(move || {
            while *running.lock().unwrap() {
                let (x, y) = get_cursor_position();
                let buttons = get_mouse_buttons();
                let elapsed = start_time.elapsed();
                let event = MouseEvent {
                    timestamp_us: elapsed.as_micros() as u64,
                    x,
                    y,
                    buttons,
                };
                events.lock().unwrap().push(event);
                // Poll at ~120Hz for smooth tracking
                std::thread::sleep(std::time::Duration::from_micros(8333));
            }
        });
    }

    pub fn stop(&self) -> Vec<MouseEvent> {
        *self.running.lock().unwrap() = false;
        std::thread::sleep(std::time::Duration::from_millis(20));
        self.events.lock().unwrap().clone()
    }
}

/// Get current cursor position using CoreGraphics
fn get_cursor_position() -> (f64, f64) {
    #[cfg(target_os = "macos")]
    {
        use core_graphics::event::CGEvent;
        use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

        if let Ok(source) = CGEventSource::new(CGEventSourceStateID::CombinedSessionState) {
            if let Ok(event) = CGEvent::new(source) {
                let point = event.location();
                return (point.x, point.y);
            }
        }
        (0.0, 0.0)
    }
    #[cfg(not(target_os = "macos"))]
    {
        (0.0, 0.0)
    }
}

/// Get current mouse button state using CoreGraphics C API
fn get_mouse_buttons() -> u8 {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn CGEventSourceButtonState(stateID: u32, button: u32) -> bool;
        }
        let mut buttons: u8 = 0;
        unsafe {
            // CGEventSourceStateID::CombinedSessionState = 0
            if CGEventSourceButtonState(0, 0) { buttons |= 1; } // Left button = 0
            if CGEventSourceButtonState(0, 1) { buttons |= 2; } // Right button = 1
        }
        buttons
    }
    #[cfg(not(target_os = "macos"))]
    {
        0
    }
}
