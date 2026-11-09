# Big-file spike: CodeMirror 6 light mode at 150 MB

Historical decision record (measured 2026-11-09). Code: `src/lib/editor/largeFile.ts`, `src/routes/spike/+page.svelte`.

## Verdict

**GO** for editable light mode at 150 MB. Every light-mode gate passes with a large margin.
**Threshold:** switch to light mode above **10 MB**, not 20 MB (see "Full mode" below): at 20 MB full mode passes open and heap but fails the typing gate in the worst case (jump to mid-document, type at once).

## Environment

- CPU: Intel Core i9-14900K (24 cores / 32 threads), RAM 61.7 GB, Windows 11 Pro 10.0.26200
- Browser: Microsoft Edge 157.0.4341.42 (Chromium stand-in for WebView2), headless, `--js-flags=--max-old-space-size=4096`, plus `--disable-frame-rate-limit --disable-gpu-vsync` (see Method)
- CodeMirror: `@codemirror/view` 6.43.x, `state` 6.7.x, `lang-json` 6.0.2; dev server (vite dev, unminified), not a production build
- Fast desktop CPU: expect slower absolute numbers on typical hardware.

## Results (median of 3 runs, fresh browser per run)

| Case | Lines | Open | Typing p95 | JS heap after open | Gate |
|---|---|---|---|---|---|
| 150 MB JSON, light | 2,488,502 | 267 ms (< 5 s) | 19.3 ms (< 50 ms) | 223 MB (< 1.5 GB) | **PASS** |
| 20 MB JSON, full | 331,802 | 46 ms (< 3 s) | **122 ms** (< 50 ms) | 37 MB | open PASS, typing **FAIL** |
| 5 MB JSON, full | 82,952 | 31 ms | 24 ms | 16 MB | report |
| 10 MB JSON, full (extra) | 165,902 | 35 ms | 36 ms | 23 MB | report |
| 50 MB JSON, full | 829,502 | 92 ms | 124 ms | 79 MB | report |

Other 150 MB light numbers:

| Measure | Result |
|---|---|
| Scroll to end (cursor to doc end, 2 rAFs) | 18 ms |
| Undo after 20 isolated edits (20 undos, each followed by 2 rAFs) | 670 ms total; first undo 2.3 ms (the rest is the ~33 ms frame wait per undo) |
| `new TextDecoder().decode()` of 150 MB `ArrayBuffer` | 38 ms |
| `view.state.doc.toString()` | 96 ms |
| Headed run (same flags) | open 269 ms, typing p95 19 ms, toString 105 ms: same as headless |

Light-mode variation (no lineNumbers/highlightActiveLine, multi-selection off), 1 run: open 257 ms, typing p95 19 ms, heap 223 MB. No difference, so the base light set stays as is. Variation was not needed for the gate.

### Full mode: why 20 MB fails the typing gate

Typing latencies at 20 MB full show ~6 stalls of ~124 ms among otherwise ~23 ms edits, during the first ~30 edits, then none. Cause (inferred from the pattern, not profiled): the Lezer JSON parser must parse from the document start up to the viewport after jumping to the middle, in background slices, and edits during that catch-up cost a frame-dropping slice. The test jumps to mid-doc and types immediately, which is the worst case.

Same 20 MB case with a 4 s settle after the jump: typing p95 **21 ms** (3 runs). At 50 MB a 4 s settle is not enough (p95 still 124 ms). 10 MB passes the strict protocol (p95 36 ms).

## Method

- Page `/spike` generates deterministic JSON (hand-formatted records, ~40-120 char lines, a 1 MB chunk repeated N times and joined once; generation excluded from timings). Doc is ASCII so chars = bytes.
- Open = `new EditorView(EditorState.create({doc, extensions}))` through 2 rAFs.
- Typing = 50 single-char inserts at mid-document, each timed to 2 rAFs after dispatch; p95 over those 50.
- Heap = CDP `HeapProfiler.collectGarbage` then `Performance.getMetrics` `JSHeapUsedSize`, taken right after open.
- Driver: `playwright-core` + system Edge, script `...\scratchpad\spike\measure.mjs`; `window.__spike.run(sizeMb, mode)` and the step functions are the automation surface.
- **rAF floor caveat:** with Edge's default frame limiter, 2 rAFs on an empty page take ~62 ms in both headless and headed (above the 50 ms gate by themselves). With `--disable-frame-rate-limit --disable-gpu-vsync` the floor is ~35 ms. All table numbers use those flags. One headed 150 MB run without the flags gave typing p95 63.6 ms, equal to the 62.5 ms floor (editor work not measurable above the floor). WebView2 in the real app will be vsync-limited, so real latency is frame time plus the editor cost shown here.
- Typing p50 (~18-23 ms) is below the empty-page floor (35 ms median) because frame alignment varies; read p95 values as "no editor stall above frame time", not as exact milliseconds.

## Not measured

- Real WebView2 / Tauri (Edge stand-in only); production build; slower CPUs; low-RAM machines.
- Actual IPC transfer cost (only the decode and `toString` ends were simulated).
- Search over 150 MB (search panel is included, not exercised); typing at the very start/end; long-line files (minified JSON), where CodeMirror's per-line costs differ.
- Cause of the full-mode stalls was inferred, not profiled.
- 100 MB bracket not needed (150 MB did not fail).
