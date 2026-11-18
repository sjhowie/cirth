# Cirth

A lightweight desktop text editor in the spirit of Sublime Text and Zed. It's built with Tauri 2 (Rust) and Svelte 5 + CodeMirror 6.

- Tabs and a folder sidebar: create, rename and delete files, copy an item's full path, with file watching. The sidebar stays hidden until a folder is open.
- "Open with Cirth" in the Windows Explorer menu for files, folders and folder backgrounds (on Windows 11 it's under "Show more options"). A second launch hands its files to the window that's already open.
- Syntax highlighting for about 100 languages.
- JSON and XML: format and minify, with errors shown at their line and column.
- Markdown: a live preview side by side or on its own, with synced scrolling, highlighted code blocks and local images.
- Command palette, quick open, and go to line. Find/replace across a folder uses the search box under the Explorer header: results take the tree's place until you clear it.
- Drag selected text to move it (hold Ctrl to copy), including onto another tab: rest on the tab and it opens. Drop files or folders on the window to open them.
- Column (box) editing as in Visual Studio: Alt+drag, Shift+Alt+click, or Shift+Alt+arrow keys, then type on every line at once.
- Encoding (UTF-8, UTF-8 with BOM, UTF-16 LE/BE, legacy code pages) and line endings (LF/CRLF) are detected, kept on save, and switchable from the status bar.
- Files of 100 MB and more stay editable. At 10 MB and above (a setting), a file opens in **light mode**, with no highlighting, folding or wrapping.
- Light, dark or system theme.
- Updates itself: when a new release is out, the status bar shows "Update to X.Y.Z" (Help → Check for Updates checks now). Help → What's New shows the release notes from [CHANGELOG.md](CHANGELOG.md), and opens once after an update.

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

`npm run e2e` runs the real-app suite (16 scenarios). It starts Vite and launches the debug exe (`cargo build` first), then drives WebView2 over its remote-debugging port with `playwright-core` and checks the bytes on disk. The app runs on a hidden Windows desktop, so you can keep working while it runs; set `$env:SE_E2E_VISIBLE = '1'` to watch it. Set `SE_EXE` to an installed exe to test a release build instead. The native Open and Save dialogs aren't covered. The suite never touches your real settings or WebView2 profile: each run points the app at a temp folder (`CIRTH_CONFIG_DIR`) and deletes it at the end. A scenario that can't run (for example the single-instance one while a Cirth is open) is reported as `SKIP`, not as passed.

## Install

Download the `_x64-setup.exe` installer (per user, no admin rights) from the [latest release](https://github.com/sjhowie/cirth/releases/latest). From then on, Cirth offers its own updates.

## Release

`package.json` holds the version; `tauri.conf.json` reads it from there. Write the release notes first: [CHANGELOG.md](CHANGELOG.md) needs a `## Unreleased` section with at least one item, or the release refuses to start. On `dev`, with a clean tree:

```powershell
npm run release -- patch --push    # or minor, major, or an exact X.Y.Z
```

Before it changes anything it checks that you're on `dev` with a clean tree, that `dev` isn't behind `origin/dev`, that `origin/main` is an ancestor of `dev` (so `main` can fast-forward), and that the changelog has Unreleased items. Then it bumps the version in `package.json`, `Cargo.toml` and the lock files, renames `## Unreleased` to `## X.Y.Z - <today>`, commits `Release vX.Y.Z`, tags it, and with `--push` pushes `dev` and `main` together (`git push --atomic`) and then the tag. Without `--push` it stops after the tag and prints the push commands. If a step fails after the commit exists, it prints the exact commands to retry or undo. The tag starts `.github/workflows/release.yml`. It first checks the tag against `package.json`, then runs vitest, `npm run check` and `cargo test`, and only then builds the signed NSIS installer and `latest.json` on GitHub Actions (about 15 minutes) and publishes the release, with the changelog entry as its notes. The workflow's actions are pinned to commit SHAs.

Only the NSIS installer is built: an MSI would install separately from the per-user NSIS one and then self-update into a second install. The signing key's private half lives only on your machine (`%USERPROFILE%\.tauri\cirth.key`) and in the repository secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Losing it means installed copies can no longer update.

Build the installer locally (the NSIS per-user `.exe`, written to `src-tauri/target/release/bundle/`; unsigned for the updater, which is fine for a local install):

```powershell
npm run tauri build
```

## Layout

| Path | What |
|---|---|
| `src-tauri/src/` | Rust: file I/O and encodings (`files.rs`), formatters (`format_json.rs`, `format_xml.rs`), tree, folder search, watcher, settings, chunked uploads |
| `index.html`, `src/main.ts`, `src/App.svelte` | Frontend entry: the page, the mount, and the app shell (Svelte on Vite, no SvelteKit) |
| `src/lib/` | Frontend: tabs and editor host, command registry and keys, explorer, palette, search, Markdown preview |
| `docs/ipc.md` | The Rust ⇄ frontend contract: every command and event. Change it in the same commit as any signature |
| `docs/decisions/` | Why things are the way they are (for example the big-file measurements behind the 10 MB threshold) |
| `e2e/` | The real-app test suite |

## Known limits

- Box selection can't extend past the end of a short line (no virtual space; see Possible enhancements). Copy Line Up/Down have no shortcut because Shift+Alt+Up/Down select the box; they're in the command palette.
- UTF-16 files without a BOM aren't detected, and UTF-16 is always saved with a BOM.
- Folder search matches non-ASCII text only in UTF-8 and UTF-16 files.
- Released and tested on Windows 11 only. CI (`.github/workflows/ci.yml`) builds Linux (AppImage, .deb) and macOS (.dmg) on every push to `dev` and runs the unit tests there, with the bundles as run artifacts; they aren't released, signed or covered by E2E.

## License

[MIT](LICENSE).

## Possible enhancements

- **Virtual space in box selection**, as in Visual Studio. Today, a box over a line shorter than its columns stops at that line's end, so typing lands at the end of the short line. With virtual space, typing would first pad short lines in the box with spaces up to the box's column, so the text lines up on every line. The box already remembers its virtual column (`boxField` in `src/lib/editor/columnSelect.ts`). The work is a transaction filter or input handler that pads before the edit, plus drawing the box past line ends, unit tests in `columnSelect.test.ts`, and an E2E check in `e2e/scenarios/13-column-edit.mjs`.
