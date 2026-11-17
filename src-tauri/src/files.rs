//! Reading and writing text files with encoding / BOM / EOL preservation.

use crate::error::{AppError, blocking, line_col};
use chardetng::EncodingDetector;
use encoding_rs::{Encoding, UTF_8, UTF_16BE, UTF_16LE};
use percent_encoding::percent_decode_str;
use serde::Serialize;
use std::borrow::Cow;
use std::io::Write;
use std::path::{Path, PathBuf};
use crate::upload::{UploadState, request_bytes};
use tauri::State;
use tauri::ipc::{InvokeBody, Request, Response};
use tempfile::NamedTempFile;

const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];
const UTF16LE_BOM: [u8; 2] = [0xFF, 0xFE];
const UTF16BE_BOM: [u8; 2] = [0xFE, 0xFF];
/// Bytes handed to the charset detector (the rest is only decoded).
const DETECT_PREFIX: usize = 1 << 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Eol {
    Lf,
    Crlf,
    /// Lone `\r` (classic Mac OS).
    Cr,
}

impl Eol {
    pub fn parse(s: &str) -> Result<Self, AppError> {
        match s.trim().to_ascii_lowercase().as_str() {
            "lf" => Ok(Self::Lf),
            "crlf" => Ok(Self::Crlf),
            "cr" => Ok(Self::Cr),
            other => Err(AppError::invalid_arg(format!("unknown eol '{other}'"))),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lf => "\n",
            Self::Crlf => "\r\n",
            Self::Cr => "\r",
        }
    }
}

#[derive(Debug)]
pub struct Decoded {
    pub text: String,
    pub encoding: String,
    pub bom: bool,
    pub eol: Eol,
    /// Some bytes were not valid in `encoding` and were decoded as U+FFFD, so writing `text` back
    /// would not reproduce them.
    pub lossy: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Meta<'a> {
    encoding: &'a str,
    bom: bool,
    eol: Eol,
    size: usize,
    lossy: bool,
}

#[derive(Serialize)]
pub struct WriteResult {
    pub size: usize,
}

/// Style of the first line break; `Lf` when there is none.
pub fn detect_eol(text: &str) -> Eol {
    let b = text.as_bytes();
    match b.iter().position(|&c| c == b'\r' || c == b'\n') {
        Some(i) if b[i] == b'\r' && b.get(i + 1) == Some(&b'\n') => Eol::Crlf,
        Some(i) if b[i] == b'\r' => Eol::Cr,
        _ => Eol::Lf,
    }
}

/// Decodes `bytes` (BOM already stripped) without BOM sniffing; returns the text and whether any
/// byte sequence was invalid (replaced by U+FFFD).
fn decode_with(enc: &'static Encoding, bytes: &[u8]) -> (String, bool) {
    let (text, had_errors) = enc.decode_without_bom_handling(bytes);
    if had_errors {
        log::warn!("decode: invalid {} byte sequences replaced with U+FFFD", enc.name());
    }
    (text.into_owned(), had_errors)
}

/// Decodes file bytes: BOM, else valid UTF-8, else a `chardetng` guess. Invalid sequences become
/// U+FFFD and set `lossy`.
pub fn decode_bytes(bytes: Vec<u8>) -> Decoded {
    let (text, encoding, bom, lossy) = match String::from_utf8(bytes) {
        Ok(mut s) => {
            let bom = s.starts_with('\u{FEFF}');
            if bom {
                s.drain(..UTF8_BOM.len());
            }
            (s, "utf-8".to_string(), bom, false)
        }
        Err(e) => {
            let bytes = e.into_bytes();
            if bytes.starts_with(&UTF8_BOM) {
                let (text, lossy) = decode_with(UTF_8, &bytes[3..]);
                (text, "utf-8".to_string(), true, lossy)
            } else if bytes.starts_with(&UTF16LE_BOM) {
                let (text, lossy) = decode_with(UTF_16LE, &bytes[2..]);
                (text, "utf-16le".to_string(), true, lossy)
            } else if bytes.starts_with(&UTF16BE_BOM) {
                let (text, lossy) = decode_with(UTF_16BE, &bytes[2..]);
                (text, "utf-16be".to_string(), true, lossy)
            } else {
                let mut det = EncodingDetector::new();
                let prefix = &bytes[..bytes.len().min(DETECT_PREFIX)];
                det.feed(prefix, prefix.len() == bytes.len());
                let enc = det.guess(None, false);
                let (text, lossy) = decode_with(enc, &bytes);
                (text, enc.name().to_ascii_lowercase(), false, lossy)
            }
        }
    };
    let eol = detect_eol(&text);
    Decoded { text, encoding, bom, eol, lossy }
}

pub fn read_decoded(path: &Path) -> Result<(Decoded, usize), AppError> {
    let bytes = std::fs::read(path).map_err(|e| AppError::from_io_at(path, &e))?;
    let size = bytes.len();
    Ok((decode_bytes(bytes), size))
}

/// Applies the target line ending to text whose breaks are `\n`.
pub fn apply_eol(text: &str, eol: Eol) -> Cow<'_, str> {
    match eol {
        Eol::Lf => Cow::Borrowed(text),
        Eol::Crlf | Eol::Cr => {
            let base: Cow<'_, str> =
                if text.contains('\r') { Cow::Owned(text.replace("\r\n", "\n")) } else { Cow::Borrowed(text) };
            Cow::Owned(base.replace('\n', eol.as_str()))
        }
    }
}

fn first_unmappable(enc: &'static Encoding, text: &str) -> Option<(usize, usize, char)> {
    let mut buf = [0u8; 4];
    text.char_indices().filter(|(_, c)| !c.is_ascii()).find_map(|(i, c)| {
        let (_, _, had) = enc.encode(c.encode_utf8(&mut buf));
        had.then(|| {
            let (line, col) = line_col(text.as_bytes(), i);
            (line, col, c)
        })
    })
}

/// Encodes `text` (line breaks already as desired) into `label`, prepending a BOM when asked
/// and the encoding has one. Unmappable characters are an `encoding` error.
pub fn encode_text(text: &str, label: &str, bom: bool) -> Result<Vec<u8>, AppError> {
    let lower = label.trim().to_ascii_lowercase();
    match lower.as_str() {
        "utf-8" | "utf8" => Ok(encode_utf8(text, bom)),
        "utf-16le" => Ok(encode_utf16(text, bom, true)),
        "utf-16be" => Ok(encode_utf16(text, bom, false)),
        _ => {
            let enc = Encoding::for_label(lower.as_bytes())
                .ok_or_else(|| AppError::invalid_arg(format!("unknown encoding '{label}'")))?;
            if enc == UTF_8 {
                return Ok(encode_utf8(text, bom));
            }
            if enc == UTF_16LE || enc == UTF_16BE {
                return Ok(encode_utf16(text, bom, enc == UTF_16LE));
            }
            if enc.output_encoding() != enc {
                return Err(AppError::invalid_arg(format!("cannot encode text as '{}'", enc.name())));
            }
            let (bytes, _, had_errors) = enc.encode(text);
            if had_errors {
                return Err(match first_unmappable(enc, text) {
                    Some((line, col, c)) => AppError::encoding_at(
                        format!("character '{c}' (U+{:04X}) cannot be represented in {}", c as u32, enc.name()),
                        line,
                        col,
                    ),
                    None => AppError::encoding(format!("text cannot be represented in {}", enc.name())),
                });
            }
            Ok(bytes.into_owned())
        }
    }
}

fn encode_utf8(text: &str, bom: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() + 3);
    if bom {
        out.extend_from_slice(&UTF8_BOM);
    }
    out.extend_from_slice(text.as_bytes());
    out
}

// encoding_rs cannot encode UTF-16 (it silently emits UTF-8), so do it by hand.
fn encode_utf16(text: &str, bom: bool, little: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 2 + 2);
    let push = |out: &mut Vec<u8>, unit: u16| {
        out.extend_from_slice(&if little { unit.to_le_bytes() } else { unit.to_be_bytes() });
    };
    if bom {
        push(&mut out, 0xFEFF);
    }
    for unit in text.encode_utf16() {
        push(&mut out, unit);
    }
    out
}

fn parent_dir(path: &Path) -> &Path {
    path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."))
}

/// The file a save should change: `path` itself, or the target when `path` is a symlink (so the
/// link stays a link). A dangling link resolves to the path it names, which the save creates.
fn resolve_link(path: &Path) -> Result<PathBuf, AppError> {
    match std::fs::symlink_metadata(path) {
        Ok(md) if md.file_type().is_symlink() => match dunce::canonicalize(path) {
            Ok(target) => Ok(target),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let link = std::fs::read_link(path).map_err(|e| AppError::from_io_at(path, &e))?;
                Ok(parent_dir(path).join(link))
            }
            Err(e) => Err(AppError::from_io_at(path, &e)),
        },
        _ => Ok(path.to_path_buf()),
    }
}

/// Saves `bytes` to `path` without losing what the file system keeps about an existing file.
/// - A symlink is followed; its target is written and the link stays.
/// - New files: temp file in the same directory, then rename.
/// - Existing files on Windows: temp file, then `ReplaceFileW`, which keeps ACLs, attributes,
///   creation time and alternate data streams. A file with several hard links is written in place
///   so the links stay joined; so is a file whose replacement is refused (access denied, or open
///   elsewhere without delete sharing).
/// - Existing files elsewhere: temp file with the original permissions, then rename.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let target = resolve_link(path)?;
    match std::fs::metadata(&target) {
        Ok(md) => {
            if md.is_dir() {
                return Err(AppError::io(format!("{}: is a directory", target.display())));
            }
            if md.permissions().readonly() {
                return Err(AppError::io(format!("{}: file is read-only", target.display())));
            }
            replace_existing(&target, bytes, &md)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => write_via_tempfile(&target, bytes, None),
        Err(e) => Err(AppError::from_io_at(&target, &e)),
    }
}

/// Temp file in the target's directory, optionally given `perms`, then renamed over the target.
fn write_via_tempfile(target: &Path, bytes: &[u8], perms: Option<std::fs::Permissions>) -> Result<(), AppError> {
    let io_err = |e: std::io::Error| AppError::from_io_at(target, &e);
    let mut tmp = NamedTempFile::new_in(parent_dir(target)).map_err(io_err)?;
    tmp.write_all(bytes).map_err(io_err)?;
    tmp.as_file().sync_all().map_err(io_err)?;
    if let Some(perms) = perms {
        std::fs::set_permissions(tmp.path(), perms).map_err(io_err)?;
    }
    tmp.persist(target).map_err(|e| io_err(e.error))?;
    Ok(())
}

#[cfg(not(windows))]
fn replace_existing(target: &Path, bytes: &[u8], md: &std::fs::Metadata) -> Result<(), AppError> {
    write_via_tempfile(target, bytes, Some(md.permissions()))
}

#[cfg(windows)]
fn replace_existing(target: &Path, bytes: &[u8], _md: &std::fs::Metadata) -> Result<(), AppError> {
    let links = match win::file_id(target) {
        Ok(id) => id.links,
        Err(e) => {
            log::warn!("{}: cannot read the hard link count ({e}); assuming one", target.display());
            1
        }
    };
    if links > 1 {
        return write_in_place(target, bytes);
    }
    match replace_via_temp(target, bytes) {
        Ok(()) => Ok(()),
        Err(e) if win::is_locked(&e) => {
            log::warn!("{}: cannot replace the file ({e}); writing it in place instead", target.display());
            write_in_place(target, bytes)
        }
        Err(e) => Err(AppError::from_io_at(target, &e)),
    }
}

/// Temp file next to `target`, then `ReplaceFileW`. The temp file is removed on any failure.
#[cfg(windows)]
fn replace_via_temp(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = win::TempSibling::create(target)?;
    {
        let mut f = std::fs::OpenOptions::new().write(true).open(&tmp.path)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    win::replace_file(target, &tmp.path)?;
    tmp.disarm();
    Ok(())
}

/// Overwrites the existing file's contents through its own handle, so hard links, ACLs, attributes
/// and streams are untouched. Not atomic: space is reserved first so a full disk fails before any
/// byte changes, but a crash mid-write leaves a mix of old and new bytes.
#[cfg(windows)]
fn write_in_place(target: &Path, bytes: &[u8]) -> Result<(), AppError> {
    use std::io::{Seek, SeekFrom};
    let io_err = |e: std::io::Error| AppError::from_io_at(target, &e);
    let mut f = std::fs::OpenOptions::new().write(true).open(target).map_err(io_err)?;
    let len = bytes.len() as u64;
    if len > f.metadata().map_err(io_err)?.len() {
        f.set_len(len).map_err(io_err)?;
    }
    f.seek(SeekFrom::Start(0)).map_err(io_err)?;
    f.write_all(bytes).map_err(io_err)?;
    f.set_len(len).map_err(io_err)?;
    f.sync_all().map_err(io_err)
}

/// Thin wrappers over the Win32 file calls std does not expose.
#[cfg(windows)]
pub(crate) mod win {
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use windows_sys::Win32::Foundation::{
        ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS, ERROR_SHARING_VIOLATION,
        ERROR_UNABLE_TO_REMOVE_REPLACED, HANDLE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES, GetFileInformationByHandle,
        MoveFileExW, REPLACEFILE_IGNORE_MERGE_ERRORS, ReplaceFileW,
    };

    /// NUL-terminated wide path, absolute, with the `\\?\` prefix when it is long.
    pub fn wide(path: &Path) -> Vec<u16> {
        const VERBATIM: &[u16] = &[b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
        let abs = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
        let w: Vec<u16> = abs.as_os_str().encode_wide().collect();
        let mut out = Vec::with_capacity(w.len() + 9);
        if w.len() >= 248 && !w.starts_with(VERBATIM) {
            if w.starts_with(&VERBATIM[..2]) {
                out.extend(r"\\?\UNC\".encode_utf16());
                out.extend_from_slice(&w[2..]);
            } else {
                out.extend_from_slice(VERBATIM);
                out.extend_from_slice(&w);
            }
        } else {
            out = w;
        }
        out.push(0);
        out
    }

    pub struct FileId {
        pub volume: u32,
        pub index: u64,
        pub links: u32,
    }

    /// Volume, file index and hard link count of a file or folder (symlinks followed).
    pub fn file_id(path: &Path) -> io::Result<FileId> {
        let f = std::fs::OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)?;
        // SAFETY: an all-zero BY_HANDLE_FILE_INFORMATION is a valid value (plain integers).
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: `f` owns a valid handle for the duration of the call; `info` is a valid out pointer.
        if unsafe { GetFileInformationByHandle(f.as_raw_handle() as HANDLE, &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(FileId {
            volume: info.dwVolumeSerialNumber,
            index: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
            links: info.nNumberOfLinks,
        })
    }

    /// `ReplaceFileW(replaced, replacement)`: `replacement` takes `replaced`'s name and keeps its
    /// ACLs, attributes, creation time and named streams.
    pub fn replace_file(replaced: &Path, replacement: &Path) -> io::Result<()> {
        let (a, b) = (wide(replaced), wide(replacement));
        // SAFETY: both strings are NUL-terminated and outlive the call; the optional pointers are null.
        let ok = unsafe {
            ReplaceFileW(a.as_ptr(), b.as_ptr(), std::ptr::null(), REPLACEFILE_IGNORE_MERGE_ERRORS, std::ptr::null(), std::ptr::null())
        };
        if ok == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
    }

    /// `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING`: fails atomically when `to` exists.
    pub fn move_no_replace(from: &Path, to: &Path) -> io::Result<()> {
        let (a, b) = (wide(from), wide(to));
        // SAFETY: both strings are NUL-terminated and outlive the call.
        if unsafe { MoveFileExW(a.as_ptr(), b.as_ptr(), 0) } == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
    }

    fn is_code(e: &io::Error, codes: &[u32]) -> bool {
        e.raw_os_error().is_some_and(|c| codes.iter().any(|&k| c == k as i32))
    }

    /// The target refused replacement: access denied, or open elsewhere without delete sharing.
    pub fn is_locked(e: &io::Error) -> bool {
        is_code(e, &[ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, ERROR_UNABLE_TO_REMOVE_REPLACED])
    }

    pub fn is_exists(e: &io::Error) -> bool {
        is_code(e, &[ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS])
    }

    /// A new, empty file next to `target`, deleted on drop unless `disarm`ed. Created without
    /// `FILE_ATTRIBUTE_TEMPORARY` (unlike `tempfile`), since `ReplaceFileW` may carry attributes over.
    pub struct TempSibling {
        pub path: PathBuf,
        armed: bool,
    }

    impl TempSibling {
        pub fn create(target: &Path) -> io::Result<Self> {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let dir = super::parent_dir(target);
            let mut last = None;
            for _ in 0..16 {
                let nanos = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.subsec_nanos());
                let n = COUNTER.fetch_add(1, Ordering::Relaxed);
                let path = dir.join(format!(".{name}.{:x}{nanos:x}{n:x}.cirth-tmp", std::process::id()));
                match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                    Ok(_) => return Ok(Self { path, armed: true }),
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => last = Some(e),
                    Err(e) => return Err(e),
                }
            }
            Err(last.unwrap_or_else(|| io::Error::other("cannot create a temp file")))
        }

        pub fn disarm(mut self) {
            self.armed = false;
        }
    }

    impl Drop for TempSibling {
        fn drop(&mut self) {
            if self.armed
                && let Err(e) = std::fs::remove_file(&self.path)
            {
                log::error!("{}: cannot remove temp file: {e}", self.path.display());
            }
        }
    }
}

/// Encodes with `encode_text` and writes atomically; returns bytes written.
pub fn write_encoded(path: &Path, text: &str, encoding: &str, bom: bool) -> Result<usize, AppError> {
    let bytes = encode_text(text, encoding, bom)?;
    write_atomic(path, &bytes)?;
    Ok(bytes.len())
}

/// `write_file` semantics: `text` uses `\n`; convert to `eol`, encode, write.
pub fn write_text(path: &Path, text: &str, encoding: &str, bom: bool, eol: Eol) -> Result<usize, AppError> {
    write_encoded(path, &apply_eol(text, eol), encoding, bom)
}

pub fn read_payload(path: &Path) -> Result<Vec<u8>, AppError> {
    let (d, size) = read_decoded(path)?;
    let meta = serde_json::to_vec(&Meta { encoding: &d.encoding, bom: d.bom, eol: d.eol, size, lossy: d.lossy })
        .map_err(|e| AppError::io(format!("meta serialization failed: {e}")))?;
    let meta_len = u32::try_from(meta.len()).map_err(|_| AppError::io("meta too large"))?;
    let mut out = Vec::with_capacity(4 + meta.len() + d.text.len());
    out.extend_from_slice(&meta_len.to_le_bytes());
    out.extend_from_slice(&meta);
    out.extend_from_slice(d.text.as_bytes());
    Ok(out)
}

/// Raw request body, rejecting JSON bodies.
pub fn raw_body<'a>(request: &'a Request<'_>) -> Result<&'a [u8], AppError> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes),
        InvokeBody::Json(_) => Err(AppError::invalid_arg("expected a raw binary request body, got JSON")),
    }
}

pub fn header(request: &Request<'_>, name: &str) -> Result<Option<String>, AppError> {
    match request.headers().get(name) {
        None => Ok(None),
        Some(v) => v
            .to_str()
            .map(|s| Some(s.to_string()))
            .map_err(|_| AppError::invalid_arg(format!("header '{name}' is not ASCII"))),
    }
}

pub fn percent_decode(value: &str) -> Result<String, AppError> {
    percent_decode_str(value)
        .decode_utf8()
        .map(Cow::into_owned)
        .map_err(|_| AppError::invalid_arg("percent-encoded value is not valid UTF-8"))
}

pub fn utf8_text<'a>(bytes: &'a [u8], what: &str) -> Result<&'a str, AppError> {
    std::str::from_utf8(bytes).map_err(|e| {
        let (line, col) = line_col(bytes, e.valid_up_to());
        AppError::parse(format!("{what} is not valid UTF-8"), line, col)
    })
}

#[tauri::command]
pub async fn read_file(path: String) -> Result<Response, AppError> {
    blocking(move || read_payload(Path::new(&path))).await.map(Response::new)
}

#[tauri::command]
pub async fn write_file(request: Request<'_>, uploads: State<'_, UploadState>) -> Result<WriteResult, AppError> {
    // Take any staged upload first so it is consumed even when a header below is rejected.
    let body = request_bytes(&request, &uploads)?.into_owned();
    let path = header(&request, "x-path")?.ok_or_else(|| AppError::invalid_arg("missing x-path header"))?;
    let path = percent_decode(&path)?;
    let encoding = header(&request, "x-encoding")?.unwrap_or_else(|| "utf-8".to_string());
    let bom = match header(&request, "x-bom")?.as_deref() {
        None | Some("0") => false,
        Some("1") => true,
        Some(other) => return Err(AppError::invalid_arg(format!("x-bom must be 1 or 0, got '{other}'"))),
    };
    let eol = Eol::parse(&header(&request, "x-eol")?.unwrap_or_else(|| "lf".to_string()))?;
    // Validation, encoding, sync and rename are blocking work: keep them off the async workers.
    blocking(move || {
        let text = utf8_text(&body, "request body")?;
        let size = write_text(Path::new(&path), text, &encoding, bom, eol)?;
        Ok(WriteResult { size })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;

    fn roundtrip(bytes: &[u8], expect_enc: &str, expect_bom: bool, expect_eol: Eol) {
        let d = decode_bytes(bytes.to_vec());
        assert_eq!(d.encoding, expect_enc);
        assert_eq!(d.bom, expect_bom);
        assert_eq!(d.eol, expect_eol);
        let normalized = d.text.replace("\r\n", "\n");
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f.txt");
        write_text(&p, &normalized, &d.encoding, d.bom, d.eol).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), bytes, "round trip differs for {expect_enc}");
    }

    fn utf16(text: &str, le: bool) -> Vec<u8> {
        let mut v = if le { vec![0xFF, 0xFE] } else { vec![0xFE, 0xFF] };
        for u in text.encode_utf16() {
            v.extend_from_slice(&if le { u.to_le_bytes() } else { u.to_be_bytes() });
        }
        v
    }

    #[test]
    fn roundtrip_all_encodings_and_eols() {
        for (nl, eol) in [("\n", Eol::Lf), ("\r\n", Eol::Crlf)] {
            let text = format!("héllo wörld ✓{nl}second line{nl}third{nl}");
            roundtrip(text.as_bytes(), "utf-8", false, eol);

            let mut bom = UTF8_BOM.to_vec();
            bom.extend_from_slice(text.as_bytes());
            roundtrip(&bom, "utf-8", true, eol);

            roundtrip(&utf16(&text, true), "utf-16le", true, eol);
            roundtrip(&utf16(&text, false), "utf-16be", true, eol);

            // "café crème brûlée<nl>ligne deux<nl>" as windows-1252 bytes
            let mut latin = b"caf\xE9 cr\xE8me br\xFBl\xE9e".to_vec();
            latin.extend_from_slice(nl.as_bytes());
            latin.extend_from_slice(b"ligne deux");
            latin.extend_from_slice(nl.as_bytes());
            roundtrip(&latin, "windows-1252", false, eol);
        }
    }

    #[test]
    fn windows_1252_byte_e9_decodes_to_e_acute() {
        let d = decode_bytes(b"caf\xE9 au lait\n".to_vec());
        assert_eq!(d.encoding, "windows-1252");
        assert_eq!(d.text, "caf\u{e9} au lait\n");
    }

    #[test]
    fn unmappable_char_is_encoding_error() {
        let err = encode_text("price: \u{20AC}\u{4E2D}", "windows-1252", false).unwrap_err();
        // € is mappable in windows-1252, 中 is not.
        assert_eq!(err.kind, ErrorKind::Encoding);
        assert_eq!((err.line, err.col), (Some(1), Some(9)));
        assert!(!err.message.contains("&#"));
    }

    #[test]
    fn unmappable_write_leaves_file_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f.txt");
        std::fs::write(&p, b"orig").unwrap();
        let err = write_text(&p, "\u{4E2D}", "windows-1252", false, Eol::Lf).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Encoding);
        assert_eq!(std::fs::read(&p).unwrap(), b"orig");
    }

    #[test]
    fn utf16_is_really_utf16() {
        assert_eq!(encode_text("a\u{1F600}", "utf-16le", true).unwrap(), vec![0xFF, 0xFE, 0x61, 0, 0x3D, 0xD8, 0x00, 0xDE]);
        assert_eq!(encode_text("a", "utf-16be", false).unwrap(), vec![0, 0x61]);
    }

    #[test]
    fn eol_detection() {
        assert_eq!(detect_eol("a\nb\r\n"), Eol::Lf);
        assert_eq!(detect_eol("a\r\nb\n"), Eol::Crlf);
        assert_eq!(detect_eol("a\rb\r"), Eol::Cr);
        assert_eq!(detect_eol("a\r"), Eol::Cr);
        assert_eq!(detect_eol("abc"), Eol::Lf);
        assert_eq!(detect_eol(""), Eol::Lf);
    }

    #[test]
    fn apply_eol_does_not_double_crlf() {
        assert_eq!(apply_eol("a\nb\r\nc", Eol::Crlf), "a\r\nb\r\nc");
        assert_eq!(apply_eol("a\nb", Eol::Lf), "a\nb");
    }

    #[test]
    fn unknown_encoding_is_invalid_arg() {
        assert_eq!(encode_text("x", "nope-1", false).unwrap_err().kind, ErrorKind::InvalidArg);
    }

    #[test]
    fn read_payload_layout() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f.txt");
        std::fs::write(&p, b"hi\r\nthere").unwrap();
        let out = read_payload(&p).unwrap();
        let n = u32::from_le_bytes(out[..4].try_into().unwrap()) as usize;
        let meta: serde_json::Value = serde_json::from_slice(&out[4..4 + n]).unwrap();
        assert_eq!(meta, serde_json::json!({ "encoding": "utf-8", "bom": false, "eol": "crlf", "size": 9, "lossy": false }));
        assert_eq!(&out[4 + n..], b"hi\r\nthere");
    }

    fn meta_of(bytes: &[u8]) -> serde_json::Value {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f.txt");
        std::fs::write(&p, bytes).unwrap();
        let out = read_payload(&p).unwrap();
        let n = u32::from_le_bytes(out[..4].try_into().unwrap()) as usize;
        serde_json::from_slice(&out[4..4 + n]).unwrap()
    }

    #[test]
    fn invalid_bytes_are_flagged_lossy() {
        // BOM'd UTF-8 with an invalid byte (E9 alone).
        let d = decode_bytes(b"\xEF\xBB\xBFabc\xE9def".to_vec());
        assert_eq!((d.encoding.as_str(), d.bom, d.lossy), ("utf-8", true, true));
        assert_eq!(d.text, "abc\u{FFFD}def");
        // UTF-16LE: odd length, and a lone high surrogate.
        assert!(decode_bytes(vec![0xFF, 0xFE, 0x61, 0x00, 0x62]).lossy);
        assert!(decode_bytes(vec![0xFF, 0xFE, 0x3D, 0xD8, 0x61, 0x00]).lossy);
        assert!(decode_bytes(vec![0xFE, 0xFF, 0xD8, 0x3D, 0x00, 0x61]).lossy);
        // Clean files are not lossy.
        assert!(!decode_bytes(b"\xEF\xBB\xBFabc".to_vec()).lossy);
        assert!(!decode_bytes(utf16("ab", true)).lossy);
        assert!(!decode_bytes(b"caf\xE9\n".to_vec()).lossy);
        assert!(!decode_bytes(b"plain".to_vec()).lossy);
        assert_eq!(meta_of(b"\xEF\xBB\xBFabc\xE9def")["lossy"], true);
        assert_eq!(meta_of(b"abc")["lossy"], false);
    }

    #[test]
    fn lone_cr_files_round_trip() {
        let bytes = b"one\rtwo\rthree\r";
        let d = decode_bytes(bytes.to_vec());
        assert_eq!(d.eol, Eol::Cr);
        assert_eq!(meta_of(bytes)["eol"], "cr");
        let normalized = d.text.replace('\r', "\n");
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("mac.txt");
        write_text(&p, &normalized, "utf-8", false, Eol::Cr).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), bytes);
        assert_eq!(Eol::parse("CR").unwrap(), Eol::Cr);
        assert_eq!(apply_eol("a\nb\r\nc", Eol::Cr), "a\rb\rc");
    }

    #[test]
    fn new_file_is_created() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("new.txt");
        write_text(&p, "fresh", "utf-8", false, Eol::Lf).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"fresh");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1, "temp file left behind");
    }

    #[test]
    fn symlink_stays_a_link() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("real.txt");
        let link = dir.path().join("link.txt");
        std::fs::write(&target, b"old").unwrap();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(&target, &link);
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&target, &link);
        if let Err(e) = made {
            eprintln!("skipping: cannot create a symlink here ({e})");
            return;
        }
        write_text(&link, "new", "utf-8", false, Eol::Lf).unwrap();
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink(), "link replaced by a file");
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
    }

    #[cfg(windows)]
    mod windows {
        use super::*;
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_TEMPORARY, FILE_SHARE_READ, FILE_SHARE_WRITE, SetFileAttributesW,
        };

        #[test]
        fn hard_link_stays_joined() {
            let dir = tempfile::tempdir().unwrap();
            let (a, b) = (dir.path().join("a.txt"), dir.path().join("b.txt"));
            std::fs::write(&a, b"old").unwrap();
            std::fs::hard_link(&a, &b).unwrap();
            write_text(&a, "via a", "utf-8", false, Eol::Lf).unwrap();
            assert_eq!(std::fs::read(&b).unwrap(), b"via a");
            write_text(&b, "b", "utf-8", false, Eol::Lf).unwrap();
            assert_eq!(std::fs::read(&a).unwrap(), b"b", "shorter content truncates");
            assert_eq!(win::file_id(&a).unwrap().links, 2);
        }

        #[test]
        fn hidden_attribute_and_stream_survive() {
            let dir = tempfile::tempdir().unwrap();
            let p = dir.path().join("file.txt");
            std::fs::write(&p, b"old").unwrap();
            std::fs::write(dir.path().join("file.txt:extra"), b"stream data").unwrap();
            // SAFETY: NUL-terminated path that outlives the call.
            assert_ne!(unsafe { SetFileAttributesW(win::wide(&p).as_ptr(), FILE_ATTRIBUTE_HIDDEN) }, 0);
            let before = win::file_id(&p).unwrap().index;
            write_text(&p, "new", "utf-8", false, Eol::Lf).unwrap();
            assert_ne!(win::file_id(&p).unwrap().index, before, "expected ReplaceFileW, not the in-place fallback");
            assert_eq!(std::fs::read(&p).unwrap(), b"new");
            let attrs = std::fs::metadata(&p).unwrap().file_attributes();
            assert_ne!(attrs & FILE_ATTRIBUTE_HIDDEN, 0, "hidden attribute lost");
            assert_eq!(attrs & FILE_ATTRIBUTE_TEMPORARY, 0, "temp attribute leaked");
            assert_eq!(std::fs::read(dir.path().join("file.txt:extra")).unwrap(), b"stream data");
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1, "temp file left behind");
        }

        #[test]
        fn file_open_without_delete_sharing_is_written_in_place() {
            let dir = tempfile::tempdir().unwrap();
            let p = dir.path().join("held.txt");
            std::fs::write(&p, b"old contents").unwrap();
            let _held = std::fs::OpenOptions::new().read(true).share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE).open(&p).unwrap();
            let before = win::file_id(&p).unwrap().index;
            write_text(&p, "new", "utf-8", false, Eol::Lf).unwrap();
            assert_eq!(win::file_id(&p).unwrap().index, before, "expected the in-place fallback");
            assert_eq!(std::fs::read(&p).unwrap(), b"new");
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1, "temp file left behind");
        }
    }

    #[test]
    fn read_missing_file_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_payload(&dir.path().join("nope")).unwrap_err().kind, ErrorKind::NotFound);
    }

    #[test]
    fn read_only_target_is_io_error() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("ro.txt");
        std::fs::write(&p, b"x").unwrap();
        let mut perms = std::fs::metadata(&p).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&p, perms.clone()).unwrap();
        let err = write_text(&p, "new", "utf-8", false, Eol::Lf).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Io);
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        std::fs::set_permissions(&p, perms).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"x");
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(percent_decode("C%3A%5Cdir%5Cna%C3%AFve%20file.txt").unwrap(), "C:\\dir\\na\u{ef}ve file.txt");
    }

    #[test]
    fn write_replaces_existing_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f.txt");
        std::fs::write(&p, b"old old old").unwrap();
        let n = write_text(&p, "a\nb", "utf-8", true, Eol::Crlf).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"\xEF\xBB\xBFa\r\nb");
        assert_eq!(n, 7);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1, "temp file left behind");
    }
}
