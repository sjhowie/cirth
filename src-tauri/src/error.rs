//! Error type shared by every command. Serializes to `{ kind, message, line?, col? }`.

use serde::Serialize;
use std::fmt;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    Io,
    Encoding,
    Parse,
    NotFound,
    InvalidArg,
    /// Part of the contract; no command is cancellable via error today.
    #[allow(dead_code)]
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub col: Option<usize>,
}

impl AppError {
    fn make(kind: ErrorKind, message: String, line: Option<usize>, col: Option<usize>) -> Self {
        log::error!("{kind:?}: {message}{}", position_suffix(line, col));
        Self { kind, message, line, col }
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::make(ErrorKind::Io, message.into(), None, None)
    }

    pub fn encoding(message: impl Into<String>) -> Self {
        Self::make(ErrorKind::Encoding, message.into(), None, None)
    }

    pub fn encoding_at(message: impl Into<String>, line: usize, col: usize) -> Self {
        Self::make(ErrorKind::Encoding, message.into(), Some(line), Some(col))
    }

    pub fn parse(message: impl Into<String>, line: usize, col: usize) -> Self {
        Self::make(ErrorKind::Parse, message.into(), Some(line), Some(col))
    }

    /// Parse error positioned at a byte offset of `input` (1-based line, char column).
    pub fn parse_at(input: &[u8], offset: usize, message: impl Into<String>) -> Self {
        let (line, col) = line_col(input, offset);
        Self::parse(message, line, col)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::make(ErrorKind::NotFound, message.into(), None, None)
    }

    pub fn invalid_arg(message: impl Into<String>) -> Self {
        Self::make(ErrorKind::InvalidArg, message.into(), None, None)
    }

    #[allow(dead_code)]
    pub fn cancelled(message: impl Into<String>) -> Self {
        Self::make(ErrorKind::Cancelled, message.into(), None, None)
    }

    /// Maps an I/O error, naming the path it concerns.
    pub fn from_io_at(path: &Path, err: &std::io::Error) -> Self {
        let message = format!("{}: {err}", path.display());
        if err.kind() == std::io::ErrorKind::NotFound {
            Self::not_found(message)
        } else {
            Self::io(message)
        }
    }
}

fn position_suffix(line: Option<usize>, col: Option<usize>) -> String {
    match (line, col) {
        (Some(l), Some(c)) => format!(" (line {l}, col {c})"),
        _ => String::new(),
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}{}", self.kind, self.message, position_suffix(self.line, self.col))
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        if err.kind() == std::io::ErrorKind::NotFound {
            Self::not_found(err.to_string())
        } else {
            Self::io(err.to_string())
        }
    }
}

/// 1-based line and 1-based char column of byte `offset` within `input`.
pub fn line_col(input: &[u8], offset: usize) -> (usize, usize) {
    let before = &input[..offset.min(input.len())];
    let line = before.iter().filter(|&&b| b == b'\n').count() + 1;
    let line_start = before.iter().rposition(|&b| b == b'\n').map_or(0, |p| p + 1);
    let col = before[line_start..].iter().filter(|&&b| (b & 0xC0) != 0x80).count() + 1;
    (line, col)
}

/// Runs blocking work off the async runtime's worker and the main thread.
pub async fn blocking<T, F>(f: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::io(format!("background task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_without_position() {
        let v = serde_json::to_value(AppError::not_found("x")).unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "notFound", "message": "x" }));
    }

    #[test]
    fn serializes_with_position() {
        let v = serde_json::to_value(AppError::parse("bad", 2, 3)).unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "parse", "message": "bad", "line": 2, "col": 3 }));
        let v = serde_json::to_value(AppError::invalid_arg("x")).unwrap();
        assert_eq!(v["kind"], "invalidArg");
    }

    #[test]
    fn line_col_counts_chars() {
        let s = "ab\néx\n";
        assert_eq!(line_col(s.as_bytes(), 0), (1, 1));
        assert_eq!(line_col(s.as_bytes(), 3), (2, 1));
        assert_eq!(line_col(s.as_bytes(), 5), (2, 2)); // after 'é' (2 bytes)
    }

    #[test]
    fn io_not_found_maps() {
        let e: AppError = std::io::Error::from(std::io::ErrorKind::NotFound).into();
        assert_eq!(e.kind, ErrorKind::NotFound);
    }
}
