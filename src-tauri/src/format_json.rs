//! Strict, single-pass, non-recursive JSON validator + formatter.
//!
//! Number and string text is copied byte-for-byte, key order and duplicate keys are kept. Pretty
//! output has the layout of `JSON.stringify(JSON.parse(x), null, indent)`. Output is only
//! returned for valid input.

use crate::files::{header, raw_body, utf8_text};
use crate::error::AppError;
use tauri::ipc::{Request, Response};

const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Pretty,
    Minify,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Indent {
    Spaces(usize),
    Tab,
}

impl Indent {
    pub fn parse(s: &str) -> Result<Self, AppError> {
        match s.trim().to_ascii_lowercase().as_str() {
            "tab" => Ok(Self::Tab),
            n => match n.parse::<usize>() {
                Ok(n) if (1..=16).contains(&n) => Ok(Self::Spaces(n)),
                _ => Err(AppError::invalid_arg(format!("x-indent must be 2, 4 or tab, got '{s}'"))),
            },
        }
    }

    /// (pad byte, bytes per nesting level)
    pub fn unit(self) -> (u8, usize) {
        match self {
            Self::Spaces(n) => (b' ', n),
            Self::Tab => (b'\t', 1),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct FormatOptions {
    pub mode: Mode,
    pub indent: Indent,
}

impl FormatOptions {
    /// Reads `x-mode` (default pretty) and `x-indent` (default 2).
    pub fn from_request(request: &Request<'_>) -> Result<Self, AppError> {
        let mode = match header(request, "x-mode")?.as_deref().map(str::trim) {
            None | Some("pretty") => Mode::Pretty,
            Some("minify") => Mode::Minify,
            Some(other) => return Err(AppError::invalid_arg(format!("x-mode must be pretty or minify, got '{other}'"))),
        };
        let indent = match header(request, "x-indent")? {
            None => Indent::Spaces(2),
            Some(s) => Indent::parse(&s)?,
        };
        Ok(Self { mode, indent })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Container {
    Obj,
    Arr,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Expect {
    /// A value (top level, after `:`, after `,` in an array).
    Value,
    /// Just after `[`: a value or `]`.
    ValueOrEnd,
    /// Just after `{`: a key or `}`.
    KeyOrEnd,
    /// After `,` in an object.
    Key,
    Colon,
    CommaOrEnd,
    /// After the top-level value.
    Done,
}

fn newline(out: &mut Vec<u8>, depth: usize, unit: (u8, usize)) {
    out.push(b'\n');
    out.resize(out.len() + depth * unit.1, unit.0);
}

fn after_value(stack: &[Container]) -> Expect {
    if stack.is_empty() { Expect::Done } else { Expect::CommaOrEnd }
}

pub fn format_bytes(input: &[u8], opts: FormatOptions) -> Result<Vec<u8>, AppError> {
    let input = input.strip_prefix(&UTF8_BOM).unwrap_or(input);
    let text = utf8_text(input, "input")?;
    let n = input.len();
    let pretty = opts.mode == Mode::Pretty;
    let unit = opts.indent.unit();
    let fail = |at: usize, msg: &str| -> AppError { AppError::parse_at(input, at, msg) };
    let unexpected = |at: usize, wanted: &str| -> AppError {
        let found = text.get(at..).and_then(|s| s.chars().next()).map_or_else(
            || "end of input".to_string(),
            |c| format!("character {c:?}"),
        );
        AppError::parse_at(input, at, format!("unexpected {found}, expected {wanted}"))
    };

    let mut out: Vec<u8> = Vec::with_capacity(if pretty { n + n / 4 } else { n });
    let mut stack: Vec<Container> = Vec::new();
    let mut expect = Expect::Value;
    let mut i = 0;

    loop {
        while i < n && matches!(input[i], b' ' | b'\t' | b'\n' | b'\r') {
            i += 1;
        }
        if i >= n {
            break;
        }
        let b = input[i];
        match expect {
            Expect::Done => return Err(unexpected(i, "end of input")),
            Expect::Colon => {
                if b != b':' {
                    return Err(unexpected(i, "':'"));
                }
                out.push(b':');
                if pretty {
                    out.push(b' ');
                }
                i += 1;
                expect = Expect::Value;
            }
            Expect::CommaOrEnd => {
                let top = stack.last().copied().unwrap_or(Container::Arr);
                match (b, top) {
                    (b',', _) => {
                        out.push(b',');
                        if pretty {
                            newline(&mut out, stack.len(), unit);
                        }
                        i += 1;
                        expect = if top == Container::Obj { Expect::Key } else { Expect::Value };
                    }
                    (b'}', Container::Obj) | (b']', Container::Arr) => {
                        stack.pop();
                        if pretty {
                            newline(&mut out, stack.len(), unit);
                        }
                        out.push(b);
                        i += 1;
                        expect = after_value(&stack);
                    }
                    (_, Container::Obj) => return Err(unexpected(i, "',' or '}'")),
                    (_, Container::Arr) => return Err(unexpected(i, "',' or ']'")),
                }
            }
            Expect::Key | Expect::KeyOrEnd => {
                if expect == Expect::KeyOrEnd && b == b'}' {
                    stack.pop();
                    out.push(b'}');
                    i += 1;
                    expect = after_value(&stack);
                    continue;
                }
                if b != b'"' {
                    return Err(unexpected(i, if expect == Expect::Key { "a string key" } else { "a string key or '}'" }));
                }
                if pretty && expect == Expect::KeyOrEnd {
                    newline(&mut out, stack.len(), unit);
                }
                i = scan_string(input, i, &mut out).map_err(|(at, m)| fail(at, m))?;
                expect = Expect::Colon;
            }
            Expect::ValueOrEnd | Expect::Value => {
                if expect == Expect::ValueOrEnd {
                    if b == b']' {
                        stack.pop();
                        out.push(b']');
                        i += 1;
                        expect = after_value(&stack);
                        continue;
                    }
                    if pretty {
                        newline(&mut out, stack.len(), unit);
                    }
                }
                match b {
                    b'{' => {
                        out.push(b'{');
                        stack.push(Container::Obj);
                        i += 1;
                        expect = Expect::KeyOrEnd;
                    }
                    b'[' => {
                        out.push(b'[');
                        stack.push(Container::Arr);
                        i += 1;
                        expect = Expect::ValueOrEnd;
                    }
                    b'"' => {
                        i = scan_string(input, i, &mut out).map_err(|(at, m)| fail(at, m))?;
                        expect = after_value(&stack);
                    }
                    b'-' | b'0'..=b'9' => {
                        i = scan_number(input, i, &mut out).map_err(|(at, m)| fail(at, m))?;
                        expect = after_value(&stack);
                    }
                    b't' | b'f' | b'n' => {
                        let lit: &[u8] = match b {
                            b't' => b"true",
                            b'f' => b"false",
                            _ => b"null",
                        };
                        if !input[i..].starts_with(lit) {
                            return Err(unexpected(i, "a JSON value"));
                        }
                        out.extend_from_slice(lit);
                        i += lit.len();
                        expect = after_value(&stack);
                    }
                    _ => return Err(unexpected(i, "a JSON value")),
                }
            }
        }
    }

    match (expect, stack.last()) {
        (Expect::Done, _) => Ok(out),
        (Expect::Value, None) => Err(fail(n, "unexpected end of input, expected a JSON value")),
        (_, Some(Container::Obj)) => Err(fail(n, "unexpected end of input, unclosed '{'")),
        (_, _) => Err(fail(n, "unexpected end of input, unclosed '['")),
    }
}

type ScanError = (usize, &'static str);

/// Validates the string starting at `start` (the opening quote) and copies it verbatim.
/// Returns the index after the closing quote.
fn scan_string(input: &[u8], start: usize, out: &mut Vec<u8>) -> Result<usize, ScanError> {
    let n = input.len();
    let mut i = start + 1;
    while i < n {
        match input[i] {
            b'"' => {
                out.extend_from_slice(&input[start..=i]);
                return Ok(i + 1);
            }
            b'\\' => {
                i += 1;
                match input.get(i) {
                    Some(b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't') => i += 1,
                    Some(b'u') => {
                        for k in 1..=4 {
                            if !input.get(i + k).is_some_and(u8::is_ascii_hexdigit) {
                                return Err((i + k.min(n - i), "invalid \\u escape, expected 4 hex digits"));
                            }
                        }
                        i += 5;
                    }
                    Some(_) => return Err((i, "invalid escape sequence in string")),
                    None => break,
                }
            }
            0..=0x1F => return Err((i, "unescaped control character in string")),
            _ => i += 1,
        }
    }
    Err((start, "unterminated string"))
}

fn scan_digits(input: &[u8], mut i: usize) -> usize {
    while i < input.len() && input[i].is_ascii_digit() {
        i += 1;
    }
    i
}

/// Validates the RFC 8259 number at `start` and copies it verbatim; returns the end index.
fn scan_number(input: &[u8], start: usize, out: &mut Vec<u8>) -> Result<usize, ScanError> {
    let mut i = start;
    if input[i] == b'-' {
        i += 1;
    }
    match input.get(i) {
        Some(b'0') => i += 1,
        Some(b'1'..=b'9') => i = scan_digits(input, i),
        _ => return Err((i, "invalid number, expected a digit")),
    }
    if input.get(i) == Some(&b'.') {
        let end = scan_digits(input, i + 1);
        if end == i + 1 {
            return Err((i + 1, "invalid number, expected a digit after '.'"));
        }
        i = end;
    }
    if matches!(input.get(i), Some(b'e' | b'E')) {
        let mut j = i + 1;
        if matches!(input.get(j), Some(b'+' | b'-')) {
            j += 1;
        }
        let end = scan_digits(input, j);
        if end == j {
            return Err((j, "invalid number, expected a digit in exponent"));
        }
        i = end;
    }
    out.extend_from_slice(&input[start..i]);
    Ok(i)
}

#[tauri::command(async)]
pub fn format_json(request: Request<'_>) -> Result<Response, AppError> {
    let opts = FormatOptions::from_request(&request)?;
    format_bytes(raw_body(&request)?, opts).map(Response::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;

    fn pretty(s: &str, indent: Indent) -> Result<String, AppError> {
        format_bytes(s.as_bytes(), FormatOptions { mode: Mode::Pretty, indent }).map(|v| String::from_utf8(v).unwrap())
    }
    fn p2(s: &str) -> String {
        pretty(s, Indent::Spaces(2)).unwrap()
    }
    fn minify(s: &str) -> Result<String, AppError> {
        format_bytes(s.as_bytes(), FormatOptions { mode: Mode::Minify, indent: Indent::Spaces(2) })
            .map(|v| String::from_utf8(v).unwrap())
    }

    const SAMPLE: &str = r#"{"a":[1,2,{"b":null}],"c":{},"d":[],"e":"x","f":[[],{}],"g":[true,false]}"#;

    #[test]
    fn pretty_indent_2() {
        let expected = "{\n  \"a\": [\n    1,\n    2,\n    {\n      \"b\": null\n    }\n  ],\n  \"c\": {},\n  \"d\": [],\n  \"e\": \"x\",\n  \"f\": [\n    [],\n    {}\n  ],\n  \"g\": [\n    true,\n    false\n  ]\n}";
        assert_eq!(p2(SAMPLE), expected);
    }

    #[test]
    fn pretty_indent_4_and_tab() {
        assert_eq!(pretty(r#"{"a":[1,{"b":2}]}"#, Indent::Spaces(4)).unwrap(), "{\n    \"a\": [\n        1,\n        {\n            \"b\": 2\n        }\n    ]\n}");
        assert_eq!(pretty(r#"{"a":[1,{"b":2}]}"#, Indent::Tab).unwrap(), "{\n\t\"a\": [\n\t\t1,\n\t\t{\n\t\t\t\"b\": 2\n\t\t}\n\t]\n}");
    }

    #[test]
    fn minify_strips_whitespace() {
        assert_eq!(minify("{ \"a\" : [ 1 , 2 ,\n {\"b\" : null} ] ,\t\"c\": { } , \"d\": [ ] }").unwrap(), r#"{"a":[1,2,{"b":null}],"c":{},"d":[]}"#);
        assert_eq!(minify("\"a b\"").unwrap(), "\"a b\"");
    }

    #[test]
    fn empty_containers_stay_inline() {
        assert_eq!(p2("{}"), "{}");
        assert_eq!(p2("[ ]"), "[]");
        assert_eq!(p2("[{},[]]"), "[\n  {},\n  []\n]");
        assert_eq!(p2("{\n}"), "{}");
    }

    #[test]
    fn scalars_at_top_level() {
        assert_eq!(p2("  42 \n"), "42");
        assert_eq!(p2("null"), "null");
        assert_eq!(p2("\"s\""), "\"s\"");
    }

    #[test]
    fn strings_are_copied_verbatim() {
        let src = r#"["a\"b","\u00e9","caf\u00E9 \/ \n","😀","é","\\"]"#;
        let out = minify(src).unwrap();
        assert_eq!(out, src);
        assert!(p2(src).contains(r#""a\"b""#));
        assert!(p2(src).contains("\"\\u00e9\""));
        assert!(p2(src).contains("\"😀\""));
        assert_eq!(minify(r#""a\"b""#).unwrap(), r#""a\"b""#);
    }

    #[test]
    fn big_numbers_copied_exactly() {
        let src = "[12345678901234567890.123e-5,-0,0.0,1E+400,-1.5e3]";
        assert_eq!(minify(src).unwrap(), src);
        assert!(p2(src).contains("[\n  12345678901234567890.123e-5,\n"));
    }

    #[test]
    fn duplicate_keys_and_order_kept() {
        assert_eq!(minify(r#"{"b":1,"a":2,"b":3}"#).unwrap(), r#"{"b":1,"a":2,"b":3}"#);
    }

    #[test]
    fn bom_is_dropped() {
        let mut v = UTF8_BOM.to_vec();
        v.extend_from_slice(b" [1] ");
        let out = format_bytes(&v, FormatOptions { mode: Mode::Minify, indent: Indent::Tab }).unwrap();
        assert_eq!(out, b"[1]");
    }

    #[test]
    fn deep_nesting_does_not_overflow() {
        let depth = 10_000;
        let src = format!("{}{}", "[".repeat(depth), "]".repeat(depth));
        assert_eq!(minify(&src).unwrap(), src);
        let out = pretty(&src, Indent::Tab).unwrap();
        assert_eq!(out.lines().count(), depth * 2 - 1); // innermost [] stays inline
        assert!(out.starts_with("[\n\t["));
        let obj = format!("{}1{}", "{\"a\":".repeat(depth), "}".repeat(depth));
        assert_eq!(minify(&obj).unwrap(), obj);
    }

    fn err_of(s: &str) -> (ErrorKind, usize, usize) {
        let e = minify(s).unwrap_err();
        assert_eq!(e, pretty(s, Indent::Spaces(2)).unwrap_err(), "pretty and minify disagree for {s:?}");
        (e.kind, e.line.unwrap(), e.col.unwrap())
    }

    #[test]
    fn invalid_inputs_report_position() {
        assert_eq!(err_of("[1,2,]"), (ErrorKind::Parse, 1, 6));
        assert_eq!(err_of("{\"a\":1,}"), (ErrorKind::Parse, 1, 8));
        assert_eq!(err_of("{\"a\" 1}"), (ErrorKind::Parse, 1, 6));
        assert_eq!(err_of("[\"abc"), (ErrorKind::Parse, 1, 2));
        assert_eq!(err_of("01"), (ErrorKind::Parse, 1, 2));
        assert_eq!(err_of("1 2"), (ErrorKind::Parse, 1, 3));
        assert_eq!(err_of("{} {}"), (ErrorKind::Parse, 1, 4));
        assert_eq!(err_of("[1, /*c*/ 2]"), (ErrorKind::Parse, 1, 5));
        assert_eq!(err_of("// hi\n1"), (ErrorKind::Parse, 1, 1));
        assert_eq!(err_of("{\n  \"a\": 1,\n}"), (ErrorKind::Parse, 3, 1));
        assert_eq!(err_of("[\n  tru\n]"), (ErrorKind::Parse, 2, 3));
        assert_eq!(err_of("[1 2]"), (ErrorKind::Parse, 1, 4));
        assert_eq!(err_of("{'a':1}"), (ErrorKind::Parse, 1, 2));
        assert_eq!(err_of("[\"é\" x]"), (ErrorKind::Parse, 1, 6));
    }

    #[test]
    fn invalid_numbers_strings_and_eof() {
        assert_eq!(err_of("-"), (ErrorKind::Parse, 1, 2));
        assert_eq!(err_of("1."), (ErrorKind::Parse, 1, 3));
        assert_eq!(err_of("1e"), (ErrorKind::Parse, 1, 3));
        assert_eq!(err_of(".5"), (ErrorKind::Parse, 1, 1));
        assert_eq!(err_of("+1"), (ErrorKind::Parse, 1, 1));
        assert_eq!(err_of("[\"\\x\"]"), (ErrorKind::Parse, 1, 4));
        assert_eq!(err_of("[\"\\u12G4\"]"), (ErrorKind::Parse, 1, 7));
        assert_eq!(err_of("[\"a\tb\"]"), (ErrorKind::Parse, 1, 4));
        assert_eq!(err_of(""), (ErrorKind::Parse, 1, 1));
        assert_eq!(err_of("   \n"), (ErrorKind::Parse, 2, 1));
        assert_eq!(err_of("[1,\n2"), (ErrorKind::Parse, 2, 2));
        assert_eq!(err_of("{\"a\":"), (ErrorKind::Parse, 1, 6));
        assert_eq!(err_of("NaN"), (ErrorKind::Parse, 1, 1));
    }

    #[test]
    fn invalid_utf8_is_parse_error() {
        let e = format_bytes(b"[\"\xFF\"]", FormatOptions { mode: Mode::Minify, indent: Indent::Tab }).unwrap_err();
        assert_eq!((e.kind, e.line, e.col), (ErrorKind::Parse, Some(1), Some(3)));
    }

    #[test]
    fn format_of_minify_equals_format() {
        let corpus = [
            SAMPLE,
            "[]",
            "{}",
            "[1, 2.5, -3e10, \"x\", null, true, false, [], {}]",
            "{\"k\": {\"k\": {\"k\": [ {\"z\" : \"\\u00e9\\n\"} ]}}}",
            "  \"just a string\"  ",
            "\n[\n1\n,\n2\n]\n",
            "{\"a\":1,\"a\":2,\"b\":[0.10,1E5]}",
        ];
        for s in corpus {
            for indent in [Indent::Spaces(2), Indent::Spaces(4), Indent::Tab] {
                let direct = pretty(s, indent).unwrap();
                let via = pretty(&minify(s).unwrap(), indent).unwrap();
                assert_eq!(direct, via, "mismatch for {s:?}");
                assert_eq!(minify(&direct).unwrap(), minify(s).unwrap());
            }
        }
    }

    #[test]
    fn indent_parsing() {
        assert_eq!(Indent::parse("2").unwrap(), Indent::Spaces(2));
        assert_eq!(Indent::parse("tab").unwrap(), Indent::Tab);
        assert_eq!(Indent::parse("x").unwrap_err().kind, ErrorKind::InvalidArg);
    }

    /// `cargo test --release -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn perf_150mb() {
        use std::fmt::Write;
        let mut src = String::with_capacity(160 << 20);
        src.push('[');
        let mut i = 0u64;
        while src.len() < 150 << 20 {
            if i > 0 {
                src.push(',');
            }
            write!(
                src,
                "{{\"id\":{i},\"name\":\"item \\\"{i}\\\" \\u00e9 caf\u{e9}\",\"price\":{}.{:03}e-2,\"tags\":[\"a\",\"b\",null,true,false],\"nested\":{{\"x\":[1,2,3],\"y\":{{}},\"z\":[]}}}}",
                i * 7919 % 100_003,
                i % 1000
            )
            .unwrap();
            i += 1;
        }
        src.push(']');
        let mb = src.len() as f64 / 1_048_576.0;
        let t = std::time::Instant::now();
        let pretty_out = format_bytes(src.as_bytes(), FormatOptions { mode: Mode::Pretty, indent: Indent::Spaces(2) }).unwrap();
        let t_pretty = t.elapsed();
        let t = std::time::Instant::now();
        let min_out = format_bytes(src.as_bytes(), FormatOptions { mode: Mode::Minify, indent: Indent::Spaces(2) }).unwrap();
        let t_min = t.elapsed();
        assert_eq!(min_out.len(), src.len());
        println!(
            "input {mb:.1} MB: pretty {t_pretty:.2?} (out {:.1} MB), minify {t_min:.2?}",
            pretty_out.len() as f64 / 1_048_576.0
        );
    }
}
