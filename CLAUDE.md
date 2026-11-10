# SimpleEditor

A lightweight desktop text editor: Tauri 2 (Rust) and SvelteKit (Svelte 5 runes, TypeScript) with CodeMirror 6. Windows is the only platform built and tested. Keep the code portable: no Windows-only APIs outside the installer files, and use `Mod` keybindings. [README.md](README.md) covers features, shortcuts and the file layout. This file covers how to work on the code.

**Out of scope on purpose:** compiling, debugging, extensions and session restore. Don't add them unless asked.

## Commands (pwsh, from the repo root)

```powershell
npx vitest run                                    # frontend unit tests
npm run check                                     # svelte-check: must be 0 errors, 0 warnings
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo build --manifest-path src-tauri/Cargo.toml  # debug exe; npm run e2e needs it first
npm run e2e                                       # all real-app scenarios; `npm run e2e -- 13` runs one
npm run tauri build                               # release exe + NSIS + MSI in src-tauri/target/release/bundle/
```

A change is done when vitest, check, cargo test and clippy pass, plus E2E for anything touching UI, IPC or the installers. Unit tests mock IPC, and they have missed real bugs before.

## Where things live

- **`docs/ipc.md`** is the Rust ⇄ frontend contract: every command, event, payload and error kind. Change it in the same commit as any signature. If it disagrees with the code, the code wins; fix the doc.
- **`docs/decisions/`** holds historical rationale, such as the big-file measurements behind the 10 MB light-mode threshold.
- **`src-tauri/src/`** has one module per IPC area: `files`, `upload`, `format_json`, `format_xml`, `tree`, `search`, `watch`, `settings`, `error`. `lib.rs` registers the commands and plugins.
- **`src/lib/`** holds the frontend:
  - Commands: register through `commands.ts` and `appCommands.ts`. Commands with `keys` win over CodeMirror keymaps, through the capture-phase handler in `keys.svelte.ts`.
  - Editor: `editorHost.svelte.ts` keeps one EditorView, with one EditorState per tab swapped in. `editor/` has languages, light/full mode (`largeFile.ts`) and box selection (`columnSelect.ts`).
  - Features: `markdown/`, `palette/`, `search/`.
- **`src-tauri/windows/`** holds the installer hooks: `hooks.nsh` adds the per-user "Open with SimpleEditor" menu to the NSIS installer, and `explorer-menu.wxs` adds the same menu to the MSI. Both are wired in `tauri.conf.json`.

## Traps already paid for

- **WebView2 kills the page on a request body over about 110 MB.** It throws no error, and unsaved state is lost. Send large bodies through the chunked upload in `ipc.ts` (`callRawChunked`), not one `invoke`. Responses of any size are fine.
- **`encoding_rs` silently writes UTF-8 when asked for UTF-16.** UTF-16 is encoded by hand (`encode_utf16` in `files.rs`). Unmappable characters are an error, never `&#NNN;`.
- **Single instance:** a second launch's paths are queued in Rust until the frontend calls `get_startup_paths`. The frontend must await its `app://open-paths` listener before making that call. Emitting straight away loses files when Explorer opens several at once.
- **Typing stalls at 20 MB in full mode** (p95 122 ms). Light mode starts at 10 MB and drops highlighting, folding and wrap. Keep new per-keystroke work out of light mode.
- **The JSON formatter keeps the original number text, key order and duplicate keys.** Don't swap in `serde_json::Value`.

## E2E (`e2e/`)

- Launches the real exe with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`, then drives it with `playwright-core` over CDP and checks the bytes on disk.
- The debug exe needs Vite on port 1420, which the runner starts. Set `SE_EXE` to an installed exe to test a release build without Vite.
- **One E2E run at a time:** ports 9222 and 1420 are shared. Don't run E2E or `tauri dev` while another agent is building or testing on this machine.
- Launches set `SIMPLEEDITOR_MULTI_INSTANCE=1`, so the single-instance plugin can't hand a test launch to a SimpleEditor the user has open. Scenario 12 runs without it, and skips if any `simple-editor.exe` is running.
- The native Open and Save dialogs can't be automated. Pass files and folders as startup arguments.
- In page code, find the editor view from `.cm-content` (`cmTile` or `cmView`). Take screen points from `view.coordsAtPos`, not from the `.cm-line` box, which includes padding.

## Conventions

- **Files are CRLF** (`core.autocrlf=true`). Edit them with editor tools, not `sed` or heredocs.
- **Svelte 5 runes.** Stores are classes with `$state` fields in `*.svelte.ts` files.
- **Errors are explicit and logged.** On the frontend, use `reportError` / `notifyError`. In Rust, return `AppError` and call `log::error!`.
- **Git:** work on `dev`. Move `main` forward only when Steve asks; it is always a fast-forward of `dev`. There is no remote.
