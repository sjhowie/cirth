//! Chunked uploads: lets the frontend send a raw request body bigger than WebView2 survives
//! (~110 MB per request) as several `upload_chunk` calls, then name the staged bytes with the
//! `x-upload-id` header on the consuming command. See "Chunked uploads" in docs/ipc.md.

use crate::error::{AppError, blocking};
use crate::files::{header, raw_body};
use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::ipc::Request;
use tauri::{AppHandle, Manager, State};

/// A staged upload idle this long (no chunk added, not consumed) is dropped by the next
/// `upload_begin`, `upload_chunk` or consuming call.
pub const STAGED_TTL: Duration = Duration::from_secs(10 * 60);

struct Staged {
    chunks: Vec<u8>,
    /// Last `begin` or `append`.
    touched: Instant,
}

type StagedMap = HashMap<String, Staged>;

fn sweep_map(map: &mut StagedMap, now: Instant, ttl: Duration) {
    map.retain(|id, s| {
        let keep = now.saturating_duration_since(s.touched) < ttl;
        if !keep {
            log::warn!("upload {id}: dropped after {} s idle", ttl.as_secs());
        }
        keep
    });
}

#[derive(Default)]
pub struct UploadState {
    staged: Mutex<HashMap<String, Staged>>,
    counter: AtomicU64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadBegun {
    pub upload_id: String,
}

impl UploadState {
    fn lock(&self) -> std::sync::MutexGuard<'_, StagedMap> {
        // A poisoned lock only means another command panicked mid-update; the map is still usable.
        self.staged.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn begin_at(&self, now: Instant) -> String {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        let id = format!("{:x}-{:x}", self.counter.fetch_add(1, Ordering::Relaxed), nanos);
        let mut map = self.lock();
        sweep_map(&mut map, now, STAGED_TTL);
        map.insert(id.clone(), Staged { chunks: Vec::new(), touched: now });
        id
    }

    #[cfg(test)]
    pub fn append(&self, id: &str, bytes: &[u8]) -> Result<(), AppError> {
        self.append_at(id, bytes, Instant::now())
    }

    pub fn append_at(&self, id: &str, bytes: &[u8], now: Instant) -> Result<(), AppError> {
        let mut map = self.lock();
        sweep_map(&mut map, now, STAGED_TTL);
        match map.get_mut(id) {
            Some(s) => {
                s.chunks.extend_from_slice(bytes);
                s.touched = now;
                Ok(())
            }
            None => Err(unknown(id)),
        }
    }

    /// Removes and returns the staged bytes (consume once).
    pub fn take(&self, id: &str) -> Result<Vec<u8>, AppError> {
        self.take_at(id, Instant::now())
    }

    pub fn take_at(&self, id: &str, now: Instant) -> Result<Vec<u8>, AppError> {
        let mut map = self.lock();
        sweep_map(&mut map, now, STAGED_TTL);
        map.remove(id).map(|s| s.chunks).ok_or_else(|| unknown(id))
    }

    /// Idempotent.
    pub fn discard(&self, id: &str) {
        self.lock().remove(id);
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.lock().len()
    }
}

fn unknown(id: &str) -> AppError {
    AppError::invalid_arg(format!("unknown or expired upload id '{id}'"))
}

/// The request's bytes: the staged upload named by `x-upload-id` (consumed, whatever happens next),
/// otherwise the inline raw body.
pub fn request_bytes<'a>(request: &'a Request<'_>, state: &UploadState) -> Result<Cow<'a, [u8]>, AppError> {
    match header(request, "x-upload-id")? {
        Some(id) => state.take(&id).map(Cow::Owned),
        None => raw_body(request).map(Cow::Borrowed),
    }
}

#[tauri::command]
pub fn upload_begin(state: State<'_, UploadState>) -> UploadBegun {
    UploadBegun { upload_id: state.begin_at(Instant::now()) }
}

#[tauri::command]
pub async fn upload_chunk(request: Request<'_>, app: AppHandle) -> Result<(), AppError> {
    let id = header(&request, "x-upload-id")?.ok_or_else(|| AppError::invalid_arg("missing x-upload-id header"))?;
    let bytes = raw_body(&request)?.to_vec();
    // Appending can reallocate (copy) the whole staged buffer: keep it off the async workers.
    blocking(move || app.state::<UploadState>().append_at(&id, &bytes, Instant::now())).await
}

#[tauri::command]
pub fn upload_discard(upload_id: String, state: State<'_, UploadState>) {
    state.discard(&upload_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;
    use crate::format_json::{FormatOptions, Indent, Mode, format_bytes};

    #[test]
    fn chunks_concatenate_in_order() {
        let s = UploadState::default();
        let id = s.begin_at(Instant::now());
        s.append(&id, b"he").unwrap();
        s.append(&id, b"llo ").unwrap();
        s.append(&id, b"world").unwrap();
        assert_eq!(s.take(&id).unwrap(), b"hello world");
    }

    #[test]
    fn take_consumes_once() {
        let s = UploadState::default();
        let id = s.begin_at(Instant::now());
        s.append(&id, b"x").unwrap();
        assert_eq!(s.take(&id).unwrap(), b"x");
        assert_eq!(s.take(&id).unwrap_err().kind, ErrorKind::InvalidArg);
        assert_eq!(s.len(), 0);
    }

    #[test]
    fn unknown_id_is_invalid_arg() {
        let s = UploadState::default();
        assert_eq!(s.append("nope", b"x").unwrap_err().kind, ErrorKind::InvalidArg);
        assert_eq!(s.take("nope").unwrap_err().kind, ErrorKind::InvalidArg);
    }

    #[test]
    fn discard_is_idempotent() {
        let s = UploadState::default();
        let id = s.begin_at(Instant::now());
        s.discard(&id);
        s.discard(&id);
        s.discard("never-existed");
        assert_eq!(s.append(&id, b"x").unwrap_err().kind, ErrorKind::InvalidArg);
    }

    #[test]
    fn ids_are_unique() {
        let s = UploadState::default();
        let a = s.begin_at(Instant::now());
        let b = s.begin_at(Instant::now());
        assert_ne!(a, b);
    }

    #[test]
    fn old_entries_expire_on_begin() {
        let s = UploadState::default();
        let t0 = Instant::now();
        let old = s.begin_at(t0);
        s.append_at(&old, b"x", t0).unwrap();
        let _fresh = s.begin_at(t0 + STAGED_TTL - Duration::from_secs(1));
        assert_eq!(s.len(), 2, "not yet expired");
        let newer = s.begin_at(t0 + STAGED_TTL + Duration::from_secs(1));
        assert_eq!(s.len(), 2, "expired entry swept");
        let late = t0 + STAGED_TTL + Duration::from_secs(2);
        assert_eq!(s.append_at(&old, b"z", late).unwrap_err().kind, ErrorKind::InvalidArg);
        assert!(s.append_at(&newer, b"ok", late).is_ok());
    }

    #[test]
    fn stale_entries_are_swept_by_chunks_and_takes() {
        let s = UploadState::default();
        let t0 = Instant::now();
        let stale = s.begin_at(t0);
        let active = s.begin_at(t0);
        // `active` keeps receiving chunks, so its idle time restarts; `stale` sits.
        let t1 = t0 + STAGED_TTL - Duration::from_secs(1);
        s.append_at(&active, b"a", t1).unwrap();
        let t2 = t0 + STAGED_TTL + Duration::from_secs(1);
        s.append_at(&active, b"b", t2).unwrap();
        assert_eq!(s.len(), 1, "a chunk on another upload swept the stale one");
        assert_eq!(s.take_at(&stale, t2).unwrap_err().kind, ErrorKind::InvalidArg);

        let t3 = t2 + STAGED_TTL + Duration::from_secs(1);
        let consumed = s.begin_at(t3);
        assert_eq!(s.len(), 1, "begin swept `active` (idle since t2)");
        assert_eq!(s.take_at(&consumed, t3).unwrap(), b"");
        let gone = s.begin_at(t3);
        assert_eq!(s.take_at(&gone, t3 + STAGED_TTL).unwrap_err().kind, ErrorKind::InvalidArg, "idle past TTL at take");
        assert_eq!(s.len(), 0);
    }

    #[test]
    fn format_via_staged_bytes_equals_inline() {
        let s = UploadState::default();
        let src = br#"{"a": [1, 2, {"b": "c"}], "d": null}"#;
        let id = s.begin_at(Instant::now());
        for part in src.chunks(7) {
            s.append(&id, part).unwrap();
        }
        let staged = s.take(&id).unwrap();
        let opts = || FormatOptions { mode: Mode::Pretty, indent: Indent::Spaces(2) };
        assert_eq!(format_bytes(&staged, opts()).unwrap(), format_bytes(src, opts()).unwrap());
    }
}
