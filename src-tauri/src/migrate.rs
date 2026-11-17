//! One-time carry-over from the app's old name (SimpleEditor, identifier `com.simpleeditor.app`) to Cirth.
//! Copies the settings file and the WebView2 Local Storage (recent files and commands, sidebar width) into the
//! new identifier's folders, only when the new ones don't exist yet. The old folders are left as they were.

use std::io;
use std::path::Path;
use tauri::Manager;

const OLD_IDENTIFIER: &str = "com.simpleeditor.app";

/// Runs before the main window is created (the WebView2 profile must not be in use yet).
pub fn from_old_name(app: &tauri::AppHandle) {
    if let Some(dir) = crate::settings::config_dir_override() {
        log::info!("migrate: skipped, {} is set ({})", crate::settings::CONFIG_DIR_ENV, dir.display());
        return;
    }
    let paths = app.path();
    // Once only: the new config folder is created here, so a settings.json deleted later (by the user or E2E) stays deleted.
    if let (Ok(config_root), Ok(new_config)) = (paths.config_dir(), paths.app_config_dir())
        && !new_config.exists()
    {
        let from = config_root.join(OLD_IDENTIFIER).join("settings.json");
        report("settings", copy_file_if_missing(&from, &new_config.join("settings.json")));
        if let Err(e) = std::fs::create_dir_all(&new_config) {
            log::error!("migrate: cannot create {}: {e}", new_config.display());
        }
    }
    if let (Ok(local_root), Ok(new_local)) = (paths.local_data_dir(), paths.app_local_data_dir()) {
        let storage = Path::new("EBWebView").join("Default").join("Local Storage");
        let from = local_root.join(OLD_IDENTIFIER).join(&storage);
        // Only into a fresh profile: once the new WebView2 profile exists, its data wins.
        if !new_local.join("EBWebView").exists() {
            report("local storage", copy_dir(&from, &new_local.join(&storage)).map(|n| n > 0));
        }
    }
}

fn report(what: &str, result: io::Result<bool>) {
    match result {
        Ok(true) => log::info!("migrate: copied {what} from {OLD_IDENTIFIER}"),
        Ok(false) => {}
        Err(e) => log::error!("migrate: cannot copy {what} from {OLD_IDENTIFIER}: {e}"),
    }
}

/// Copies `from` to `to` when `from` exists and `to` doesn't. Returns whether it copied.
fn copy_file_if_missing(from: &Path, to: &Path) -> io::Result<bool> {
    if !from.is_file() || to.exists() {
        return Ok(false);
    }
    if let Some(dir) = to.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::copy(from, to)?;
    Ok(true)
}

/// Recursively copies the files under `from` into `to`. A missing `from` copies nothing. Returns the file count.
fn copy_dir(from: &Path, to: &Path) -> io::Result<usize> {
    if !from.is_dir() {
        return Ok(0);
    }
    std::fs::create_dir_all(to)?;
    let mut count = 0;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            count += copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
            count += 1;
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_copied_only_when_target_missing() {
        let d = tempfile::tempdir().unwrap();
        let from = d.path().join("old").join("settings.json");
        let to = d.path().join("new").join("settings.json");
        assert!(!copy_file_if_missing(&from, &to).unwrap(), "missing source copies nothing");
        std::fs::create_dir_all(from.parent().unwrap()).unwrap();
        std::fs::write(&from, "old").unwrap();
        assert!(copy_file_if_missing(&from, &to).unwrap());
        assert_eq!(std::fs::read_to_string(&to).unwrap(), "old");
        std::fs::write(&to, "new").unwrap();
        assert!(!copy_file_if_missing(&from, &to).unwrap(), "existing target is kept");
        assert_eq!(std::fs::read_to_string(&to).unwrap(), "new");
    }

    #[test]
    fn dir_copied_recursively() {
        let d = tempfile::tempdir().unwrap();
        let from = d.path().join("a");
        std::fs::create_dir_all(from.join("leveldb")).unwrap();
        std::fs::write(from.join("x.log"), "1").unwrap();
        std::fs::write(from.join("leveldb").join("y.ldb"), "2").unwrap();
        let to = d.path().join("b").join("c");
        assert_eq!(copy_dir(&from, &to).unwrap(), 2);
        assert_eq!(std::fs::read_to_string(to.join("leveldb").join("y.ldb")).unwrap(), "2");
        assert_eq!(copy_dir(&d.path().join("none"), &to).unwrap(), 0);
    }
}
