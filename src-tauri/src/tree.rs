//! Folder tree and basic file operations.

use crate::error::{AppError, blocking};
use ignore::WalkBuilder;
use serde::Serialize;
use std::path::{Path, PathBuf};

pub const MAX_LIST_FILES: usize = 50_000;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
pub struct FileList {
    pub files: Vec<String>,
    pub truncated: bool,
}

/// Folders first, then case-insensitive name; `.git` is skipped.
pub fn list_dir_sync(path: &Path) -> Result<Vec<DirEntry>, AppError> {
    let rd = std::fs::read_dir(path).map_err(|e| AppError::from_io_at(path, &e))?;
    let mut entries = Vec::new();
    for entry in rd {
        let entry = entry.map_err(|e| AppError::from_io_at(path, &e))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let p = entry.path();
        let is_dir = entry.file_type().map_err(|e| AppError::from_io_at(&p, &e))?.is_dir() || p.is_dir();
        entries.push(DirEntry { name, path: p.to_string_lossy().into_owned(), is_dir });
    }
    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())).then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}

/// Files only, root-relative with `/` separators, honouring `.gitignore` (even outside a git repo).
pub fn list_files_sync(root: &Path, cap: usize) -> Result<FileList, AppError> {
    if !root.is_dir() {
        return Err(AppError::not_found(format!("{}: not a folder", root.display())));
    }
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .require_git(false)
        .filter_entry(|e| e.file_name() != ".git")
        .sort_by_file_name(|a, b| a.cmp(b))
        .build();
    let mut files = Vec::new();
    let mut truncated = false;
    for result in walker {
        let entry = match result {
            Ok(e) => e,
            Err(e) => {
                log::error!("list_files: {e}");
                continue;
            }
        };
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        if files.len() >= cap {
            truncated = true;
            break;
        }
        let rel = entry.path().strip_prefix(root).unwrap_or(entry.path());
        files.push(rel.to_string_lossy().replace('\\', "/"));
    }
    Ok(FileList { files, truncated })
}

pub fn create_file_sync(path: &Path) -> Result<(), AppError> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map(drop)
        .map_err(|e| AppError::from_io_at(path, &e))
}

pub fn rename_sync(from: &Path, to: &Path) -> Result<(), AppError> {
    if to.exists() {
        return Err(AppError::io(format!("{}: already exists", to.display())));
    }
    std::fs::rename(from, to).map_err(|e| AppError::from_io_at(from, &e))
}

/// Existing command-line arguments (after the program name), canonicalized without `\\?\`.
pub fn startup_paths_from(args: impl Iterator<Item = String>) -> Vec<String> {
    args.filter_map(|a| {
        let p = PathBuf::from(&a);
        if !p.exists() {
            return None;
        }
        match dunce::canonicalize(&p) {
            Ok(c) => Some(c.to_string_lossy().into_owned()),
            Err(e) => {
                log::error!("get_startup_paths: cannot canonicalize {a}: {e}");
                None
            }
        }
    })
    .collect()
}

#[tauri::command]
pub async fn list_dir(path: String) -> Result<Vec<DirEntry>, AppError> {
    blocking(move || list_dir_sync(Path::new(&path))).await
}

#[tauri::command]
pub async fn list_files(root: String) -> Result<FileList, AppError> {
    blocking(move || list_files_sync(Path::new(&root), MAX_LIST_FILES)).await
}

#[tauri::command]
pub async fn create_file(path: String) -> Result<(), AppError> {
    blocking(move || create_file_sync(Path::new(&path))).await
}

#[tauri::command]
pub async fn create_dir(path: String) -> Result<(), AppError> {
    blocking(move || std::fs::create_dir_all(&path).map_err(|e| AppError::from_io_at(Path::new(&path), &e))).await
}

#[tauri::command]
pub async fn rename_path(from: String, to: String) -> Result<(), AppError> {
    blocking(move || rename_sync(Path::new(&from), Path::new(&to))).await
}

#[tauri::command]
pub async fn trash_path(path: String) -> Result<(), AppError> {
    blocking(move || {
        if !Path::new(&path).exists() {
            return Err(AppError::not_found(format!("{path}: does not exist")));
        }
        trash::delete(&path).map_err(|e| AppError::io(format!("{path}: cannot move to recycle bin: {e}")))
    })
    .await
}

#[tauri::command]
pub async fn get_startup_paths() -> Result<Vec<String>, AppError> {
    Ok(startup_paths_from(std::env::args().skip(1)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;

    fn touch(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"x").unwrap();
    }

    #[test]
    fn list_dir_orders_and_skips_git() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        touch(&r.join("b.txt"));
        touch(&r.join("A.txt"));
        touch(&r.join("zdir/f"));
        touch(&r.join("Adir/f"));
        touch(&r.join(".git/config"));
        let names: Vec<_> = list_dir_sync(r).unwrap().into_iter().map(|e| (e.name, e.is_dir)).collect();
        assert_eq!(
            names,
            vec![("Adir".into(), true), ("zdir".into(), true), ("A.txt".into(), false), ("b.txt".into(), false)]
        );
    }

    #[test]
    fn list_dir_missing_is_not_found() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(list_dir_sync(&d.path().join("nope")).unwrap_err().kind, ErrorKind::NotFound);
    }

    #[test]
    fn list_files_relative_ignored_and_capped() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        touch(&r.join("src/main.rs"));
        touch(&r.join("a.txt"));
        touch(&r.join(".hidden/h.txt"));
        touch(&r.join(".git/config"));
        touch(&r.join("target/out.o"));
        std::fs::write(r.join(".gitignore"), "target/\n").unwrap();
        let l = list_files_sync(r, 100).unwrap();
        assert!(!l.truncated);
        let mut files = l.files;
        files.sort();
        assert_eq!(files, vec![".gitignore", ".hidden/h.txt", "a.txt", "src/main.rs"]);
        let l = list_files_sync(r, 2).unwrap();
        assert!(l.truncated);
        assert_eq!(l.files.len(), 2);
        let l = list_files_sync(r, 4).unwrap();
        assert!(!l.truncated);
    }

    #[test]
    fn create_file_fails_if_exists() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("n.txt");
        create_file_sync(&p).unwrap();
        assert_eq!(create_file_sync(&p).unwrap_err().kind, ErrorKind::Io);
        assert!(p.exists());
    }

    #[test]
    fn rename_fails_if_target_exists() {
        let d = tempfile::tempdir().unwrap();
        let (a, b) = (d.path().join("a"), d.path().join("b"));
        touch(&a);
        touch(&b);
        assert_eq!(rename_sync(&a, &b).unwrap_err().kind, ErrorKind::Io);
        std::fs::remove_file(&b).unwrap();
        rename_sync(&a, &b).unwrap();
        assert!(b.exists() && !a.exists());
        assert_eq!(rename_sync(&a, &d.path().join("c")).unwrap_err().kind, ErrorKind::NotFound);
    }

    #[test]
    fn startup_paths_keep_only_existing_and_strip_prefix() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("f.txt");
        touch(&f);
        let args = vec![f.to_string_lossy().into_owned(), "--flag".to_string(), "C:\\definitely\\missing.txt".to_string()];
        let out = startup_paths_from(args.into_iter());
        assert_eq!(out.len(), 1);
        assert!(!out[0].starts_with(r"\\?\"));
        assert!(out[0].ends_with("f.txt"));
    }
}
