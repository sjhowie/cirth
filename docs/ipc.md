# IPC contract (Rust ⇄ frontend)

Single source of truth for every Tauri command and event. Rust lives in `src-tauri/src/`, the
frontend wrapper in `src/lib/ipc.ts`. Change this file in the same commit as any signature change.

## Conventions
- Command names are snake_case; JSON args are camelCase (Tauri 2 default).
- **Large text never crosses IPC as a JSON string.** Commands marked *raw* take/return bytes:
  - Raw request: frontend calls `invoke(cmd, uint8Array, { headers })`; Rust takes
    `request: tauri::ipc::Request` and reads `InvokeBody::Raw` + headers.
  - Raw response: Rust returns `tauri::ipc::Response::new(Vec<u8>)`; frontend receives `ArrayBuffer`.
  - Header values are ASCII; paths go in headers `encodeURIComponent`-encoded and are
    percent-decoded in Rust.
- Errors: every command returns `Result<_, AppError>`; `AppError` serializes to
  `{ "kind": string, "message": string, "line"?: number, "col"?: number }`.
  `kind` ∈ `io | encoding | parse | notFound | invalidArg | cancelled`. `line`/`col` are 1-based.

## Chunked uploads (large raw requests)
WebView2 kills the page when one request body passes ~110 MB (measured: 100 MB OK, 120 MB crash,
also for a plain `fetch`). Raw *responses* are not affected. So any raw request body larger than
`CHUNK_BYTES` (32 MiB) is staged first:

| Command | Kind | Input | Output |
|---|---|---|---|
| `upload_begin` | JSON | `{}` | `{ uploadId: string }` |
| `upload_chunk` | raw request | body = next chunk; header `x-upload-id` | `()` |
| `upload_discard` | JSON | `{ uploadId }` | `()` — idempotent |

- Any raw-request command (`write_file`, `format_json`, `format_xml`) accepts header
  `x-upload-id` with an empty body instead of an inline body; the staged bytes are concatenated in
  order, consumed and freed by that call (success or error). Unknown id → `invalidArg`.
- Chunks are cut on UTF-8 boundaries by the frontend (encode the string in slices that never split a
  surrogate pair), so no slice needs a full-document copy. Rust treats the concatenation as bytes.
- A staged upload idle for 10 minutes (no chunk added, not consumed) is dropped. The sweep runs on
  every `upload_begin`, `upload_chunk` and consuming call, so a stale upload never sits in memory
  for the rest of the session. Frontend calls `upload_discard` on any failure between begin and the
  consuming call.

## Files
| Command | Kind | Input | Output |
|---|---|---|---|
| `read_file` | raw response | `{ path }` | `[u32 LE metaLen][meta JSON, UTF-8][text, UTF-8]` |
| `write_file` | raw request | body = text as UTF-8 with `\n` line breaks; headers `x-path`, `x-encoding`, `x-bom` (`1`/`0`), `x-eol` (`lf`/`crlf`/`cr`) | `{ size: number }` |

`meta` = `{ encoding: string, bom: boolean, eol: "lf" | "crlf" | "cr", size: number, lossy: boolean }`
- `encoding`: `utf-8`, `utf-16le`, `utf-16be`, or an `encoding_rs` label (e.g. `windows-1252`).
  Detection: BOM first, else valid UTF-8 → `utf-8`, else `chardetng`.
- `eol`: style of the first line break (`cr` = a lone `\r`, classic Mac OS); `lf` if none. Text is
  returned as-is (CodeMirror normalizes).
- `lossy` (always present): some bytes were not valid in `encoding` (a BOM'd file with invalid
  UTF-8, odd-length or lone-surrogate UTF-16, invalid sequences in a detected legacy encoding) and
  were decoded as U+FFFD. Saving the text writes U+FFFD in their place, so the frontend warns and
  asks before saving a lossy tab.
- `write_file` converts `\n` to the requested EOL, encodes, prepends a BOM if `x-bom=1`, and saves:
  - A symlink is followed: its target is written and the link stays a link.
  - A new file: temp file in the same folder, then rename.
  - An existing file on Windows: temp file in the same folder, then `ReplaceFileW`, which keeps the
    file's ACLs, attributes (hidden, system), creation time and alternate data streams (e.g.
    `Zone.Identifier`). A file with more than one hard link is written in place (open, write,
    truncate, sync) so the links stay joined. When the replace is refused (access denied, or the file
    is open in another process without delete sharing) it is also written in place, with a logged
    warning. In-place writes are not atomic.
  - An existing file elsewhere: temp file given the original permissions, then rename.
  - Read-only files and folders → `io` error, file untouched.
  Characters the target encoding cannot represent → `AppError{kind:"encoding"}`; never write
  numeric character references. The work runs on a blocking thread, not an async worker.

## Formatting
| Command | Kind | Input | Output |
|---|---|---|---|
| `format_json` | raw request + raw response | body = text; headers `x-mode` (`pretty`/`minify`), `x-indent` (`2`/`4`/`tab`) | text (UTF-8) |
| `format_xml` | raw request + raw response | same as `format_json` | text (UTF-8) |

Invalid input → `AppError{kind:"parse", message, line, col}`; output is never partial.

## Folder tree and file operations
| Command | Input | Output |
|---|---|---|
| `list_dir` | `{ path }` | `[{ name, path, isDir }]` — folders first, then case-insensitive name; skips `.git` |
| `list_files` | `{ root }` | `{ files: string[], truncated: boolean }` — root-relative, `/`-separated, honours `.gitignore`, cap 50 000 |
| `create_file` | `{ path }` | `()` — fails if it exists |
| `create_dir` | `{ path }` | `()` |
| `rename_path` | `{ from, to }` | `()` — fails (`io`, "already exists") if `to` is another existing file or folder; never replaces it (Windows: `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING`, so the check is atomic; elsewhere a check then rename). A case-only rename (`foo.txt` → `Foo.txt`, same file) is allowed |
| `trash_path` | `{ path }` | `()` — OS recycle bin (`trash` crate) |
| `get_startup_paths` | `{}` | `string[]` — existing command-line paths, absolute (relative ones resolved against the working directory), followed by paths queued by second launches that arrived early. Empty arguments are skipped; `C:\.` / `D:\dir\.` / `D:\dir.` resolve to `C:\` / `D:\dir`. Also the frontend's "ready" signal: call it once, after subscribing to `app://open-paths` |

## Watching
| Command | Input | Output |
|---|---|---|
| `watch_paths` | `{ paths: string[] }` | `()` — replaces the watched set (open folder recursive, open files non-recursive) |

Event `fs://changed` payload `{ paths: string[] }` (absolute), debounced 200 ms. The frontend
decides what changed by re-reading (`list_dir` / `read_file`).

## Single instance and `app://open-paths`
Desktop builds register `tauri-plugin-single-instance` as the first plugin. A second launch (Explorer
"Open with Cirth", or a command line) does not start a window: it hands its argv to the running
instance and exits.
- Rust resolves the second process's arguments against *its* working directory and keeps only existing
  paths (`tree::startup_paths_from(args, base)`, the same function `get_startup_paths` uses with the
  current directory), then emits event `app://open-paths` payload `{ paths: string[] }` (absolute,
  no `\\?\` prefix) to the `main` window, calls `unminimize()` and `set_focus()` on it.
- Race: a second launch can arrive while the first window is still loading. Until the frontend calls
  `get_startup_paths` (after it has subscribed), `OpenPathsState` queues the paths instead of emitting;
  that call drains the queue into its result and flips the state to "ready", after which paths are
  emitted directly. Each path is delivered exactly once.
- Frontend (`openStartupPaths` in `src/lib/files.ts`) subscribes once and calls `openPaths(paths)`:
  folders become the explorer root, files become tabs, exactly as for startup paths.
- Opt-out: environment variable `CIRTH_MULTI_INSTANCE=1` skips the plugin, so several
  instances can run side by side. The E2E launcher sets it, except scenario `12-single-instance`.
- Installers add an Explorer context-menu entry "Open with Cirth" (files, folders, folder
  background) that runs `cirth.exe "%1"` (`"%V."` for the background, so a drive root arrives as `C:\.`
  rather than `C:\"`, which the quoting would break): the NSIS installer (the only bundle target) writes
  them per user under `HKCU\Software\Classes` (see `src-tauri/windows/hooks.nsh`).

## Folder search / replace
| Command | Input | Output |
|---|---|---|
| `search_folder` | `{ searchId, root, query, regex, caseSensitive, wholeWord, include, exclude }` | `()` — results stream as events |
| `cancel_search` | `{ searchId }` | `()` |
| `replace_in_folder` | `{ root, query, replacement, regex, caseSensitive, wholeWord, paths: string[] }` | `{ filesChanged, replacements }` |

- `include` / `exclude`: comma-separated globs (may be empty). Honours `.gitignore`; skips binary files.
- Event `search://result` `{ searchId, path, items: [{ line, col, preview, matchLen }] }`, one
  event per file with matches (`col` 1-based char column of the match within `preview`; `preview`
  is the trimmed line, max 300 chars, windowed around the match).
- Event `search://done` `{ searchId, files, matches, truncated, cancelled }`; cap 10 000 matches.
- `replace_in_folder` touches only `paths`, re-reads each with `read_file` semantics and writes back
  with its original encoding/BOM/EOL. With `regex`, `$1` etc. expand in `replacement`.
- Replace runs the pattern line by line, on the same units the search matches: each line without
  its terminator (`\n` or `\r\n`; `\r` in `cr` files). Terminators are kept byte for byte, so a
  pattern such as `\s+$` never joins lines, and the counts agree with the search results.
- A file with matches whose read was `lossy` is not rewritten: `encoding` error "<path>: contains
  bytes that are not valid <encoding>; open and save it in the editor instead".
- `wholeWord` wraps the pattern in `\b{start-half}…\b{end-half}`: no word character just before or
  just after the match, so queries with non-word edges work (`foo(` matches in `x foo( y`, not in
  `xfoo( y`).
- Cancel is checked before every read of a file, not only at matches and between files.

## Behaviour notes (as implemented)
- Missing headers: `x-encoding` → `utf-8`, `x-bom` → `0`, `x-eol` → `lf`, `x-mode` → `pretty`,
  `x-indent` → `2`. Bad values → `invalidArg`. A leading BOM in format input is dropped.
- Error positions: unterminated JSON string → its opening quote; unclosed XML element → its start
  tag; mismatched end tag → that tag.
- Encoding detection sees the first 1 MiB; UTF-16 without a BOM is not detected.
- XML: whitespace-only content of an otherwise empty element is dropped (`<a> </a>` → `<a></a>`);
  CDATA counts as text for mixed-content detection; no DTD/entity validation.
- XML: whitespace-only text between elements is treated as insignificant, as XML pretty-printers do,
  even between inline siblings: minify turns `<p><b>x</b> <i>y</i></p>` into
  `<p><b>x</b><i>y</i></p>`. An element with non-whitespace text of its own (`<p>a <b>x</b> <i>y</i></p>`)
  is copied verbatim. Use `xml:space="preserve"` to keep the whitespace.
- XML errors (`parse`, with line:col): malformed attributes (`<a b=1/>`), duplicate attributes
  (`<a b="1" b="2"/>`), and bad entity syntax in text or attribute values (a bare `&`, a missing
  `;`, a bad character reference). Unknown named entities (`&custom;`) are accepted, since a DTD may
  declare them.
- Search: empty query → `invalidArg`; bad regex or missing root fails synchronously; regexes that
  can only match across a newline → `parse`; legacy-encoded (non-UTF-8/16) files are searched as raw
  bytes, so non-ASCII queries won't match them; `include` is a filter that never un-ignores
  `.gitignore`d files.
- `replace_in_folder`: `root` unused; stops at the first file error, including a lossy file
  (earlier files stay written); keeps each file's EOLs.
- `watch_paths`: unwatchable paths are logged and skipped. `cancelled` errors are never returned;
  cancellation shows in `search://done`.

## Settings
| Command | Input | Output |
|---|---|---|
| `load_settings` | `{}` | `Settings` (see loading rules below) |
| `save_settings` | `{ settings }` | `()` |

`Settings` = `{ theme: "system"|"light"|"dark", fontFamily: string, fontSize: number,
indent: "2"|"4"|"tab", largeFileThresholdMb: number, wordWrap: boolean }`
Defaults: `system`, `"Cascadia Code, Consolas, Menlo, monospace"`, `14`, `"2"`, `10`, `false` (10 MB per `docs/decisions/big-file-spike.md`).
Stored as `settings.json` in the Tauri app config dir (`%APPDATA%\io.github.sjhowie.cirth` on Windows). On the first
start after the rename from SimpleEditor, `migrate.rs` copies `settings.json` and the WebView2 Local Storage from the old
`com.simpleeditor.app` folders, once, and leaves the old folders alone.

- Override: when the environment variable `CIRTH_CONFIG_DIR` is set and non-empty, `settings.json` lives in that folder
  instead (E2E isolation), and the `migrate.rs` carry-over is skipped entirely.
- Loading: a missing file gives the defaults. Each field is read on its own: a missing field takes its default, and an
  invalid value (`"theme":"Dark"`, `"indent":3`, `"fontSize":"14"`) takes its default and is logged, without resetting the
  other fields. A file that is not a JSON object (not JSON at all, or e.g. `[1]`) gives all defaults and is logged; load
  never writes it.
- Saving: if the existing file is not a JSON object, it is first copied to `settings.json.bad` (replacing an older copy),
  then overwritten. Fields that were invalid are saved with their defaults.

**Startup theme (no white flash).** Rust creates the main window itself (`"create": false` in `tauri.conf.json`). It loads the
settings first, builds the window hidden, sets the window and WebView2 background to the theme's editor color (`#282c34`
dark, `#ffffff` light; "system" asks the OS), then shows it. An initialization script sets `window.__CIRTH_THEME__`
to the `theme` setting before any page script runs. `app.html` uses it to set `data-theme` before first paint, and
`settings.svelte.ts` uses it as the initial `settings.theme`. After a theme change the frontend calls
`setBackgroundColor` on the webview window (capabilities `core:window:allow-set-background-color` and
`core:webview:allow-set-webview-background-color`).

## Updates

No custom commands: the frontend (`updater.svelte.ts`) uses `tauri-plugin-updater` (`check`, then `download` and `install`
as separate steps) and `tauri-plugin-process` (`relaunch`), with capabilities `updater:default` and `process:allow-restart`.

- Install order: the user confirms, the update downloads (progress in the status bar), then the unsaved-files prompt
  runs, settings are flushed, and only then `install` starts the installer. Cancelling the unsaved-files prompt keeps the
  download and the status-bar offer, so a later click installs without downloading again.

- Endpoint: `https://github.com/sjhowie/cirth/releases/latest/download/latest.json`, written by the release workflow
  (`.github/workflows/release.yml`). Installers are verified against `plugins.updater.pubkey` in `tauri.conf.json`.
- Windows installs run the NSIS installer in passive mode; it closes Cirth and reopens it.
- Release builds check 5 s after startup and every 6 hours. Dev builds never check. The initialization script sets
  `window.__CIRTH_UPDATE_CHECK__ = false` when the environment variable `CIRTH_NO_UPDATE_CHECK=1` is set (E2E sets it).
- Background check failures are logged with `console.warn` only (offline is normal); Help → Check for Updates reports them.
