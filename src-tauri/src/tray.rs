use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    App, Emitter, Manager,
};

pub fn setup_tray(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItemBuilder::with_id("show", "Show ScreenCap").build(app)?;
    let start_rec = MenuItemBuilder::with_id("start_recording", "Start Recording").build(app)?;
    let stop_rec = MenuItemBuilder::with_id("stop_recording", "Stop Recording").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&show)
        .separator()
        .item(&start_rec)
        .item(&stop_rec)
        .separator()
        .item(&quit)
        .build()?;

    let icon = create_tray_icon();

    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("ScreenCap")
        .on_menu_event(move |app, event| {
            match event.id().as_ref() {
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "start_recording" => {
                    // Open region selector overlay instead of directly starting
                    let _ = crate::commands::show_region_selector(app.clone());
                }
                "stop_recording" => {
                    let _ = app.emit("tray-stop-recording", ());
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .build(app)?;

    Ok(())
}

/// Create a simple 16x16 RGBA icon (red circle on transparent background)
fn create_tray_icon() -> Image<'static> {
    let size = 16u32;
    let mut pixels = vec![0u8; (size * size * 4) as usize];
    let center = size as f64 / 2.0;
    let radius = 6.0;

    for y in 0..size {
        for x in 0..size {
            let dx = x as f64 - center;
            let dy = y as f64 - center;
            let dist = (dx * dx + dy * dy).sqrt();
            let idx = ((y * size + x) * 4) as usize;

            if dist <= radius {
                pixels[idx] = 239;     // R
                pixels[idx + 1] = 68;  // G
                pixels[idx + 2] = 68;  // B
                pixels[idx + 3] = 255; // A
            }
        }
    }

    Image::new_owned(pixels, size, size)
}
