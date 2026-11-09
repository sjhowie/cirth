//! Reading and writing text files with encoding / BOM / EOL preservation.

use crate::error::{AppError, blocking, line_col};
use chardetng::EncodingDetector;
use encoding_rs::{Encoding, UTF_8, UTF_16BE, UTF_16LE};
use percent_encoding::percent_decode_str;
use serde::Serialize;
use std::borrow::Cow;
use std::io::Write;
use std::path::Path;
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
}

impl Eol {
    pub fn parse(s: &str) -> Result<Self, AppError> {
        match s.trim().to_ascii_lowercase().as_str() {
            "lf" => Ok(Self::Lf),
            "crlf" => Ok(Self::Crlf),
            other => Err(AppError::invalid_arg(format!("unknown eol '{other}'"))),
        }
    }
}

#[derive(Debug)]
pub struct Decoded {
    pub text: String,
    pub encoding: String,
    pub bom: bool,
    pub eol: Eol,
}

#[derive(Serialize)]
struct Meta<'a> {
    encoding: &'a str,
    bom: bool,
    eol: Eol,
    size: usize,
}

#[derive(Serialize)]
pub struct WriteResult {
    pub size: usize,
}

/// Style of the first line break; `Lf` when there is none.
pub fn detect_eol(text: &str) -> Eol {
    match text.bytes().position(|b| b == b'\r' || b == b'\n') {
        Some(i) if text.as_bytes()[i] == b'\r' && text.as_bytes().get(i + 1) == Some(&b'\n') => Eol::Crlf,
        _ => Eol::Lf,
    }
}

/// Decodes file bytes: BOM, else valid UTF-8, else a `chardetng` guess.
pub fn decode_bytes(bytes: Vec<u8>) -> Decoded {
    let (text, encoding, bom) = match String::from_utf8(bytes) {
        Ok(mut s) => {
            let bom = s.starts_with('\u{FEFF}');
            if bom {
                s.drain(..UTF8_BOM.len());
            }
            (s, "utf-8".to_string(), bom)
        }
        Err(e) => {
            let bytes = e.into_bytes();
            if bytes.starts_with(&UTF8_BOM) {
                let text = UTF_8.decode_without_bom_handling(&bytes[3..]).0.into_owned();
                (text, "utf-8".to_string(), true)
            } else if bytes.starts_with(&UTF16LE_BOM) {
                let text = UTF_16LE.decode_without_bom_handling(&bytes[2..]).0.into_owned();
                (text, "utf-16le".to_string(), true)
            } else if bytes.starts_with(&UTF16BE_BOM) {
                let text = UTF_16BE.decode_without_bom_handling(&bytes[2..]).0.into_owned();
                (text, "utf-16be".to_string(), true)
            } else {
                let mut det = EncodingDetector::new();
                let prefix = &bytes[..bytes.len().min(DETECT_PREFIX)];
                det.feed(prefix, prefix.len() == bytes.len());
                let enc = det.guess(None, false);
                let text = enc.decode_without_bom_handling(&bytes).0.into_owned();
                (text, enc.name().to_ascii_lowercase(), false)
            }
        }
    };
    let eol = detect_eol(&text);
    Decoded { text, encoding, bom, eol }
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
        Eol::Crlf => {
            let base: Cow<'_, str> =
                if text.contains('\r') { Cow::Owned(text.replace("\r\n", "\n")) } else { Cow::Borrowed(text) };
            Cow::Owned(base.replace('\n', "\r\n"))
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

/// Writes via a temp file in the same directory, then replaces the target.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let io_err = |e: std::io::Error| AppError::from_io_at(path, &e);
    if let Ok(md) = std::fs::metadata(path) {
        if md.is_dir() {
            return Err(AppError::io(format!("{}: is a directory", path.display())));
        }
        if md.permissions().readonly() {
            return Err(AppError::io(format!("{}: file is read-only", path.display())));
        }
    }
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    let mut tmp = NamedTempFile::new_in(parent).map_err(io_err)?;
    tmp.write_all(bytes).map_err(io_err)?;
    tmp.as_file().sync_all().map_err(io_err)?;
    tmp.persist(path).map_err(|e| io_err(e.error))?;
    Ok(())
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
    let meta = serde_json::to_vec(&Meta { encoding: &d.encoding, bom: d.bom, eol: d.eol, size })
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

#[tauri::command(async)]
pub fn write_file(request: Request<'_>) -> Result<WriteResult, AppError> {
    let path = header(&request, "x-path")?.ok_or_else(|| AppError::invalid_arg("missing x-path header"))?;
    let path = percent_decode(&path)?;
    let encoding = header(&request, "x-encoding")?.unwrap_or_else(|| "utf-8".to_string());
    let bom = match header(&request, "x-bom")?.as_deref() {
        None | Some("0") => false,
        Some("1") => true,
        Some(other) => return Err(AppError::invalid_arg(format!("x-bom must be 1 or 0, got '{other}'"))),
    };
    let eol = Eol::parse(&header(&request, "x-eol")?.unwrap_or_else(|| "lf".to_string()))?;
    let text = utf8_text(raw_body(&request)?, "request body")?;
    let size = write_text(Path::new(&path), text, &encoding, bom, eol)?;
    Ok(WriteResult { size })
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
        assert_eq!(meta, serde_json::json!({ "encoding": "utf-8", "bom": false, "eol": "crlf", "size": 9 }));
        assert_eq!(&out[4 + n..], b"hi\r\nthere");
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
