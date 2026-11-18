# Cirth

The app was called SimpleEditor until 0.2.0 (identifier `com.simpleeditor.app`); `src-tauri/src/migrate.rs` carries settings over once. The repo folder may still be named `SimpleEditor`, and the WebView2 localStorage keys keep their `simpleeditor.` prefix on purpose (renaming them would drop users' recent files).

A lightweight desktop text editor: Tauri 2 (Rust) and Svelte 5 (runes, TypeScript) on Vite, with CodeMirror 6. There is no SvelteKit: `index.html` loads `src/main.ts`, which mounts `src/App.svelte`; `vite build` writes `dist/` for Tauri to bundle. `#lib/...` imports resolve through `package.json` `imports`. Windows is the only platform released and E2E-tested; `.github/workflows/ci.yml` builds and unit-tests Linux and macOS on pushes to `dev`, so code under `cfg(not(windows))` must pass clippy there. Keep the code portable: no Windows-only APIs outside the installer files, and use `Mod` keybindings. [README.md](README.md) covers features, shortcuts and the file layout. This file covers how to work on the code.

**Out of scope on purpose:** compiling, debugging, extensions and session restore. Don't add them unless asked.

## Commands (pwsh, from the repo root)

```powershell
npx vitest run                                    # frontend unit tests
npm run check                                     # svelte-check: must be 0 errors, 0 warnings
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo build --manifest-path src-tauri/Cargo.toml  # debug exe; npm run e2e needs it first
npm run e2e                                       # all real-app scenarios; `npm run e2e -- 13` runs one
npm run tauri build                               # release exe + NSIS installer in src-tauri/target/release/bundle/
npm run release -- patch [--push]                 # needs CHANGELOG "## Unreleased" items; bump, stamp the changelog, commit, tag vX.Y.Z on dev; --push publishes (see README, Release)
```

A change is done when vitest, check, cargo test and clippy pass, plus E2E for anything touching UI, IPC or the installers. Unit tests mock IPC, and they have missed real bugs before.

## Where things live

- **`docs/ipc.md`** is the Rust ⇄ frontend contract: every command, event, payload and error kind. Change it in the same commit as any signature. If it disagrees with the code, the code wins; fix the doc.
- **`docs/decisions/`** holds historical rationale, such as the big-file measurements behind the 10 MB light-mode threshold.
- **`CHANGELOG.md`** feeds Help > What's New (parsed by `src/lib/changelog.ts`) and the release notes. Keep its format exactly: `## Unreleased` or `## X.Y.Z - YYYY-MM-DD`, then `### New` / `### Improved` / `### Fixed` with one-line `- ` items in past tense.
- **`src-tauri/src/`** has one module per IPC area: `files`, `upload`, `format_json`, `format_xml`, `tree`, `search`, `watch`, `settings`, `migrate`, `error`. `lib.rs` registers the commands and plugins.
- **`src/lib/`** holds the frontend:
  - Commands: register through `commands.ts` and `appCommands.ts`. Commands with `keys` win over CodeMirror keymaps, through the capture-phase handler in `keys.svelte.ts`.
  - Editor: `editorHost.svelte.ts` keeps one EditorView, with one EditorState per tab swapped in. `editor/` has languages, light/full mode (`largeFile.ts`) and box selection (`columnSelect.ts`).
  - Features: `markdown/`, `palette/`, `search/`, and updates (`updater.svelte.ts`).
- **`src-tauri/windows/`** holds the installer hooks: `hooks.nsh` adds the per-user "Open with Cirth" menu to the NSIS installer (wired in `tauri.conf.json`). NSIS is the only bundle target: an MSI would self-update through the per-user NSIS installer and leave two installs. The folder-background verb passes `%V.` (not `%V`) so a drive root doesn't end in `\"`.
- **CSP** is set in `tauri.conf.json` and meant for built apps; in `tauri dev` the page comes from Vite, which sends no CSP, so only a release build (`SE_EXE`) proves it. `dangerousDisableAssetCspModification: ["style-src"]` stops Tauri adding a nonce to `style-src`, which would make browsers ignore its `'unsafe-inline'` (CodeMirror injects styles). New remote hosts need a CSP edit; remote images in the Markdown preview are blocked on purpose.
- **`scripts/changelog-notes.mjs`** holds the changelog functions shared by `release.mjs` and the release workflow (notes for a version, Unreleased check and rename).

## Traps already paid for

- **WebView2 kills the page on a request body over about 110 MB.** It throws no error, and unsaved state is lost. Send large bodies through the chunked upload in `ipc.ts` (`callRawChunked`), not one `invoke`. Responses of any size are fine.
- **`encoding_rs` silently writes UTF-8 when asked for UTF-16.** UTF-16 is encoded by hand (`encode_utf16` in `files.rs`). Unmappable characters are an error, never `&#NNN;`.
- **Single instance:** a second launch's paths are queued in Rust until the frontend calls `get_startup_paths`. The frontend must await its `app://open-paths` listener before making that call. Emitting straight away loses files when Explorer opens several at once.
- **Tauri's native drag-drop swallows every drop on Windows**, text included, so `dragDropEnabled` is off in `tauri.conf.json`. The WebView then handles drops itself; `main.ts` cancels file drops, or the page would navigate to the dropped file. CDP-driven E2E drags bypass the OS, so they can't catch this. Dragging between tabs is in `editor/tabDrag.ts`: CodeMirror keeps drag state on the view, not the state, so `activateTabWhileDragging` ends it before swapping documents.
- **Typing stalls at 20 MB in full mode** (p95 122 ms). Light mode starts at 10 MB and drops highlighting, folding and wrap. Keep new per-keystroke work out of light mode.
- **The JSON formatter keeps the original number text, key order and duplicate keys.** Don't swap in `serde_json::Value`.
- **Updates are signed.** `plugins.updater.pubkey` in `tauri.conf.json` must match the private key in the repo secrets; installed copies only accept installers signed with it. Never change the pubkey, the identifier or the updater endpoint casually: installed copies would stop updating. Updater artifacts are built only in CI (`tauri.updater.conf.json`), so local builds need no key.
- **Version lives in `package.json` only** (`tauri.conf.json` points at it). `npm run release` keeps `Cargo.toml`/`Cargo.lock` in step; don't bump by hand.

## E2E (`e2e/`)

- Launches the real exe with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`, then drives it with `playwright-core` over CDP and checks the bytes on disk.
- The app runs on a hidden Windows desktop (`e2e/deskrun.cs`, compiled on first use into `e2e/.bin/`), so test windows never appear on screen or take focus. CDP input needs no OS focus. A test that closes the window must go through `closeMainWindow` (it finds windows on that desktop); spawn extra app processes with `spawnExe`. Set `$env:SE_E2E_VISIBLE = '1'` to watch the windows while debugging. deskrun puts the app in a kill-on-close job; set `DESKRUN_NO_JOB=1` when the app must outlive it (a self-update test: the app exits and its installer keeps running).
- The debug exe needs Vite on port 1420, which the runner starts. Set `SE_EXE` to an installed exe to test a release build without Vite.
- **One E2E run at a time:** ports 9222 and 1420 are shared. Don't run E2E or `tauri dev` while another agent is building or testing on this machine. `launchApp` fails fast if anything already answers on the CDP port.
- **Isolation:** every launch gets `CIRTH_CONFIG_DIR` (a per-run temp folder holding `settings.json`; `SETTINGS_FILE` in `lib.mjs`) and a per-run WebView2 profile, both deleted by `cleanupRun()` at the end. The user's real settings are never touched. Use `isolatedEnv()` for any extra process you spawn.
- **Skips:** `t.skip(reason)` ends a scenario as `SKIP <name> (<reason>)`. The summary reads like `13/14 passed, 1 skipped`; skips don't change the exit code.
- Launches set `CIRTH_MULTI_INSTANCE=1`, so the single-instance plugin can't hand a test launch to a Cirth the user has open. Scenario 12 runs without it, and skips if any `cirth.exe` is running. Launches also set `CIRTH_NO_UPDATE_CHECK=1` (no GitHub calls) and `WEBVIEW2_USER_DATA_FOLDER` to a temp folder: an open Cirth holds the default WebView2 profile, and a second process on it with other browser arguments fails with 0x8007139F.
- The native Open and Save dialogs can't be automated. Pass files and folders as startup arguments.
- In page code, find the editor view from `.cm-content` (`cmTile` or `cmView`). Take screen points from `view.coordsAtPos`, not from the `.cm-line` box, which includes padding.

## Conventions

- **Files are CRLF** (`core.autocrlf=true`). Edit them with editor tools, not `sed` or heredocs.
- **Svelte 5 runes.** Stores are classes with `$state` fields in `*.svelte.ts` files.
- **Errors are explicit and logged.** On the frontend, use `reportError` / `notifyError`. In Rust, return `AppError` and call `log::error!`.
- **Git:** work on `dev`. Move `main` forward only when Steve asks; it is always a fast-forward of `dev`. The remote is `origin`, Steve's public GitHub repo (`sjhowie/cirth`, MIT-licensed, reached as the `sjhowie` account). Push and release only when Steve asks; a pushed `v*` tag publishes a release that every installed copy is offered.
