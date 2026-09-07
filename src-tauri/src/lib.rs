use serde::Serialize;

/// Raw pixels handed back to the frontend.
///
/// The bytes travel as a plain `Vec<u8>`, which Tauri v2 moves without base64
/// encoding — at 4096x4096 that is the difference between a snappy open and a
/// visible stall.
#[derive(Serialize)]
pub struct DecodedImage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Decode an image file to RGBA.
///
/// The web view already handles PNG, JPEG, WebP and GIF, so this exists for the
/// formats it cannot open — TIFF in particular, which is what print work tends
/// to arrive as.
#[tauri::command]
fn decode_image(path: String) -> Result<DecodedImage, String> {
    let img = image::open(&path).map_err(|e| format!("{path}: {e}"))?;
    let rgba = img.to_rgba8();
    Ok(DecodedImage {
        width: rgba.width(),
        height: rgba.height(),
        rgba: rgba.into_raw(),
    })
}

/// Extensions we can decode natively, so the frontend can widen its file filter
/// only when it is actually running inside the desktop shell.
#[tauri::command]
fn native_image_formats() -> Vec<String> {
    ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![decode_image, native_image_formats])
        .run(tauri::generate_context!())
        .expect("error while running Stipple");
}
