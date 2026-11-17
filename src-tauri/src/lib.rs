mod error;
mod files;
mod format_json;
mod format_xml;
mod migrate;
mod search;
mod settings;
mod tree;
mod upload;
mod watch;

use serde::Serialize;
use tauri::{Emitter, Manager};
use tauri_plugin_log::{Target, TargetKind};

/// Set to `1` to skip the single-instance plugin (E2E launches many instances side by side).
const MULTI_INSTANCE_ENV: &str = "CIRTH_MULTI_INSTANCE";
/// Set to `1` to stop the frontend's background update checks (E2E runs stay offline and deterministic).
const NO_UPDATE_CHECK_ENV: &str = "CIRTH_NO_UPDATE_CHECK";
const OPEN_PATHS_EVENT: &str = "app://open-paths";

#[derive(Clone, Serialize)]
struct OpenPaths {
    paths: Vec<String>,
}

/// A second launch handed us its argv: resolve against its cwd, forward to the main window, focus it.
#[cfg(desktop)]
fn on_second_instance(app: &tauri::AppHandle, argv: Vec<String>, cwd: String) {
    let paths = tree::startup_paths_from(argv.into_iter().skip(1), std::path::Path::new(&cwd));
    let Some(window) = app.get_webview_window("main") else {
        log::error!("single-instance: no main window to hand {} path(s) to", paths.len());
        return;
    };
    // Queued until the frontend has subscribed and called get_startup_paths; emitted directly after.
    if let Some(paths) = app.state::<tree::OpenPathsState>().deliver(paths)
        && let Err(e) = window.emit(OPEN_PATHS_EVENT, OpenPaths { paths })
    {
        log::error!("single-instance: emit {OPEN_PATHS_EVENT} failed: {e}");
    }
    if let Err(e) = window.unminimize() {
        log::error!("single-instance: unminimize failed: {e}");
    }
    if let Err(e) = window.set_focus() {
        log::error!("single-instance: set_focus failed: {e}");
    }
}

/// The editor background (`--bg-editor` in app.css) per theme. The window and WebView2 show it until the page paints.
const BG_LIGHT: tauri::window::Color = tauri::window::Color(0xff, 0xff, 0xff, 0xff);
const BG_DARK: tauri::window::Color = tauri::window::Color(0x28, 0x2c, 0x34, 0xff);

/// Creates the main window (`"create": false` in tauri.conf.json) hidden, gives it the theme's background, then shows it.
/// Without this, a dark theme opens on a white window for about 300 ms (WebView2's default background before first paint).
/// The theme setting is also injected into the page so its first paint already uses the right theme (see app.html).
fn create_main_window(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let config = app.config().app.windows.iter().find(|w| w.label == "main").cloned().ok_or("tauri.conf.json has no \"main\" window")?;
    migrate::from_old_name(app.handle());
    let theme = settings::load(app.handle()).theme;
    let update_check = !std::env::var(NO_UPDATE_CHECK_ENV).is_ok_and(|v| v == "1");
    let window = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
        .initialization_script(format!(
            "window.__CIRTH_THEME__ = {}; window.__CIRTH_UPDATE_CHECK__ = {update_check};",
            serde_json::to_string(&theme)?
        ))
        .build()?;
    let dark = match theme {
        settings::Theme::Dark => true,
        settings::Theme::Light => false,
        settings::Theme::System => match window.theme() {
            Ok(t) => t == tauri::Theme::Dark,
            Err(e) => {
                log::error!("startup: cannot read the system theme ({e}); assuming light");
                false
            }
        },
    };
    window.set_background_color(Some(if dark { BG_DARK } else { BG_LIGHT }))?;
    window.show()?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // Must be the first plugin registered.
    #[cfg(desktop)]
    let builder = if std::env::var(MULTI_INSTANCE_ENV).is_ok_and(|v| v == "1") {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(on_second_instance))
    };
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([Target::new(TargetKind::Stdout), Target::new(TargetKind::LogDir { file_name: None })])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .manage(watch::WatchState::default())
        .manage(search::SearchState::default())
        .manage(upload::UploadState::default())
        .manage(tree::OpenPathsState::default())
        .setup(create_main_window)
        .invoke_handler(tauri::generate_handler![
            files::read_file,
            files::write_file,
            upload::upload_begin,
            upload::upload_chunk,
            upload::upload_discard,
            format_json::format_json,
            format_xml::format_xml,
            tree::list_dir,
            tree::list_files,
            tree::create_file,
            tree::create_dir,
            tree::rename_path,
            tree::trash_path,
            tree::get_startup_paths,
            watch::watch_paths,
            search::search_folder,
            search::cancel_search,
            search::replace_in_folder,
            settings::load_settings,
            settings::save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
