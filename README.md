# SimpleEditor

A lightweight desktop text editor in the spirit of Sublime Text and Zed. It's built with Tauri 2 (Rust) and Svelte 5 + CodeMirror 6.

- Tabs and a folder sidebar: create, rename and delete files, with file watching. The sidebar stays hidden until a folder is open.
- "Open with SimpleEditor" in the Windows Explorer menu for files, folders and folder backgrounds (on Windows 11 it's under "Show more options"). A second launch hands its files to the window that's already open.
- Syntax highlighting for about 100 languages.
- JSON and XML: format and minify, with errors shown at their line and column.
- Markdown: a live preview side by side or on its own, with synced scrolling, highlighted code blocks and local images.
- Command palette, quick open, and go to line. Find/replace across a folder uses the search box under the Explorer header: results take the tree's place until you clear it.
- Column (box) editing as in Visual Studio: Alt+drag, Shift+Alt+click, or Shift+Alt+arrow keys, then type on every line at once.
- Encoding (UTF-8, UTF-8 with BOM, UTF-16 LE/BE, legacy code pages) and line endings (LF/CRLF) are detected, kept on save, and switchable from the status bar.
- Files of 100 MB and more stay editable. At 10 MB and above (a setting), a file opens in **light mode**, with no highlighting, folding or wrapping.
- Light, dark or system theme.

No compiling, debugging or extensions; that's on purpose.

## Keyboard shortcuts

`Ctrl` is `⌘` on macOS.

| Action | Keys |
|---|---|
| New / Open file / Open folder | `Ctrl+N` / `Ctrl+O` / `Ctrl+K Ctrl+O` |
| Save / Save As / Save All | `Ctrl+S` / `Ctrl+Shift+S` / `Ctrl+Alt+S` |
| Close tab | `Ctrl+W` |
| Command palette / Go to file | `Ctrl+Shift+P` / `Ctrl+P` (type `:120` to jump to a line) |
| Find / Replace in file | `Ctrl+F` / `Ctrl+H` |
| Find in folder | `Ctrl+Shift+F` (Esc in the search box brings the tree back) |
| Box selection | `Alt`+drag, `Shift+Alt`+click, `Shift+Alt+Arrows` / `Home` / `End` / `PgUp` / `PgDn` |
| Format document / Minify (JSON, XML) | `Shift+Alt+F` / `Ctrl+Alt+M` |
| Markdown preview: toggle / side by side | `Ctrl+Shift+V` / `Ctrl+K V` |
| Toggle sidebar / Word wrap / Settings | `Ctrl+B` / `Alt+Z` / `Ctrl+,` |

## Develop

You need Rust (stable), Node 20 or later, and on Windows the Visual Studio C++ build tools and WebView2. The commands below are PowerShell, run from the repo root.

```powershell
npm install
npm run tauri dev
```

Tests and checks:

```powershell
npx vitest run
npm run check
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

`npm run e2e` runs the real-app suite (13 scenarios). It starts Vite and launches the debug exe (`cargo build` first), then drives WebView2 over its remote-debugging port with `playwright-core` and checks the bytes on disk. Set `SE_EXE` to an installed exe to test a release build instead. The native Open and Save dialogs aren't covered.

Build the installers (NSIS per-user `.exe` and `.msi`, written to `src-tauri/target/release/bundle/`):

```powershell
npm run tauri build
```

## Layout

| Path | What |
|---|---|
| `src-tauri/src/` | Rust: file I/O and encodings (`files.rs`), formatters (`format_json.rs`, `format_xml.rs`), tree, folder search, watcher, settings, chunked uploads |
| `src/lib/` | Frontend: tabs and editor host, command registry and keys, explorer, palette, search, Markdown preview |
| `docs/ipc.md` | The Rust ⇄ frontend contract: every command and event. Change it in the same commit as any signature |
| `docs/decisions/` | Why things are the way they are (for example the big-file measurements behind the 10 MB threshold) |
| `e2e/` | The real-app test suite |

## Known limits

- Box selection can't extend past the end of a short line (no virtual space), and Copy Line Up/Down have no shortcut because Shift+Alt+Up/Down select the box. They're in the command palette.
- UTF-16 files without a BOM aren't detected, and UTF-16 is always saved with a BOM.
- Folder search matches non-ASCII text only in UTF-8 and UTF-16 files.
- Only built and tested on Windows 11. The code avoids Windows-only APIs, but macOS and Linux builds haven't been tried.
