//! Folder search (streaming, cancellable) and replace.
//!
//! Non-UTF-8 files: UTF-16 files with a BOM are transcoded by the searcher; other legacy
//! encodings are searched as raw bytes (ASCII queries match, previews are lossy). Binary files
//! (a NUL byte) are skipped. `replace_in_folder` decodes properly via `files.rs`.

use crate::error::{AppError, blocking};
use crate::files::{Eol, read_decoded, write_encoded};
use grep_matcher::{LineTerminator, Matcher};
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};
use ignore::WalkBuilder;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::overrides::{Override, OverrideBuilder};
use regex::{NoExpand, Regex, RegexBuilder};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

pub const MAX_MATCHES: usize = 10_000;
const PREVIEW_CHARS: usize = 300;

#[derive(Default)]
pub struct SearchState(Mutex<HashMap<String, Arc<AtomicBool>>>);

#[derive(Debug, Clone)]
pub struct SearchOpts {
    pub query: String,
    pub regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub include: String,
    pub exclude: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub line: u64,
    pub col: usize,
    pub preview: String,
    pub match_len: usize,
}

#[derive(Debug)]
pub struct FileResult {
    pub path: String,
    pub items: Vec<Item>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub files: usize,
    pub matches: usize,
    pub truncated: bool,
    pub cancelled: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ResultEvent<'a> {
    search_id: &'a str,
    path: &'a str,
    items: &'a [Item],
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DoneEvent<'a> {
    search_id: &'a str,
    #[serde(flatten)]
    summary: Summary,
}

/// Whole word uses half boundaries: no word character just before the match and none just after.
/// Unlike `\b`, they also hold at a non-word edge, so `foo(` matches in `x foo( y`.
fn pattern_of(query: &str, regex: bool, whole_word: bool) -> String {
    let base = if regex { query.to_string() } else { regex::escape(query) };
    if whole_word { format!(r"\b{{start-half}}(?:{base})\b{{end-half}}") } else { base }
}

fn check_query(query: &str) -> Result<(), AppError> {
    if query.is_empty() { Err(AppError::invalid_arg("query is empty")) } else { Ok(()) }
}

fn build_matcher(opts: &SearchOpts) -> Result<RegexMatcher, AppError> {
    check_query(&opts.query)?;
    RegexMatcherBuilder::new()
        .case_insensitive(!opts.case_sensitive)
        .multi_line(true)
        .crlf(true)
        .build(&pattern_of(&opts.query, opts.regex, opts.whole_word))
        .map_err(|e| AppError::parse(format!("invalid search pattern: {e}"), 1, 1))
}

fn split_globs(s: &str) -> Vec<String> {
    s.split(',').map(str::trim).filter(|g| !g.is_empty()).map(str::to_string).collect()
}

fn build_excludes(root: &Path, exclude: &str) -> Result<Override, AppError> {
    let mut b = OverrideBuilder::new(root);
    for g in split_globs(exclude) {
        b.add(&format!("!{g}")).map_err(|e| AppError::invalid_arg(format!("invalid exclude glob '{g}': {e}")))?;
    }
    b.build().map_err(|e| AppError::invalid_arg(format!("invalid exclude globs: {e}")))
}

fn build_includes(root: &Path, include: &str) -> Result<Option<Gitignore>, AppError> {
    let globs = split_globs(include);
    if globs.is_empty() {
        return Ok(None);
    }
    let mut b = GitignoreBuilder::new(root);
    for g in &globs {
        b.add_line(None, g).map_err(|e| AppError::invalid_arg(format!("invalid include glob '{g}': {e}")))?;
    }
    b.build().map(Some).map_err(|e| AppError::invalid_arg(format!("invalid include globs: {e}")))
}

/// Everything that can fail synchronously, so a bad query is reported to the caller.
pub struct Prepared {
    root: std::path::PathBuf,
    matcher: RegexMatcher,
    /// Exclude globs as `!glob` overrides (these only ever exclude).
    excludes: Override,
    /// Include globs with gitignore glob syntax, used as a plain filter. A whitelist `Override`
    /// would instead pull in files that .gitignore hides.
    includes: Option<Gitignore>,
}

pub fn prepare(root: &Path, opts: &SearchOpts) -> Result<Prepared, AppError> {
    if !root.is_dir() {
        return Err(AppError::not_found(format!("{}: not a folder", root.display())));
    }
    Ok(Prepared {
        root: root.to_path_buf(),
        matcher: build_matcher(opts)?,
        excludes: build_excludes(root, &opts.exclude)?,
        includes: build_includes(root, &opts.include)?,
    })
}

fn lossy_chars(bytes: &[u8]) -> usize {
    String::from_utf8_lossy(bytes).chars().count()
}

/// Preview of one match: trimmed line, windowed to `PREVIEW_CHARS` around the match.
fn make_item(line_no: u64, line: &[u8], ms: usize, me: usize) -> Item {
    let mut end = line.len();
    while end > 0 && matches!(line[end - 1], b'\n' | b'\r') {
        end -= 1;
    }
    let lead = line.iter().take_while(|b| matches!(b, b' ' | b'\t')).count().min(ms);
    let body = &line[lead..end];
    let (ms, me) = (ms - lead, me.min(end).saturating_sub(lead).max(ms - lead));
    let chars: Vec<char> = String::from_utf8_lossy(body).chars().collect();
    let cs = lossy_chars(&body[..ms]);
    let cl = lossy_chars(&body[ms..me]);
    let (start, stop) = if chars.len() <= PREVIEW_CHARS {
        (0, chars.len())
    } else {
        let slack = PREVIEW_CHARS.saturating_sub(cl) / 2;
        let start = cs.saturating_sub(slack).min(chars.len() - PREVIEW_CHARS);
        (start, start + PREVIEW_CHARS)
    };
    let col = cs - start.min(cs) + 1;
    Item {
        line: line_no,
        col,
        preview: chars[start..stop].iter().collect(),
        match_len: cl.min(stop.saturating_sub(start + col - 1)),
    }
}

struct Collector<'a> {
    matcher: &'a RegexMatcher,
    items: Vec<Item>,
    total: &'a mut usize,
    truncated: &'a mut bool,
    cap: usize,
    cancel: &'a AtomicBool,
}

impl Sink for Collector<'_> {
    type Error = std::io::Error;

    fn matched(&mut self, _s: &Searcher, m: &SinkMatch<'_>) -> Result<bool, Self::Error> {
        if self.cancel.load(Ordering::Relaxed) {
            return Ok(false);
        }
        let line = m.bytes();
        let line_no = m.line_number().unwrap_or(0);
        let mut spans: Vec<(usize, usize)> = Vec::new();
        // The matcher's error type is `NoError`; there is nothing to handle.
        let _ = self.matcher.find_iter(line, |mat| {
            if mat.end() > mat.start() {
                spans.push((mat.start(), mat.end()));
            }
            true
        });
        for (s, e) in spans {
            if *self.total >= self.cap {
                *self.truncated = true;
                return Ok(false);
            }
            *self.total += 1;
            self.items.push(make_item(line_no, line, s, e));
        }
        Ok(true)
    }
}

/// Marker carried by the I/O error `CancelReader` returns.
#[derive(Debug)]
struct SearchCancelled;

impl std::fmt::Display for SearchCancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("search cancelled")
    }
}

impl std::error::Error for SearchCancelled {}

fn is_cancelled(e: &std::io::Error) -> bool {
    e.get_ref().is_some_and(|inner| inner.is::<SearchCancelled>())
}

/// Checks the cancel flag before every read, so a long file with no matches still stops promptly.
/// Fails with a `SearchCancelled` error (kind `Other`, not `Interrupted`, which readers retry).
struct CancelReader<'a, R> {
    inner: R,
    cancel: &'a AtomicBool,
}

impl<R: std::io::Read> std::io::Read for CancelReader<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(std::io::Error::other(SearchCancelled));
        }
        self.inner.read(buf)
    }
}

/// Walks and searches, calling `emit` once per file with matches.
pub fn execute(
    prep: &Prepared,
    cancel: &AtomicBool,
    cap: usize,
    mut emit: impl FnMut(FileResult),
) -> Summary {
    let mut searcher: Searcher = SearcherBuilder::new()
        .binary_detection(BinaryDetection::quit(b'\x00'))
        .line_terminator(LineTerminator::crlf())
        .build();
    let walker = WalkBuilder::new(&prep.root)
        .hidden(false)
        .require_git(false)
        .overrides(prep.excludes.clone())
        .filter_entry(|e| e.file_name() != ".git")
        .sort_by_file_name(|a, b| a.cmp(b))
        .build();
    let (mut files, mut total, mut truncated) = (0usize, 0usize, false);
    for entry in walker {
        if cancel.load(Ordering::Relaxed) || truncated {
            break;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                log::error!("search: {e}");
                continue;
            }
        };
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        if let Some(inc) = &prep.includes
            && !inc.matched_path_or_any_parents(entry.path(), false).is_ignore()
        {
            continue;
        }
        let mut sink = Collector {
            matcher: &prep.matcher,
            items: Vec::new(),
            total: &mut total,
            truncated: &mut truncated,
            cap,
            cancel,
        };
        let searched = std::fs::File::open(entry.path())
            .and_then(|f| searcher.search_reader(&prep.matcher, CancelReader { inner: f, cancel }, &mut sink));
        match searched {
            Ok(()) => {}
            Err(e) if is_cancelled(&e) => {}
            Err(e) => log::error!("search: {}: {e}", entry.path().display()),
        }
        let items = std::mem::take(&mut sink.items);
        if !items.is_empty() {
            files += 1;
            emit(FileResult { path: dunce::simplified(entry.path()).to_string_lossy().into_owned(), items });
        }
    }
    Summary { files, matches: total, truncated, cancelled: cancel.load(Ordering::Relaxed) }
}

/// Convenience for tests: prepare + execute.
#[cfg(test)]
pub fn run_search(root: &Path, opts: &SearchOpts, cancel: &AtomicBool, cap: usize) -> Result<(Vec<FileResult>, Summary), AppError> {
    let prep = prepare(root, opts)?;
    let mut results = Vec::new();
    let summary = execute(&prep, cancel, cap, |r| results.push(r));
    Ok((results, summary))
}

// ---- replace ----

fn build_replace_regex(query: &str, regex: bool, case_sensitive: bool, whole_word: bool) -> Result<Regex, AppError> {
    check_query(query)?;
    RegexBuilder::new(&pattern_of(query, regex, whole_word))
        .case_insensitive(!case_sensitive)
        .multi_line(true)
        .crlf(true)
        .build()
        .map_err(|e| AppError::parse(format!("invalid search pattern: {e}"), 1, 1))
}

/// Splits off the first line of `text`: (content, terminator). The terminator is `\r` for `cr`
/// files, else `\n` or `\r\n`; it is empty on a last line without one.
fn split_line(text: &str, eol: Eol) -> (&str, &str) {
    let found = if eol == Eol::Cr { text.find('\r') } else { text.find('\n') };
    match found {
        None => (text, ""),
        Some(i) if eol != Eol::Cr && i > 0 && text.as_bytes()[i - 1] == b'\r' => (&text[..i - 1], &text[i - 1..=i]),
        Some(i) => (&text[..i], &text[i..=i]),
    }
}

/// Replaces non-empty matches in one line, appending to `out`; returns the count.
fn replace_in_line(re: &Regex, line: &str, replacement: &str, expand: bool, out: &mut String) -> usize {
    let (mut last, mut count) = (0usize, 0usize);
    for caps in re.captures_iter(line) {
        let Some(m) = caps.get(0) else { continue };
        if m.start() == m.end() {
            continue;
        }
        out.push_str(&line[last..m.start()]);
        if expand {
            caps.expand(replacement, out);
        } else {
            out.push_str(NoExpand(replacement).0);
        }
        last = m.end();
        count += 1;
    }
    out.push_str(&line[last..]);
    count
}

/// Replaces non-empty matches line by line, the same units the folder search matches, so a
/// pattern never spans or eats a line break; terminators are kept byte for byte. `$1` expands
/// only when `expand`. Returns text and count.
pub fn replace_in_text(re: &Regex, text: &str, replacement: &str, expand: bool, eol: Eol) -> (String, usize) {
    let mut out = String::with_capacity(text.len());
    let mut count = 0usize;
    let mut rest = text;
    while !rest.is_empty() {
        let (line, term) = split_line(rest, eol);
        count += replace_in_line(re, line, replacement, expand, &mut out);
        out.push_str(term);
        rest = &rest[line.len() + term.len()..];
    }
    (out, count)
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceResult {
    pub files_changed: usize,
    pub replacements: usize,
}

pub fn replace_paths(opts: &SearchOpts, replacement: &str, paths: &[String]) -> Result<ReplaceResult, AppError> {
    let re = build_replace_regex(&opts.query, opts.regex, opts.case_sensitive, opts.whole_word)?;
    let mut result = ReplaceResult { files_changed: 0, replacements: 0 };
    for p in paths {
        let path = Path::new(p);
        let (decoded, _) = read_decoded(path)?;
        let (text, count) = replace_in_text(&re, &decoded.text, replacement, opts.regex, decoded.eol);
        if count == 0 {
            continue;
        }
        if decoded.lossy {
            // Writing the decoded text back would turn the invalid bytes into U+FFFD for good.
            return Err(AppError::encoding(format!(
                "{p}: contains bytes that are not valid {}; open and save it in the editor instead",
                decoded.encoding
            )));
        }
        write_encoded(path, &text, &decoded.encoding, decoded.bom)?;
        result.files_changed += 1;
        result.replacements += count;
    }
    Ok(result)
}

// ---- commands ----

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn search_folder(
    app: AppHandle,
    state: State<'_, SearchState>,
    search_id: String,
    root: String,
    query: String,
    regex: bool,
    case_sensitive: bool,
    whole_word: bool,
    include: String,
    exclude: String,
) -> Result<(), AppError> {
    let opts = SearchOpts { query, regex, case_sensitive, whole_word, include, exclude };
    let root_path = std::path::PathBuf::from(&root);
    let prep = blocking({
        let opts = opts.clone();
        move || prepare(&root_path, &opts)
    })
    .await?;

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut map = state.0.lock().map_err(|_| AppError::io("search state poisoned"))?;
        if let Some(old) = map.insert(search_id.clone(), cancel.clone()) {
            old.store(true, Ordering::Relaxed);
        }
    }
    std::thread::spawn(move || {
        let summary = execute(&prep, &cancel, MAX_MATCHES, |r| {
            let ev = ResultEvent { search_id: &search_id, path: &r.path, items: &r.items };
            if let Err(e) = app.emit("search://result", ev) {
                log::error!("search: cannot emit search://result: {e}");
            }
        });
        if let Err(e) = app.emit("search://done", DoneEvent { search_id: &search_id, summary }) {
            log::error!("search: cannot emit search://done: {e}");
        }
        match app.state::<SearchState>().0.lock() {
            Ok(mut map) => {
                if map.get(&search_id).is_some_and(|c| Arc::ptr_eq(c, &cancel)) {
                    map.remove(&search_id);
                }
            }
            Err(_) => log::error!("search: state poisoned while finishing {search_id}"),
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn cancel_search(state: State<'_, SearchState>, search_id: String) -> Result<(), AppError> {
    let map = state.0.lock().map_err(|_| AppError::io("search state poisoned"))?;
    if let Some(flag) = map.get(&search_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// `root` is accepted for symmetry with `search_folder`; only `paths` are touched.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn replace_in_folder(
    #[allow(unused_variables)] root: String,
    query: String,
    replacement: String,
    regex: bool,
    case_sensitive: bool,
    whole_word: bool,
    paths: Vec<String>,
) -> Result<ReplaceResult, AppError> {
    let opts = SearchOpts { query, regex, case_sensitive, whole_word, include: String::new(), exclude: String::new() };
    blocking(move || replace_paths(&opts, &replacement, &paths)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;
    use std::fs;

    fn opts(q: &str) -> SearchOpts {
        SearchOpts { query: q.into(), regex: false, case_sensitive: false, whole_word: false, include: String::new(), exclude: String::new() }
    }

    fn tree() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        fs::create_dir_all(r.join("src")).unwrap();
        fs::create_dir_all(r.join("build")).unwrap();
        fs::create_dir_all(r.join(".git")).unwrap();
        fs::write(r.join(".gitignore"), "build/\nsecret.txt\n").unwrap();
        fs::write(r.join("a.txt"), "Hello World\nnothing\nhello again, hello!\n").unwrap();
        fs::write(r.join("src/b.rs"), "fn hello_world() {}\nlet helloX = 1;\n").unwrap();
        fs::write(r.join("secret.txt"), "hello ignored\n").unwrap();
        fs::write(r.join("build/out.txt"), "hello ignored\n").unwrap();
        fs::write(r.join(".git/config"), "hello git\n").unwrap();
        fs::write(r.join(".hidden.txt"), "hello hidden\n").unwrap();
        fs::write(r.join("bin.dat"), b"hello\0binary hello").unwrap();
        d
    }

    fn names(results: &[FileResult], root: &Path) -> Vec<String> {
        let mut v: Vec<String> = results
            .iter()
            .map(|r| Path::new(&r.path).strip_prefix(dunce::simplified(root)).unwrap().to_string_lossy().replace('\\', "/"))
            .collect();
        v.sort();
        v
    }

    fn search(root: &Path, o: &SearchOpts) -> (Vec<FileResult>, Summary) {
        run_search(root, o, &AtomicBool::new(false), MAX_MATCHES).unwrap()
    }

    #[test]
    fn skips_ignored_binary_and_git_but_includes_hidden() {
        let d = tree();
        let (res, sum) = search(d.path(), &opts("hello"));
        assert_eq!(names(&res, d.path()), vec![".hidden.txt", "a.txt", "src/b.rs"]);
        assert_eq!(sum.files, 3);
        assert_eq!(sum.matches, 6 /* a.txt 3, b.rs 2, .hidden.txt 1 */);
        assert!(!sum.truncated && !sum.cancelled);
    }

    #[test]
    fn items_have_line_col_preview_len() {
        let d = tree();
        let (res, _) = search(d.path(), &opts("hello"));
        let a = res.iter().find(|r| r.path.ends_with("a.txt")).unwrap();
        assert_eq!(
            a.items,
            vec![
                Item { line: 1, col: 1, preview: "Hello World".into(), match_len: 5 },
                Item { line: 3, col: 1, preview: "hello again, hello!".into(), match_len: 5 },
                Item { line: 3, col: 14, preview: "hello again, hello!".into(), match_len: 5 },
            ]
        );
    }

    #[test]
    fn case_sensitivity() {
        let d = tree();
        let mut o = opts("hello");
        o.case_sensitive = true;
        let (res, sum) = search(d.path(), &o);
        let a = res.iter().find(|r| r.path.ends_with("a.txt")).unwrap();
        assert_eq!(a.items.len(), 2);
        assert_eq!(sum.matches, 5 /* a.txt 2, b.rs 2, .hidden.txt 1 */);
    }

    #[test]
    fn whole_word() {
        let d = tree();
        let mut o = opts("hello");
        o.whole_word = true;
        let (res, _) = search(d.path(), &o);
        // hello_world and helloX are not whole-word matches
        assert_eq!(names(&res, d.path()), vec![".hidden.txt", "a.txt"]);
    }

    #[test]
    fn regex_and_literal_modes() {
        let d = tree();
        let mut o = opts("hel+o\\s+W");
        o.regex = true;
        let (res, _) = search(d.path(), &o);
        assert_eq!(names(&res, d.path()), vec!["a.txt"]);
        o.regex = false; // now literal: the backslash pattern matches nothing
        let (res, _) = search(d.path(), &o);
        assert!(res.is_empty());
        assert_eq!(search(d.path(), &opts("fn hello_world() {}")).0.len(), 1, "literal metacharacters");
    }

    #[test]
    fn include_and_exclude_globs() {
        let d = tree();
        let mut o = opts("hello");
        o.include = "*.rs, *.txt".into();
        let (res, _) = search(d.path(), &o);
        assert_eq!(names(&res, d.path()), vec![".hidden.txt", "a.txt", "src/b.rs"]);
        o.include = "*.rs".into();
        assert_eq!(names(&search(d.path(), &o).0, d.path()), vec!["src/b.rs"]);
        o.include = String::new();
        o.exclude = "*.rs,.hidden.txt".into();
        assert_eq!(names(&search(d.path(), &o).0, d.path()), vec!["a.txt"]);
        o.exclude = "src".into();
        assert_eq!(names(&search(d.path(), &o).0, d.path()), vec![".hidden.txt", "a.txt"]);
    }

    #[test]
    fn cap_truncates() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("many.txt"), "x x x x x x\n".repeat(10)).unwrap();
        let (res, sum) = run_search(d.path(), &opts("x"), &AtomicBool::new(false), 25).unwrap();
        assert!(sum.truncated);
        assert_eq!(sum.matches, 25);
        assert_eq!(res[0].items.len(), 25);
    }

    #[test]
    fn cancel_flag_stops_search() {
        let d = tree();
        let (res, sum) = run_search(d.path(), &opts("hello"), &AtomicBool::new(true), MAX_MATCHES).unwrap();
        assert!(res.is_empty());
        assert!(sum.cancelled);
    }

    #[test]
    fn bad_inputs_are_errors() {
        let d = tree();
        assert_eq!(prepare(d.path(), &opts("")).err().unwrap().kind, ErrorKind::InvalidArg);
        let mut o = opts("(");
        o.regex = true;
        assert_eq!(prepare(d.path(), &o).err().unwrap().kind, ErrorKind::Parse);
        assert_eq!(prepare(&d.path().join("nope"), &opts("a")).err().unwrap().kind, ErrorKind::NotFound);
    }

    #[test]
    fn crlf_files_match_line_end_anchor() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("w.txt"), "foo\r\nbar foo\r\nfoo bar\r\n").unwrap();
        let mut o = opts("foo$");
        o.regex = true;
        let (res, sum) = search(d.path(), &o);
        assert_eq!(sum.matches, 2);
        assert_eq!(res[0].items[0].preview, "foo");
        assert_eq!(res[0].items[1].preview, "bar foo");
    }

    #[test]
    fn long_lines_are_windowed() {
        let d = tempfile::tempdir().unwrap();
        let line = format!("{}NEEDLE{}", "a".repeat(1000), "b".repeat(1000));
        fs::write(d.path().join("l.txt"), &line).unwrap();
        let (res, _) = search(d.path(), &opts("needle"));
        let it = &res[0].items[0];
        assert_eq!(it.preview.chars().count(), 300);
        assert_eq!(it.match_len, 6);
        let start = it.col - 1;
        assert_eq!(&it.preview[start..start + 6], "NEEDLE");
    }

    #[test]
    fn leading_whitespace_is_trimmed_and_col_is_in_chars() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("t.txt"), "    \u{e9}\u{e9} target here\n").unwrap();
        let (res, _) = search(d.path(), &opts("target"));
        let it = &res[0].items[0];
        assert_eq!(it.preview, "\u{e9}\u{e9} target here");
        assert_eq!((it.col, it.match_len), (4, 6));
    }

    #[test]
    fn replace_literal_and_regex_modes() {
        let re = build_replace_regex("a(b)", true, true, false).unwrap();
        assert_eq!(replace_in_text(&re, "ab ab", "[$1]", true, Eol::Lf), ("[b] [b]".to_string(), 2));
        let re = build_replace_regex("a(b)", false, true, false).unwrap();
        assert_eq!(replace_in_text(&re, "a(b) a(b)", "$1", false, Eol::Lf), ("$1 $1".to_string(), 2));
        let re = build_replace_regex("x*", true, true, false).unwrap();
        assert_eq!(replace_in_text(&re, "axxb", "-", true, Eol::Lf), ("a-b".to_string(), 1), "empty matches are skipped");
    }

    #[test]
    fn replace_works_line_by_line_and_keeps_terminators() {
        let re = build_replace_regex(r"\s+$", true, true, false).unwrap();
        let text = "foo  \r\n\r\nbar\r\n";
        assert_eq!(replace_in_text(&re, text, "", true, Eol::Crlf), ("foo\r\n\r\nbar\r\n".to_string(), 1));
        // The folder search counts the same single match.
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("t.txt"), text).unwrap();
        let mut o = opts(r"\s+$");
        o.regex = true;
        assert_eq!(search(d.path(), &o).1.matches, 1);
        // Mixed terminators, a last line without one, and lone-CR files.
        assert_eq!(replace_in_text(&re, "a \nb \r\nc ", "", true, Eol::Lf), ("a\nb\r\nc".to_string(), 3));
        assert_eq!(replace_in_text(&re, "a \rb \r", "", true, Eol::Cr), ("a\rb\r".to_string(), 2));
        let re = build_replace_regex("^", true, true, false).unwrap();
        assert_eq!(replace_in_text(&re, "", "x", true, Eol::Lf), (String::new(), 0));
    }

    #[test]
    fn whole_word_with_non_word_edges() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("yes.txt"), "x foo( y\n").unwrap();
        fs::write(d.path().join("no.txt"), "xfoo( y\n").unwrap();
        let mut o = opts("foo(");
        o.whole_word = true;
        let (res, sum) = search(d.path(), &o);
        assert_eq!(names(&res, d.path()), vec!["yes.txt"]);
        assert_eq!(sum.matches, 1);
        let re = build_replace_regex("foo(", false, true, true).unwrap();
        assert_eq!(replace_in_text(&re, "x foo( y xfoo( z", "bar", false, Eol::Lf), ("x bar y xfoo( z".to_string(), 1));
        // Word edges still need a boundary.
        let re = build_replace_regex("cat", false, true, true).unwrap();
        assert_eq!(replace_in_text(&re, "cat concat cats", "dog", false, Eol::Lf).1, 1);
    }

    #[test]
    fn cancel_stops_mid_file() {
        /// Endless non-matching bytes; sets the cancel flag after a few reads.
        struct Endless<'a> {
            reads: usize,
            cancel: &'a AtomicBool,
        }
        impl std::io::Read for Endless<'_> {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                self.reads += 1;
                if self.reads == 3 {
                    self.cancel.store(true, Ordering::Relaxed);
                }
                buf.fill(b'a');
                if let Some(last) = buf.last_mut() {
                    *last = b'\n';
                }
                Ok(buf.len())
            }
        }
        let cancel = AtomicBool::new(false);
        let prep = {
            let d = tempfile::tempdir().unwrap();
            prepare(d.path(), &opts("needle")).unwrap()
        };
        let mut searcher = SearcherBuilder::new().line_terminator(LineTerminator::crlf()).build();
        let (mut total, mut truncated) = (0, false);
        let mut sink = Collector { matcher: &prep.matcher, items: Vec::new(), total: &mut total, truncated: &mut truncated, cap: 10, cancel: &cancel };
        let reader = CancelReader { inner: Endless { reads: 0, cancel: &cancel }, cancel: &cancel };
        let err = searcher.search_reader(&prep.matcher, reader, &mut sink).unwrap_err();
        assert!(is_cancelled(&err), "{err}");
    }

    #[test]
    fn replace_refuses_lossy_files() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("bad.txt");
        let bytes = b"\xEF\xBB\xBFfoo \xE9 bar\n";
        fs::write(&p, bytes).unwrap();
        let err = replace_paths(&opts("foo"), "baz", &[p.to_string_lossy().into_owned()]).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Encoding);
        assert!(err.message.contains("not valid utf-8"), "{}", err.message);
        assert_eq!(fs::read(&p).unwrap(), bytes, "file untouched");
    }

    #[test]
    fn replace_preserves_encoding_bom_and_eol() {
        let d = tempfile::tempdir().unwrap();
        let p16 = d.path().join("u16.txt");
        let mut bytes = vec![0xFF, 0xFE];
        for u in "one foo\r\ntwo foo\r\n".encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        fs::write(&p16, &bytes).unwrap();
        let p1252 = d.path().join("l1.txt");
        fs::write(&p1252, b"caf\xE9 foo\nfoo\n").unwrap();
        let untouched = d.path().join("n.txt");
        fs::write(&untouched, "bar\r\n").unwrap();

        let mut o = opts("FOO");
        o.case_sensitive = false;
        let paths = vec![p16.to_string_lossy().into_owned(), p1252.to_string_lossy().into_owned(), untouched.to_string_lossy().into_owned()];
        let r = replace_paths(&o, "b\u{e9}r", &paths).unwrap();
        assert_eq!(r, ReplaceResult { files_changed: 2, replacements: 4 });

        let mut expect = vec![0xFF, 0xFE];
        for u in "one b\u{e9}r\r\ntwo b\u{e9}r\r\n".encode_utf16() {
            expect.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(fs::read(&p16).unwrap(), expect);
        assert_eq!(fs::read(&p1252).unwrap(), b"caf\xE9 b\xE9r\nb\xE9r\n");
        assert_eq!(fs::read(&untouched).unwrap(), b"bar\r\n");
    }

    #[test]
    fn replace_unmappable_is_encoding_error_and_file_untouched() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("l1.txt");
        fs::write(&p, b"caf\xE9 foo\n").unwrap();
        let err = replace_paths(&opts("foo"), "\u{4E2D}", &[p.to_string_lossy().into_owned()]).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Encoding);
        assert_eq!(fs::read(&p).unwrap(), b"caf\xE9 foo\n");
    }

    #[test]
    fn replace_whole_word_with_groups() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("w.txt");
        fs::write(&p, "cat concat cat\n").unwrap();
        let mut o = opts("(c)at");
        o.regex = true;
        o.whole_word = true;
        let r = replace_paths(&o, "${1}ow", &[p.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(r.replacements, 2);
        assert_eq!(fs::read_to_string(&p).unwrap(), "cow concat cow\n");
    }
}
