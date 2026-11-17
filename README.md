# Cirth

A lightweight desktop text editor in the spirit of Sublime Text and Zed. It's built with Tauri 2 (Rust) and Svelte 5 + CodeMirror 6.

- Tabs and a folder sidebar: create, rename and delete files, copy an item's full path, with file watching. The sidebar stays hidden until a folder is open.
- "Open with Cirth" in the Windows Explorer menu for files, folders and folder backgrounds (on Windows 11 it's under "Show more options"). A second launch hands its files to the window that's already open.
- Syntax highlighting for about 100 languages.
- JSON and XML: format and minify, with errors shown at their line and column.
- Markdown: a live preview side by side or on its own, with synced scrolling, highlighted code blocks and local images.
- Command palette, quick open, and go to line. Find/replace across a folder uses the search box under the Explorer header: results take the tree's place until you clear it.
- Column (box) editing as in Visual Studio: Alt+drag, Shift+Alt+click, or Shift+Alt+arrow keys, then type on every line at once.
- Encoding (UTF-8, UTF-8 with BOM, UTF-16 LE/BE, legacy code pages) and line endings (LF/CRLF) are detected, kept on save, and switchable from the status bar.
- Files of 100 MB and more stay editable. At 10 MB and above (a setting), a file opens in **light mode**, with no highlighting, folding or wrapping.
- Light, dark or system theme.
- Updates itself: when a new release is out, the status bar shows "Update to X.Y.Z" (Help → Check for Updates checks now).

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
| Rename a sidebar item | `Alt`+click (or right-click → Rename) |
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

`npm run e2e` runs the real-app suite (13 scenarios). It starts Vite and launches the debug exe (`cargo build` first), then drives WebView2 over its remote-debugging port with `playwright-core` and checks the bytes on disk. The app runs on a hidden Windows desktop, so you can keep working while it runs; set `$env:SE_E2E_VISIBLE = '1'` to watch it. Set `SE_EXE` to an installed exe to test a release build instead. The native Open and Save dialogs aren't covered.

## Install

Download the `_x64-setup.exe` installer (per user, no admin rights) from the [latest release](https://github.com/sjhowie/cirth/releases/latest). From then on, Cirth offers its own updates.

## Release

`package.json` holds the version; `tauri.conf.json` reads it from there. On `dev`, with a clean tree:

```powershell
npm run release -- patch --push    # or minor, major, or an exact X.Y.Z
```

That bumps the version in `package.json`, `Cargo.toml` and the lock files, commits `Release vX.Y.Z`, tags it, fast-forwards `main`, and pushes `dev`, `main` and the tag. Without `--push` it stops after the tag and prints the push commands. The tag starts `.github/workflows/release.yml`, which builds the signed installers and `latest.json` on GitHub Actions (about 15 minutes) and publishes the release. The signing key's private half lives only on your machine (`%USERPROFILE%\.tauri\cirth.key`) and in the repository secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Losing it means installed copies can no longer update.

Build the installers locally (NSIS per-user `.exe` and `.msi`, written to `src-tauri/target/release/bundle/`; unsigned for the updater, which is fine for a local install):

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

- Box selection can't extend past the end of a short line (no virtual space; see Possible enhancements). Copy Line Up/Down have no shortcut because Shift+Alt+Up/Down select the box; they're in the command palette.
- UTF-16 files without a BOM aren't detected, and UTF-16 is always saved with a BOM.
- Folder search matches non-ASCII text only in UTF-8 and UTF-16 files.
- Only built and tested on Windows 11. The code avoids Windows-only APIs, but macOS and Linux builds haven't been tried.

## License

[MIT](LICENSE).

## Possible enhancements

- **Virtual space in box selection**, as in Visual Studio. Today, a box over a line shorter than its columns stops at that line's end, so typing lands at the end of the short line. With virtual space, typing would first pad short lines in the box with spaces up to the box's column, so the text lines up on every line. The box already remembers its virtual column (`boxField` in `src/lib/editor/columnSelect.ts`). The work is a transaction filter or input handler that pads before the edit, plus drawing the box past line ends, unit tests in `columnSelect.test.ts`, and an E2E check in `e2e/scenarios/13-column-edit.mjs`.
