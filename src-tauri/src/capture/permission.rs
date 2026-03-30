/// Check and request screen capture permission on macOS.
/// Returns true if permission is granted.
#[cfg(target_os = "macos")]
pub fn check_screen_capture_permission() -> bool {
    use std::process::Command;

    // Use a small swift snippet to check CGPreflightScreenCaptureAccess
    let output = Command::new("swift")
        .args(["-e", "import CoreGraphics; print(CGPreflightScreenCaptureAccess())"])
        .output();

    match output {
        Ok(o) => {
            let result = String::from_utf8_lossy(&o.stdout).trim().to_string();
            result == "true"
        }
        Err(_) => false,
    }
}

/// Request screen recording permission. This triggers the macOS permission dialog.
/// Only works when called from an app bundle (not terminal).
#[cfg(target_os = "macos")]
pub fn request_screen_capture_permission() -> bool {
    use std::process::Command;

    let output = Command::new("swift")
        .args(["-e", "import CoreGraphics; print(CGRequestScreenCaptureAccess())"])
        .output();

    match output {
        Ok(o) => {
            let result = String::from_utf8_lossy(&o.stdout).trim().to_string();
            result == "true"
        }
        Err(_) => false,
    }
}

/// Open System Settings to the Screen Recording privacy pane
#[cfg(target_os = "macos")]
pub fn open_screen_recording_settings() {
    use std::process::Command;
    let _ = Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        .spawn();
}

#[cfg(not(target_os = "macos"))]
pub fn check_screen_capture_permission() -> bool { true }
#[cfg(not(target_os = "macos"))]
pub fn request_screen_capture_permission() -> bool { true }
#[cfg(not(target_os = "macos"))]
pub fn open_screen_recording_settings() {}
