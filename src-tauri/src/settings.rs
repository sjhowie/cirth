//! Persistent settings (`settings.json` in the app config dir).

use crate::error::{AppError, blocking};
use crate::files::write_atomic;
use serde::{Deserialize, Serialize};
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

/// Missing file -> defaults. Unparseable file -> logged, defaults, file left untouched.
pub fn load_from(path: &Path) -> Settings {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            log::error!("settings: {} is invalid ({e}); using defaults and leaving the file untouched", path.display());
            Settings::default()
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Settings::default(),
        Err(e) => {
            log::error!("settings: cannot read {}: {e}; using defaults", path.display());
            Settings::default()
        }
    }
}

pub fn save_to(path: &Path, settings: &Settings) -> Result<(), AppError> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| AppError::from_io_at(dir, &e))?;
    }
    let json = serde_json::to_vec_pretty(settings).map_err(|e| AppError::io(format!("cannot serialize settings: {e}")))?;
    write_atomic(path, &json)
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_config_dir()
        .map(|d| d.join("settings.json"))
        .map_err(|e| AppError::io(format!("cannot resolve config dir: {e}")))
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
    fn save_then_load_round_trips() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("sub").join("settings.json");
        let s = Settings { theme: Theme::Light, font_size: 16.0, indent: IndentSetting::Tab, ..Settings::default() };
        save_to(&p, &s).unwrap();
        assert_eq!(load_from(&p), s);
    }
}
