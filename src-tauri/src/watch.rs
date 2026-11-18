//! File-system watching with 200 ms debouncing. Emits `fs://changed { paths }`.

use crate::error::AppError;
use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{DebounceEventResult, Debouncer, new_debouncer};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

pub const DEBOUNCE: Duration = Duration::from_millis(200);

#[derive(Default)]
pub struct WatchState(Mutex<Option<Debouncer<RecommendedWatcher>>>);

#[derive(Serialize, Clone)]
struct ChangedPayload {
    paths: Vec<String>,
}

/// Deduplicated, order-preserving absolute path strings.
pub fn dedupe_paths<'a>(paths: impl Iterator<Item = &'a Path>) -> Vec<String> {
    let mut seen = HashSet::new();
    paths
        .map(|p| dunce::simplified(p).to_string_lossy().into_owned())
        .filter(|p| seen.insert(p.clone()))
        .collect()
}

/// Builds a debouncer watching exactly `paths` (folders recursive, files non-recursive).
/// Paths that cannot be watched (e.g. deleted since opened) are logged and skipped.
pub fn build_watcher<F>(paths: &[String], on_change: F) -> Result<Debouncer<RecommendedWatcher>, AppError>
where
    F: Fn(Vec<String>) + Send + 'static,
{
    let mut debouncer = new_debouncer(DEBOUNCE, move |res: DebounceEventResult| match res {
        Ok(events) => {
            let paths = dedupe_paths(events.iter().map(|e| e.path.as_path()));
            if !paths.is_empty() {
                on_change(paths);
            }
        }
        Err(e) => log::error!("watch: {e}"),
    })
    .map_err(|e| AppError::io(format!("cannot start file watcher: {e}")))?;

    for p in paths {
        let path = PathBuf::from(p);
        let mode = if path.is_dir() { RecursiveMode::Recursive } else { RecursiveMode::NonRecursive };
        if let Err(e) = debouncer.watcher().watch(&path, mode) {
            log::error!("watch: cannot watch {}: {e}", path.display());
        }
    }
    Ok(debouncer)
}

#[tauri::command]
pub async fn watch_paths(app: AppHandle, state: State<'_, WatchState>, paths: Vec<String>) -> Result<(), AppError> {
    let new = if paths.is_empty() {
        None
    } else {
        Some(build_watcher(&paths, move |changed| {
            if let Err(e) = app.emit("fs://changed", ChangedPayload { paths: changed }) {
                log::error!("watch: cannot emit fs://changed: {e}");
            }
        })?)
    };
    let mut guard = state.0.lock().map_err(|_| AppError::io("watcher state poisoned"))?;
    *guard = new; // dropping the previous debouncer stops it
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn dedupes_in_order() {
        let a = PathBuf::from("C:\\a\\x");
        let b = PathBuf::from("C:\\a\\y");
        let out = dedupe_paths([a.as_path(), b.as_path(), a.as_path()].into_iter());
        assert_eq!(out, vec!["C:\\a\\x".to_string(), "C:\\a\\y".to_string()]);
    }

    #[test]
    fn reports_changes_in_watched_folder() {
        let d = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(d.path()).unwrap();
        // `sub` exists before watching starts. On Linux, inotify watches a folder created later only after its create
        // event arrives, so a file written into it at once can be missed; the folder's own event still refreshes the tree.
        std::fs::create_dir_all(root.join("sub")).unwrap();
        let (tx, rx) = mpsc::channel();
        let _w = build_watcher(&[root.to_string_lossy().into_owned()], move |p| {
            let _ = tx.send(p);
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        std::fs::write(root.join("sub").join("f.txt"), b"hi").unwrap();
        let mut all: Vec<String> = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline && !all.iter().any(|p| p.ends_with("f.txt")) {
            if let Ok(p) = rx.recv_timeout(Duration::from_millis(500)) {
                all.extend(p);
            }
        }
        assert!(all.iter().any(|p| p.ends_with("f.txt")), "no event for f.txt, got {all:?}");
    }

    #[test]
    fn missing_path_is_skipped_not_fatal() {
        let d = tempfile::tempdir().unwrap();
        let w = build_watcher(&[d.path().join("nope").to_string_lossy().into_owned()], |_| {});
        assert!(w.is_ok());
    }
}
