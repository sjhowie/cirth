# SimpleEditor

A lightweight desktop text editor in the spirit of Sublime Text and Zed. It's built with Tauri 2 (Rust) and Svelte 5 + CodeMirror 6.

- Tabs and a folder sidebar: create, rename and delete files, with file watching.
- Syntax highlighting for about 100 languages.
- JSON and XML: format and minify, with errors shown at their line and column.
- Markdown: a live preview side by side or on its own, with synced scrolling, highlighted code blocks and local images.
- Command palette, quick open, go to line, and find/replace across a folder.
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
| Find in folder | `Ctrl+Shift+F` |
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

`npm run e2e` runs the real-app suite (11 scenarios). It starts Vite and launches the debug exe (`cargo build` first), then drives WebView2 over its remote-debugging port with `playwright-core` and checks the bytes on disk. Set `SE_EXE` to an installed exe to test a release build instead. The native Open and Save dialogs aren't covered.

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

- UTF-16 files without a BOM aren't detected, and UTF-16 is always saved with a BOM.
- Folder search matches non-ASCII text only in UTF-8 and UTF-16 files.
- Only built and tested on Windows 11. The code avoids Windows-only APIs, but macOS and Linux builds haven't been tried.
