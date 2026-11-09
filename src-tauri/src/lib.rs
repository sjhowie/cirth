mod error;
mod files;
mod format_json;
mod format_xml;
mod search;
mod settings;
mod tree;
mod watch;

use tauri_plugin_log::{Target, TargetKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([Target::new(TargetKind::Stdout), Target::new(TargetKind::LogDir { file_name: None })])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(watch::WatchState::default())
        .manage(search::SearchState::default())
        .invoke_handler(tauri::generate_handler![
            files::read_file,
            files::write_file,
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
