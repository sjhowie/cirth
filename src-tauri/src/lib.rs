mod error;
mod files;
mod format_json;
mod format_xml;
mod search;
mod settings;
mod tree;
mod upload;
mod watch;

use serde::Serialize;
use tauri::{Emitter, Manager};
use tauri_plugin_log::{Target, TargetKind};

/// Set to `1` to skip the single-instance plugin (E2E launches many instances side by side).
const MULTI_INSTANCE_ENV: &str = "SIMPLEEDITOR_MULTI_INSTANCE";
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
    builder
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([Target::new(TargetKind::Stdout), Target::new(TargetKind::LogDir { file_name: None })])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(watch::WatchState::default())
        .manage(search::SearchState::default())
        .manage(upload::UploadState::default())
        .manage(tree::OpenPathsState::default())
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
