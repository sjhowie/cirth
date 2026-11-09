//! XML pretty-printer / minifier. Events are re-emitted as the exact input bytes they came from,
//! so entities, CDATA, comments, PIs and the DOCTYPE are never re-escaped or altered.

use crate::error::AppError;
use crate::files::{utf8_text};
use crate::format_json::{FormatOptions, Mode};
use quick_xml::Reader;
use quick_xml::events::Event;
use crate::upload::{UploadState, request_bytes};
use tauri::State;
use tauri::ipc::{Request, Response};

const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Start,
    End,
    /// Self-closing element, comment, PI, declaration, DOCTYPE.
    Leaf,
    Ws,
    Text,
}

struct Tok {
    start: usize,
    end: usize,
    kind: Kind,
    /// Start tags only: the element has direct non-whitespace text, or `xml:space="preserve"`.
    verbatim: bool,
}

fn is_ws(bytes: &[u8]) -> bool {
    bytes.iter().all(|b| matches!(b, b' ' | b'\t' | b'\r' | b'\n'))
}

fn has_preserve(e: &quick_xml::events::BytesStart<'_>) -> bool {
    e.attributes().flatten().any(|a| a.key.as_ref() == b"xml:space" && a.value.as_ref() == b"preserve")
}

fn tokenize(input: &[u8]) -> Result<Vec<Tok>, AppError> {
    let mut reader = Reader::from_reader(input);
    let cfg = reader.config_mut();
    cfg.trim_text(false);
    cfg.check_end_names = true;

    let mut toks: Vec<Tok> = Vec::new();
    // (token index, name) of open elements
    let mut open: Vec<(usize, Vec<u8>)> = Vec::new();
    loop {
        let start = reader.buffer_position() as usize;
        let ev = reader.read_event().map_err(|e| AppError::parse_at(input, start, e.to_string()))?;
        let end = reader.buffer_position() as usize;
        let mk = |kind: Kind, verbatim: bool| Tok { start, end, kind, verbatim };
        match ev {
            Event::Eof => break,
            Event::Start(e) => {
                open.push((toks.len(), e.name().as_ref().to_vec()));
                toks.push(mk(Kind::Start, has_preserve(&e)));
            }
            Event::End(e) => {
                match open.pop() {
                    Some((_, name)) if name == e.name().as_ref() => {}
                    Some((_, name)) => {
                        return Err(AppError::parse_at(
                            input,
                            start,
                            format!(
                                "mismatched end tag: expected </{}>, found </{}>",
                                String::from_utf8_lossy(&name),
                                String::from_utf8_lossy(e.name().as_ref())
                            ),
                        ));
                    }
                    None => {
                        return Err(AppError::parse_at(
                            input,
                            start,
                            format!("unexpected end tag </{}>", String::from_utf8_lossy(e.name().as_ref())),
                        ));
                    }
                }
                toks.push(mk(Kind::End, false));
            }
            Event::Text(_) if is_ws(&input[start..end]) => toks.push(mk(Kind::Ws, false)),
            Event::Text(_) | Event::CData(_) => {
                if let Some(&(idx, _)) = open.last() {
                    toks[idx].verbatim = true;
                }
                toks.push(mk(Kind::Text, false));
            }
            Event::Empty(_) | Event::Comment(_) | Event::Decl(_) | Event::PI(_) | Event::DocType(_) => {
                toks.push(mk(Kind::Leaf, false));
            }
            #[allow(unreachable_patterns)]
            _ => {
                // e.g. entity references reported as separate events: treat as text.
                if let Some(&(idx, _)) = open.last() {
                    toks[idx].verbatim = true;
                }
                toks.push(mk(Kind::Text, false));
            }
        }
    }
    if let Some((idx, name)) = open.pop() {
        return Err(AppError::parse_at(
            input,
            toks[idx].start,
            format!("unclosed element <{}>", String::from_utf8_lossy(&name)),
        ));
    }
    Ok(toks)
}

pub fn format_xml_bytes(input: &[u8], opts: FormatOptions) -> Result<Vec<u8>, AppError> {
    let input = input.strip_prefix(&UTF8_BOM).unwrap_or(input);
    utf8_text(input, "input")?;
    let toks = tokenize(input)?;

    let pretty = opts.mode == Mode::Pretty;
    let (pad, per) = opts.indent.unit();
    let mut out: Vec<u8> = Vec::with_capacity(input.len() + input.len() / 4);
    let mut depth = 0usize;
    // > 0 while copying a verbatim region; counts nested open elements.
    let mut verbatim_depth = 0usize;
    let mut last_was_start = false;

    let line_start = |out: &mut Vec<u8>, depth: usize| {
        if pretty && !out.is_empty() {
            out.push(b'\n');
            out.resize(out.len() + depth * per, pad);
        }
    };

    for t in &toks {
        let raw = &input[t.start..t.end];
        if verbatim_depth > 0 {
            out.extend_from_slice(raw);
            match t.kind {
                Kind::Start => verbatim_depth += 1,
                Kind::End => {
                    verbatim_depth -= 1;
                    if verbatim_depth == 0 {
                        depth -= 1;
                        last_was_start = false;
                    }
                }
                _ => {}
            }
            continue;
        }
        match t.kind {
            Kind::Ws => {}
            Kind::Start => {
                line_start(&mut out, depth);
                out.extend_from_slice(raw);
                depth += 1;
                if t.verbatim {
                    verbatim_depth = 1;
                } else {
                    last_was_start = true;
                }
            }
            Kind::End => {
                depth = depth.saturating_sub(1);
                if !last_was_start {
                    line_start(&mut out, depth);
                }
                out.extend_from_slice(raw);
                last_was_start = false;
            }
            Kind::Leaf | Kind::Text => {
                line_start(&mut out, depth);
                out.extend_from_slice(raw);
                last_was_start = false;
            }
        }
    }
    Ok(out)
}

#[tauri::command(async)]
pub fn format_xml(request: Request<'_>, uploads: State<'_, UploadState>) -> Result<Response, AppError> {
    let body = request_bytes(&request, &uploads)?;
    let opts = FormatOptions::from_request(&request)?;
    format_xml_bytes(&body, opts).map(Response::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;
    use crate::format_json::Indent;

    fn run(s: &str, mode: Mode, indent: Indent) -> Result<String, AppError> {
        format_xml_bytes(s.as_bytes(), FormatOptions { mode, indent }).map(|v| String::from_utf8(v).unwrap())
    }
    fn pretty(s: &str) -> String {
        run(s, Mode::Pretty, Indent::Spaces(2)).unwrap()
    }
    fn minify(s: &str) -> String {
        run(s, Mode::Minify, Indent::Spaces(2)).unwrap()
    }

    #[test]
    fn indents_nested_document() {
        let src = "<a><b><c/><d x=\"1\"></d></b>\n\n   <e/></a>";
        assert_eq!(pretty(src), "<a>\n  <b>\n    <c/>\n    <d x=\"1\"></d>\n  </b>\n  <e/>\n</a>");
        assert_eq!(
            run(src, Mode::Pretty, Indent::Tab).unwrap(),
            "<a>\n\t<b>\n\t\t<c/>\n\t\t<d x=\"1\"></d>\n\t</b>\n\t<e/>\n</a>"
        );
    }

    #[test]
    fn pretty_is_idempotent() {
        let src = "<?xml version=\"1.0\"?><r><a>t</a><b><c/></b></r>";
        let once = pretty(src);
        assert_eq!(pretty(&once), once);
    }

    #[test]
    fn keeps_decl_comment_cdata_pi_doctype() {
        let src = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE note SYSTEM \"note.dtd\"><!-- top --><?pi data?><note><!-- in --><to><![CDATA[a < b & c]]></to><x/></note>";
        let out = pretty(src);
        assert_eq!(
            out,
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE note SYSTEM \"note.dtd\">\n<!-- top -->\n<?pi data?>\n<note>\n  <!-- in -->\n  <to><![CDATA[a < b & c]]></to>\n  <x/>\n</note>"
        );
    }

    #[test]
    fn mixed_content_unchanged() {
        let src = "<p>Hello <b>world</b>!</p>";
        assert_eq!(pretty(src), src);
        assert_eq!(minify(src), src);
        let src2 = "<doc><p>a <b>x</b> <i>y</i></p><q/></doc>";
        assert_eq!(pretty(src2), "<doc>\n  <p>a <b>x</b> <i>y</i></p>\n  <q/>\n</doc>");
    }

    #[test]
    fn xml_space_preserve_unchanged_and_inherited() {
        let src = "<r><pre xml:space=\"preserve\">\n  <a>  x </a>\n  <b/>\n</pre><z/></r>";
        assert_eq!(pretty(src), "<r>\n  <pre xml:space=\"preserve\">\n  <a>  x </a>\n  <b/>\n</pre>\n  <z/>\n</r>");
        assert_eq!(minify(src), src);
    }

    #[test]
    fn entities_are_not_touched() {
        let src = "<a b=\"x &amp; y\"><t>1 &amp; 2 &lt; 3 &#169; &custom;</t></a>";
        assert_eq!(pretty(src), "<a b=\"x &amp; y\">\n  <t>1 &amp; 2 &lt; 3 &#169; &custom;</t>\n</a>");
    }

    #[test]
    fn minify_drops_whitespace_nodes() {
        let src = "<?xml version=\"1.0\"?>\n<a>\n  <b>\n    <c/>\n  </b>\n  <!-- k -->\n</a>\n";
        assert_eq!(minify(src), "<?xml version=\"1.0\"?><a><b><c/></b><!-- k --></a>");
    }

    #[test]
    fn multiple_top_level_elements() {
        assert_eq!(pretty("<a/><b><c/></b>"), "<a/>\n<b>\n  <c/>\n</b>");
    }

    #[test]
    fn mismatched_tag_error_has_position() {
        let e = run("<a>\n  <b></c>\n</a>", Mode::Pretty, Indent::Tab).unwrap_err();
        assert_eq!(e.kind, ErrorKind::Parse);
        assert_eq!((e.line, e.col), (Some(2), Some(6)));
        assert!(e.message.contains("</b>") && e.message.contains("</c>"), "{}", e.message);
    }

    #[test]
    fn unclosed_element_error_has_position() {
        let e = run("<a>\n  <b>\n</a", Mode::Minify, Indent::Tab).unwrap_err();
        assert_eq!(e.kind, ErrorKind::Parse);
        assert!(e.line.is_some() && e.col.is_some());
        let e = run("<a>\n  <b>text</b>\n", Mode::Pretty, Indent::Tab).unwrap_err();
        assert_eq!((e.kind, e.line, e.col), (ErrorKind::Parse, Some(1), Some(1)));
        assert!(e.message.contains("<a>"));
    }

    #[test]
    fn stray_end_tag_is_error() {
        let e = run("<a/></a>", Mode::Pretty, Indent::Tab).unwrap_err();
        assert_eq!((e.kind, e.line, e.col), (ErrorKind::Parse, Some(1), Some(5)));
    }
}
