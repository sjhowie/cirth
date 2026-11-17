//! Persistent settings (`settings.json` in the app config dir).

use crate::error::{AppError, blocking};
use crate::files::write_atomic;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum IndentSetting {
    #[serde(rename = "2")]
    Two,
    #[serde(rename = "4")]
    Four,
    #[serde(rename = "tab")]
    Tab,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: Theme,
    pub font_family: String,
    pub font_size: f64,
    pub indent: IndentSetting,
    pub large_file_threshold_mb: f64,
    pub word_wrap: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: Theme::System,
            font_family: "Cascadia Code, Consolas, Menlo, monospace".to_string(),
            font_size: 14.0,
            indent: IndentSetting::Two,
            large_file_threshold_mb: 10.0,
            word_wrap: false,
        }
    }
}

/// Set to a folder to keep `settings.json` there instead of the app config dir (E2E isolation).
/// Also skips the one-time migration from the old app name.
pub const CONFIG_DIR_ENV: &str = "CIRTH_CONFIG_DIR";

/// The `CIRTH_CONFIG_DIR` folder, if set and non-empty.
pub fn config_dir_override() -> Option<PathBuf> {
    override_from(std::env::var_os(CONFIG_DIR_ENV))
}

fn override_from(value: Option<std::ffi::OsString>) -> Option<PathBuf> {
    value.filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// One field of the settings object: missing -> default silently; invalid -> default, logged.
fn field<T: serde::de::DeserializeOwned>(obj: &Map<String, Value>, key: &str, default: T, path: &Path) -> T {
    match obj.get(key) {
        None => default,
        Some(v) => serde_json::from_value(v.clone()).unwrap_or_else(|e| {
            log::error!("settings: {}: invalid \"{key}\" ({v}): {e}; using the default", path.display());
            default
        }),
    }
}

/// Each field is taken on its own, so one bad value resets only that setting.
fn from_object(obj: &Map<String, Value>, path: &Path) -> Settings {
    let d = Settings::default();
    Settings {
        theme: field(obj, "theme", d.theme, path),
        font_family: field(obj, "fontFamily", d.font_family, path),
        font_size: field(obj, "fontSize", d.font_size, path),
        indent: field(obj, "indent", d.indent, path),
        large_file_threshold_mb: field(obj, "largeFileThresholdMb", d.large_file_threshold_mb, path),
        word_wrap: field(obj, "wordWrap", d.word_wrap, path),
    }
}

/// The file's JSON object, or why it has none.
fn parse_object(bytes: &[u8]) -> Result<Map<String, Value>, String> {
    match serde_json::from_slice::<Value>(bytes) {
        Ok(Value::Object(obj)) => Ok(obj),
        Ok(_) => Err("not a JSON object".to_string()),
        Err(e) => Err(e.to_string()),
    }
}

/// Missing file -> defaults. Not a JSON object -> logged, defaults, file left untouched.
/// Otherwise each invalid field falls back to its default on its own.
pub fn load_from(path: &Path) -> Settings {
    match std::fs::read(path) {
        Ok(bytes) => match parse_object(&bytes) {
            Ok(obj) => from_object(&obj, path),
            Err(e) => {
                log::error!("settings: {} is invalid ({e}); using defaults and leaving the file untouched", path.display());
                Settings::default()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Settings::default(),
        Err(e) => {
            log::error!("settings: cannot read {}: {e}; using defaults", path.display());
            Settings::default()
        }
    }
}

/// Copies an existing settings file that is not a JSON object to `settings.json.bad` so the save
/// about to overwrite it does not lose what the user wrote.
fn back_up_if_invalid(path: &Path) -> Result<(), AppError> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(AppError::from_io_at(path, &e)),
    };
    if parse_object(&bytes).is_ok() {
        return Ok(());
    }
    let mut bad = path.as_os_str().to_owned();
    bad.push(".bad");
    let bad = PathBuf::from(bad);
    std::fs::write(&bad, &bytes).map_err(|e| AppError::from_io_at(&bad, &e))?;
    log::warn!("settings: {} was invalid; kept a copy as {}", path.display(), bad.display());
    Ok(())
}

pub fn save_to(path: &Path, settings: &Settings) -> Result<(), AppError> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| AppError::from_io_at(dir, &e))?;
    }
    back_up_if_invalid(path)?;
    let json = serde_json::to_vec_pretty(settings).map_err(|e| AppError::io(format!("cannot serialize settings: {e}")))?;
    write_atomic(path, &json)
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    if let Some(dir) = config_dir_override() {
        return Ok(dir.join("settings.json"));
    }
    app.path()
        .app_config_dir()
        .map(|d| d.join("settings.json"))
        .map_err(|e| AppError::io(format!("cannot resolve config dir: {e}")))
}

/// Synchronous load for startup (the window's theme is needed before it is shown).
pub fn load(app: &tauri::AppHandle) -> Settings {
    match settings_path(app) {
        Ok(path) => load_from(&path),
        Err(e) => {
            log::error!("settings: {}; using defaults", e.message);
            Settings::default()
        }
    }
}

#[tauri::command]
pub async fn load_settings(app: tauri::AppHandle) -> Result<Settings, AppError> {
    let path = settings_path(&app)?;
    blocking(move || Ok(load_from(&path))).await
}

#[tauri::command]
pub async fn save_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), AppError> {
    let path = settings_path(&app)?;
    blocking(move || save_to(&path, &settings)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_fields_default() {
        let s: Settings = serde_json::from_str(r#"{ "theme": "dark", "wordWrap": true }"#).unwrap();
        assert_eq!(s.theme, Theme::Dark);
        assert!(s.word_wrap);
        assert_eq!(s.font_size, 14.0);
        assert_eq!(s.indent, IndentSetting::Two);
        assert_eq!(s.large_file_threshold_mb, 10.0);
        assert_eq!(s.font_family, "Cascadia Code, Consolas, Menlo, monospace");
        let empty: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, Settings::default());
    }

    #[test]
    fn serializes_camel_case() {
        let v = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(v["theme"], "system");
        assert_eq!(v["indent"], "2");
        assert_eq!(v["wordWrap"], false);
        assert_eq!(v["largeFileThresholdMb"], 10.0);
        assert!(v.get("fontFamily").is_some() && v.get("fontSize").is_some());
        let tab: Settings = serde_json::from_str(r#"{"indent":"tab"}"#).unwrap();
        assert_eq!(tab.indent, IndentSetting::Tab);
    }

    #[test]
    fn load_missing_gives_defaults() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(load_from(&d.path().join("settings.json")), Settings::default());
    }

    #[test]
    fn invalid_file_gives_defaults_and_is_not_overwritten() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("settings.json");
        std::fs::write(&p, b"{ not json").unwrap();
        assert_eq!(load_from(&p), Settings::default());
        assert_eq!(std::fs::read(&p).unwrap(), b"{ not json");
    }

    #[test]
    fn one_bad_value_resets_only_that_field() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("settings.json");
        std::fs::write(
            &p,
            r#"{ "theme": "Dark", "indent": 3, "fontSize": "14", "wordWrap": true, "fontFamily": "Mono", "largeFileThresholdMb": 20 }"#,
        )
        .unwrap();
        let s = load_from(&p);
        assert_eq!(s.theme, Theme::System, "bad theme -> default");
        assert_eq!(s.indent, IndentSetting::Two, "bad indent -> default");
        assert_eq!(s.font_size, 14.0, "bad fontSize -> default");
        assert!(s.word_wrap, "good fields kept");
        assert_eq!(s.font_family, "Mono");
        assert_eq!(s.large_file_threshold_mb, 20.0);
    }

    #[test]
    fn invalid_file_is_backed_up_before_save() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("settings.json");
        let bad = d.path().join("settings.json.bad");
        std::fs::write(&p, b"{ not json").unwrap();
        save_to(&p, &Settings::default()).unwrap();
        assert_eq!(std::fs::read(&bad).unwrap(), b"{ not json");
        assert_eq!(load_from(&p), Settings::default());
        // A valid file is not backed up again.
        std::fs::remove_file(&bad).unwrap();
        save_to(&p, &Settings { word_wrap: true, ..Settings::default() }).unwrap();
        assert!(!bad.exists());
        // Valid JSON that is not an object counts as invalid too.
        std::fs::write(&p, b"[1]").unwrap();
        assert_eq!(load_from(&p), Settings::default());
        save_to(&p, &Settings::default()).unwrap();
        assert_eq!(std::fs::read(&bad).unwrap(), b"[1]");
    }

    #[test]
    fn config_dir_override_ignores_empty() {
        assert_eq!(override_from(None), None);
        assert_eq!(override_from(Some("".into())), None);
        assert_eq!(override_from(Some("C:\\tmp\\cfg".into())), Some(PathBuf::from("C:\\tmp\\cfg")));
    }

    #[test]
    fn save_then_load_round_trips() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("sub").join("settings.json");
        let s = Settings { theme: Theme::Light, font_size: 16.0, indent: IndentSetting::Tab, ..Settings::default() };
        save_to(&p, &s).unwrap();
        assert_eq!(load_from(&p), s);
    }
}
