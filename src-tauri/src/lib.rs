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
    ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "jxl"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// RGBA pixels to lossless WebP, for the web view that cannot encode it.
///
/// WebKit's canvas hands back a PNG when asked for WebP, so the desktop app
/// encodes here. The body is raw RGBA; `x-size` says `width height`.
#[tauri::command]
fn encode_webp(request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> {
    let body = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes,
        _ => return Err("encode_webp expects a raw body".into()),
    };
    let size = request
        .headers()
        .get("x-size")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing x-size")?;
    let mut it = size.split_whitespace().map(|s| s.parse::<u32>());
    let (w, h) = match (it.next(), it.next()) {
        (Some(Ok(w)), Some(Ok(h))) => (w, h),
        _ => return Err("bad x-size".into()),
    };
    if body.len() != (w as usize) * (h as usize) * 4 {
        return Err("pixel data does not match the size".into());
    }
    let mut out = Vec::new();
    image::codecs::webp::WebPEncoder::new_lossless(&mut out)
        .encode(body, w, h, image::ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(out))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![decode_image, native_image_formats, encode_webp])
        .run(tauri::generate_context!())
        .expect("error while running Stipple");
}
