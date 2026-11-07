use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Mutex,
};

use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(any(target_os = "macos", target_os = "ios"))]
use tauri::RunEvent;

/// Windows 旧版路径：%AppData%\KanPDF\data.json（v2.4 前）
#[cfg(windows)]
fn legacy_data_file() -> Option<PathBuf> {
    let p = PathBuf::from(std::env::var("APPDATA").ok()?)
        .join("KanPDF")
        .join("data.json");
    p.exists().then_some(p)
}

#[cfg(not(windows))]
fn legacy_data_file() -> Option<PathBuf> {
    None
}

/// 跨平台：Tauri app_data_dir()/data.json
fn data_file(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("failed to resolve app data directory")
        .join("data.json")
}

fn ensure_data_migrated(app: &AppHandle) {
    let new_p = data_file(app);
    if new_p.exists() {
        return;
    }
    let Some(old_p) = legacy_data_file() else {
        return;
    };
    if let Some(dir) = new_p.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::copy(&old_p, &new_p);
}

/// 首次启动时传入的 PDF 路径（前端 ready 后通过 invoke 取走）
struct LaunchPdf(Mutex<Option<String>>);

fn trim_arg(raw: &str) -> &str {
    raw.trim().trim_matches('"').trim()
}

fn looks_like_windows_path(s: &str) -> bool {
    let bytes = s.as_bytes();
    if s.starts_with("\\\\") {
        return true;
    }
    bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic()
}

fn path_from_open_arg(raw: &str) -> Option<PathBuf> {
    let s = trim_arg(raw);
    if s.is_empty() || s.starts_with('-') {
        return None;
    }

    if s.starts_with("file:") {
        if let Ok(url) = url::Url::parse(s) {
            return url.to_file_path().ok();
        }
    }

    // C:/Users/... parses as URL scheme "c" and loses the path — treat as native path first.
    if looks_like_windows_path(s) {
        return Some(PathBuf::from(s));
    }

    if let Ok(url) = url::Url::parse(s) {
        if url.scheme() == "file" {
            return url.to_file_path().ok();
        }
    }

    Some(PathBuf::from(s))
}

fn has_pdf_magic(path: &Path) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut buf = [0u8; 5];
    file.read_exact(&mut buf).is_ok() && buf == *b"%PDF-"
}

fn is_pdf_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    if path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
    {
        return true;
    }
    has_pdf_magic(path)
}

fn pdf_paths_from_args<S, I>(args: I) -> Vec<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .filter_map(|arg| path_from_open_arg(arg.as_ref()))
        .filter(|p| is_pdf_file(p))
        .collect()
}

fn allow_pdf_files(app: &AppHandle, files: &[PathBuf]) {
    let scope = app.asset_protocol_scope();
    for file in files {
        let _ = scope.allow_file(file);
    }
}

fn open_pdf_files(app: &AppHandle, files: Vec<PathBuf>) {
    if files.is_empty() {
        return;
    }
    allow_pdf_files(app, &files);
    if let Some(path) = files.first() {
        let path_str = path.to_string_lossy().into_owned();
        let _ = app.emit("open-pdf", path_str);
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }
}

#[tauri::command]
fn load_data(app: AppHandle) -> String {
    ensure_data_migrated(&app);
    fs::read_to_string(data_file(&app)).unwrap_or_default()
}

#[tauri::command]
fn save_data(app: AppHandle, content: String) -> Result<(), String> {
    ensure_data_migrated(&app);
    let p = data_file(&app);
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&p, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn pdf_file_size(path: String) -> Result<u64, String> {
    let p = PathBuf::from(path);
    if !p.is_file() {
        return Err("file not found".into());
    }
    fs::metadata(&p).map(|m| m.len()).map_err(|e| e.to_string())
}

/// 整文件读入内存；仅适合小文件或测试。大 PDF 请在前端用 read_pdf_chunk 分块读取。
#[tauri::command]
fn read_pdf_bytes(path: String) -> Result<Vec<u8>, String> {
    let p = PathBuf::from(path);
    if !is_pdf_file(&p) {
        return Err("not a pdf file".into());
    }
    fs::read(&p).map_err(|e| e.to_string())
}

/// 大文件分块读取：二进制 IPC 直传（ArrayBuffer），绕开 asset 协议在
/// WebView2 上大响应体不稳定的问题。
#[tauri::command]
fn read_pdf_chunk(path: String, offset: u64, len: u64) -> Result<tauri::ipc::Response, String> {
    const MAX_CHUNK: u64 = 32 * 1024 * 1024;
    let p = PathBuf::from(path);
    if !is_pdf_file(&p) {
        return Err("not a pdf file".into());
    }
    if len == 0 || len > MAX_CHUNK {
        return Err("bad chunk length".into());
    }
    let mut f = fs::File::open(&p).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; len as usize];
    let mut total = 0usize;
    while total < buf.len() {
        let n = f.read(&mut buf[total..]).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        total += n;
    }
    buf.truncate(total);
    Ok(tauri::ipc::Response::new(buf))
}

#[tauri::command]
fn take_launch_pdf(state: State<'_, LaunchPdf>) -> Option<String> {
    state.0.lock().unwrap().take()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_forward_slash_path_is_not_dropped() {
        let p = path_from_open_arg("C:/Users/test/file.pdf").expect("path");
        assert_eq!(p, PathBuf::from("C:/Users/test/file.pdf"));
    }

    #[test]
    fn windows_backslash_path_works() {
        let p = path_from_open_arg(r"C:\Users\test\file.pdf").expect("path");
        assert_eq!(p, PathBuf::from(r"C:\Users\test\file.pdf"));
    }

    #[test]
    fn quoted_path_is_trimmed() {
        let p = path_from_open_arg(r#""C:\Users\test\file.pdf""#).expect("path");
        assert_eq!(p, PathBuf::from(r"C:\Users\test\file.pdf"));
    }

    #[test]
    fn file_url_works() {
        let p = path_from_open_arg("file:///C:/Users/test/file.pdf").expect("path");
        assert_eq!(p, PathBuf::from(r"C:\Users\test\file.pdf"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let files = pdf_paths_from_args(argv);
            open_pdf_files(app, files);
        }));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(LaunchPdf(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            load_data,
            save_data,
            take_launch_pdf,
            pdf_file_size,
            read_pdf_bytes,
            read_pdf_chunk
        ])
        .setup(|app| {
            ensure_data_migrated(app.handle());

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
            {
                let files = pdf_paths_from_args(std::env::args().skip(1));
                if let Some(first) = files.first() {
                    allow_pdf_files(app.handle(), &files);
                    *app.state::<LaunchPdf>().0.lock().unwrap() =
                        Some(first.to_string_lossy().into_owned());
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(#[allow(unused_variables)] |app, event| {
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let RunEvent::Opened { urls } = event {
                let files: Vec<PathBuf> = urls
                    .into_iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .filter(|p| is_pdf_file(p))
                    .collect();
                open_pdf_files(&app, files);
            }
        });
}
