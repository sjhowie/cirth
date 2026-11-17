//! Folder tree and basic file operations.

use crate::error::{AppError, blocking};
use ignore::WalkBuilder;
use serde::Serialize;
use std::path::Path;

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

fn already_exists(to: &Path) -> AppError {
    AppError::io(format!("{}: already exists", to.display()))
}

/// `from` and `to` name the same file or folder (a case-only rename on Windows).
#[cfg(windows)]
fn same_file(from: &Path, to: &Path) -> bool {
    match (crate::files::win::file_id(from), crate::files::win::file_id(to)) {
        (Ok(a), Ok(b)) => a.volume == b.volume && a.index == b.index,
        _ => false,
    }
}

#[cfg(unix)]
fn same_file(from: &Path, to: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::symlink_metadata(from), std::fs::symlink_metadata(to)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
        _ => false,
    }
}

#[cfg(not(any(windows, unix)))]
fn same_file(_from: &Path, _to: &Path) -> bool {
    false
}

/// Renames without ever replacing another file. Renaming onto the same file (a case-only change
/// such as `foo.txt` -> `Foo.txt`) is allowed.
pub fn rename_sync(from: &Path, to: &Path) -> Result<(), AppError> {
    if same_file(from, to) {
        return std::fs::rename(from, to).map_err(|e| AppError::from_io_at(from, &e));
    }
    #[cfg(windows)]
    {
        // No MOVEFILE_REPLACE_EXISTING: an existing target fails inside the call, with no
        // check-then-act gap.
        crate::files::win::move_no_replace(from, to).map_err(|e| {
            if crate::files::win::is_exists(&e) { already_exists(to) } else { AppError::from_io_at(from, &e) }
        })
    }
    #[cfg(not(windows))]
    {
        // std has no portable no-replace rename; the check below leaves a small race window.
        if std::fs::symlink_metadata(to).is_ok() {
            return Err(already_exists(to));
        }
        std::fs::rename(from, to).map_err(|e| AppError::from_io_at(from, &e))
    }
}

/// Existing command-line arguments (after the program name), canonicalized without `\\?\`.
/// Relative arguments are resolved against `base` (the launching process's working directory).
/// Empty arguments are skipped (`base.join("")` would be the working directory itself). A trailing
/// `\.` (the installer passes `"%V."` so a drive root is not read as `C:"`) resolves to the folder.
pub fn startup_paths_from(args: impl Iterator<Item = String>, base: &Path) -> Vec<String> {
    args.filter(|a| !a.trim().is_empty()).filter_map(|a| {
        let p = base.join(&a); // an absolute argument replaces `base`
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

#[derive(Default)]
struct OpenPathsInner {
    ready: bool,
    pending: Vec<String>,
}

/// Paths from second launches that arrive before the frontend is listening are queued here and
/// handed over by `get_startup_paths`, which is the frontend's "ready" signal.
#[derive(Default)]
pub struct OpenPathsState(std::sync::Mutex<OpenPathsInner>);

impl OpenPathsState {
    fn lock(&self) -> std::sync::MutexGuard<'_, OpenPathsInner> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Before ready: queue and return `None`. After ready: return the paths to emit now.
    pub fn deliver(&self, paths: Vec<String>) -> Option<Vec<String>> {
        let mut s = self.lock();
        if s.ready {
            Some(paths)
        } else {
            s.pending.extend(paths);
            None
        }
    }

    /// Marks the frontend ready; returns `startup` followed by everything queued so far.
    pub fn take_ready(&self, mut startup: Vec<String>) -> Vec<String> {
        let mut s = self.lock();
        s.ready = true;
        startup.append(&mut s.pending);
        startup
    }
}

#[tauri::command]
pub async fn get_startup_paths(state: tauri::State<'_, OpenPathsState>) -> Result<Vec<String>, AppError> {
    let base = std::env::current_dir().map_err(|e| AppError::io(format!("current directory: {e}")))?;
    Ok(state.take_ready(startup_paths_from(std::env::args().skip(1), &base)))
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
    fn rename_onto_existing_fails_and_keeps_both() {
        let d = tempfile::tempdir().unwrap();
        let (a, b) = (d.path().join("a.txt"), d.path().join("b.txt"));
        std::fs::write(&a, b"A").unwrap();
        std::fs::write(&b, b"B").unwrap();
        let err = rename_sync(&a, &b).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Io);
        assert!(err.message.contains("already exists"), "{}", err.message);
        assert_eq!(std::fs::read(&a).unwrap(), b"A");
        assert_eq!(std::fs::read(&b).unwrap(), b"B");
        // Folders too.
        let (da, db) = (d.path().join("da"), d.path().join("db"));
        std::fs::create_dir(&da).unwrap();
        std::fs::create_dir(&db).unwrap();
        assert!(rename_sync(&da, &db).unwrap_err().message.contains("already exists"));
        assert!(da.is_dir() && db.is_dir());
    }

    #[cfg(windows)]
    #[test]
    fn case_only_rename_works() {
        let d = tempfile::tempdir().unwrap();
        let from = d.path().join("foo.txt");
        std::fs::write(&from, b"x").unwrap();
        rename_sync(&from, &d.path().join("Foo.txt")).unwrap();
        let names: Vec<_> = std::fs::read_dir(d.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("Foo.txt")]);
        let dir = d.path().join("sub");
        std::fs::create_dir(&dir).unwrap();
        rename_sync(&dir, &d.path().join("SUB")).unwrap();
        assert!(std::fs::read_dir(d.path()).unwrap().any(|e| e.unwrap().file_name() == "SUB"));
    }

    #[test]
    fn startup_paths_skip_empty_and_resolve_trailing_dot() {
        let d = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(d.path()).unwrap();
        std::fs::create_dir(base.join("dir")).unwrap();
        let sep = std::path::MAIN_SEPARATOR;
        let args = vec![String::new(), "  ".to_string(), format!("{}{sep}dir{sep}.", base.display())];
        let out = startup_paths_from(args.into_iter(), &base);
        assert_eq!(out, vec![base.join("dir").to_string_lossy().into_owned()]);
    }

    #[cfg(windows)]
    #[test]
    fn startup_paths_drive_root_and_folder_dot() {
        let d = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(d.path()).unwrap();
        std::fs::create_dir(base.join("dir")).unwrap();
        // "%V." for a folder background gives `D:\dir.`; Windows drops the trailing dot.
        let args = vec![format!("{}\\dir.", base.display())];
        assert_eq!(startup_paths_from(args.into_iter(), &base), vec![base.join("dir").to_string_lossy().into_owned()]);
        let drive = base.to_string_lossy().chars().take(2).collect::<String>(); // e.g. "C:"
        let out = startup_paths_from(vec![format!("{drive}\\.")].into_iter(), &base);
        assert_eq!(out, vec![format!("{drive}\\")]);
    }

    #[test]
    fn startup_paths_keep_only_existing_and_strip_prefix() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("f.txt");
        touch(&f);
        let args = vec![f.to_string_lossy().into_owned(), "--flag".to_string(), "C:\\definitely\\missing.txt".to_string()];
        let out = startup_paths_from(args.into_iter(), d.path());
        assert_eq!(out.len(), 1);
        assert!(!out[0].starts_with(r"\\?\"));
        assert!(out[0].ends_with("f.txt"));
    }

    #[test]
    fn open_paths_queue_until_ready_then_pass_through() {
        let s = OpenPathsState::default();
        assert_eq!(s.deliver(vec!["a".into()]), None);
        assert_eq!(s.deliver(vec!["b".into()]), None);
        assert_eq!(s.take_ready(vec!["s".into()]), vec!["s", "a", "b"]);
        assert_eq!(s.deliver(vec!["c".into()]), Some(vec!["c".to_string()]));
        assert_eq!(s.take_ready(vec![]), Vec::<String>::new());
    }

    #[test]
    fn startup_paths_resolve_relative_against_base() {
        let d = tempfile::tempdir().unwrap();
        touch(&d.path().join("sub/rel.txt"));
        let args = vec!["sub/rel.txt".to_string(), "sub".to_string(), "nope.txt".to_string()];
        let out = startup_paths_from(args.into_iter(), d.path());
        let base = dunce::canonicalize(d.path()).unwrap();
        assert_eq!(out, vec![base.join("sub").join("rel.txt").to_string_lossy().into_owned(), base.join("sub").to_string_lossy().into_owned()]);
    }
}
