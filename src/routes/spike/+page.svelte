<script lang="ts">
  // Big-file performance spike. Driven by window.__spike (see docs/decisions/big-file-spike.md).
  import { onMount } from "svelte";
  import { EditorState, EditorSelection, type Extension } from "@codemirror/state";
  import { EditorView } from "@codemirror/view";
  import { undo, isolateHistory } from "@codemirror/commands";
  import { json } from "@codemirror/lang-json";
  import { lightModeExtensions, fullModeExtensions } from "$lib/editor/largeFile";

  type Mode = "light" | "full" | "light-min";

  let host: HTMLDivElement;
  let view: EditorView | null = null;

  const raf2 = () =>
    new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())));

  /** Deterministic pretty-printed JSON of ~sizeMb MB (lines 40-120 chars). Chunk built once, repeated. */
  function generateJson(sizeMb: number): string {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"];
    const w = () => words[Math.floor(rnd() * words.length)];
    const records: string[] = [];
    let size = 0;
    let id = 0;
    const target = 1024 * 1024;
    while (size < target) {
      // Hand-formatted so lines are ~40-120 chars (JSON.stringify indent=2 gives ~20-char lines).
      const s = [
        "  {",
        `    "id": ${id++}, "name": "${w()}-${w()}-${w()}-${Math.floor(rnd() * 1e6)}", "price": ${Math.round(rnd() * 1e6) / 100}, "active": ${rnd() > 0.5},`,
        `    "description": "${w()} ${w()} ${w()} ${w()} ${w()} ${w()} ${w()} ${w()} ${w()} ${w()} ${w()}",`,
        `    "tags": ["${w()}", "${w()}", "${w()}"], "nested": { "x": ${Math.floor(rnd() * 1000)}, "y": ${Math.floor(rnd() * 1000)}, "label": "${w()}_${w()}" },`,
        `    "values": [${rnd()}, ${rnd()}, ${rnd()}, ${rnd()}]`,
        "  }",
      ].join("\n");
      records.push(s);
      size += s.length + 2;
    }
    const chunk = records.join(",\n");
    const n = Math.max(1, Math.round(sizeMb));
    return "[\n" + new Array<string>(n).fill(chunk).join(",\n") + "\n]";
  }

  function percentile(arr: number[], p: number): number {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
  }

  function heapMb(): number | null {
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return m ? m.usedJSHeapSize / 1048576 : null;
  }

  function extensionsFor(mode: Mode): Extension[] {
    if (mode === "full") return fullModeExtensions(json());
    if (mode === "light") return lightModeExtensions();
    // Variation: light mode minus lineNumbers/activeLine (first two entries) and multi-selection off.
    return [...lightModeExtensions().slice(2), EditorState.allowMultipleSelections.of(false)];
  }

  /** Generate (untimed), then time EditorView creation + first frame. Returns timings; keeps the view alive. */
  async function open(sizeMb: number, mode: Mode) {
    view?.destroy();
    view = null;
    host.replaceChildren();
    let t = performance.now();
    let doc: string | null = generateJson(sizeMb);
    const genMs = performance.now() - t;
    const docChars = doc.length;
    await raf2();
    t = performance.now();
    view = new EditorView({ state: EditorState.create({ doc, extensions: extensionsFor(mode) }), parent: host });
    await raf2();
    const openMs = performance.now() - t;
    doc = null;
    return { sizeMb, mode, docChars, lines: view.state.doc.lines, genMs, openMs, heapMbPage: heapMb() };
  }

  /** Insert 1 char mid-doc, wait 2 rAFs, repeat; latencies in ms. */
  async function typing(iterations = 50, settleMs = 0) {
    const v = view!;
    const mid = Math.floor(v.state.doc.length / 2);
    v.dispatch({ selection: EditorSelection.cursor(mid), scrollIntoView: true });
    await raf2();
    if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs)); // let background parsing reach the viewport
    const lat: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const t = performance.now();
      const pos = mid + i;
      v.dispatch({ changes: { from: pos, insert: "x" }, selection: EditorSelection.cursor(pos + 1), userEvent: "input.type" });
      await raf2();
      lat.push(performance.now() - t);
    }
    return { latencies: lat, p50: percentile(lat, 50), p95: percentile(lat, 95), max: Math.max(...lat) };
  }

  /** Latency floor: 2 rAFs with no editor work (headless rAF may be throttled). */
  async function rafBaseline(n = 30) {
    const lat: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = performance.now();
      await raf2();
      lat.push(performance.now() - t);
    }
    return { p50: percentile(lat, 50), p95: percentile(lat, 95) };
  }

  async function scrollToEnd() {
    const v = view!;
    const t = performance.now();
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.length), scrollIntoView: true });
    await raf2();
    return performance.now() - t;
  }

  /** 20 separate history events, then undo all 20 (total ms and per-undo ms). */
  async function undoAfter20() {
    const v = view!;
    const base = Math.floor(v.state.doc.length / 3);
    for (let i = 0; i < 20; i++) {
      v.dispatch({ changes: { from: base + i * 10, insert: "u" }, annotations: isolateHistory.of("full"), userEvent: "input.type" });
    }
    await raf2();
    const per: number[] = [];
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      undo(v);
      await raf2();
      per.push(performance.now() - t);
    }
    return { totalMs: performance.now() - t0, firstUndoMs: per[0], maxUndoMs: Math.max(...per) };
  }

  /** toString of the whole doc (save) and TextDecoder of an equally sized ArrayBuffer (IPC payload). */
  async function ioCosts() {
    const v = view!;
    let t = performance.now();
    const s = v.state.doc.toString();
    const toStringMs = performance.now() - t;
    const bytes = s.length; // JSON is ASCII, chars == bytes
    const buf = new ArrayBuffer(bytes);
    new Uint8Array(buf).fill(32);
    t = performance.now();
    const decoded = new TextDecoder().decode(buf);
    const decodeMs = performance.now() - t;
    return { toStringMs, decodeMs, bytes, decodedLen: decoded.length };
  }

  async function run(sizeMb: number, mode: Mode, extras = false) {
    const o = await open(sizeMb, mode);
    const heapAfterOpenMb = heapMb();
    const ty = await typing();
    const result: Record<string, unknown> = { ...o, heapAfterOpenMb, typing: ty, scrollToEndMs: await scrollToEnd() };
    if (extras) {
      result.undo = await undoAfter20();
      result.io = await ioCosts();
    }
    return result;
  }

  onMount(() => {
    (window as unknown as { __spike: unknown }).__spike = { run, open, rafBaseline, typing, scrollToEnd, undoAfter20, ioCosts, heapMb };
    (window as unknown as { __spikeReady: boolean }).__spikeReady = true;
    return () => view?.destroy();
  });
</script>

<div bind:this={host} class="host"></div>

<style>
  .host {
    position: fixed;
    inset: 0;
  }
  .host :global(.cm-editor) {
    height: 100%;
  }
  .host :global(.cm-scroller) {
    overflow: auto;
  }
</style>
