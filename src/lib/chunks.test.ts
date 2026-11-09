import { describe, expect, it } from "vitest";
import { CHUNK_BYTES, SLICE_UNITS, encodeChunks } from "./chunks";
import { Text } from "@codemirror/state";

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

describe("encodeChunks", () => {
  it("yields nothing for empty input", () => {
    expect([...encodeChunks("")]).toEqual([]);
    expect([...encodeChunks([])]).toEqual([]);
  });

  it("one small string is one chunk", () => {
    const chunks = [...encodeChunks("héllo")];
    expect(chunks).toHaveLength(1);
    expect(dec.decode(chunks[0])).toBe("héllo");
  });

  it("never splits a surrogate pair, whatever the slice size or alignment", () => {
    const text = "a😀b😀😀c" + "😀".repeat(7) + "é日本";
    for (let units = 2; units <= 9; units++) {
      const chunks = [...encodeChunks(text, units)];
      // fatal decoding throws on a split pair (it would have been encoded as U+FFFD otherwise).
      for (const c of chunks) expect(() => dec.decode(c)).not.toThrow();
      expect(chunks.map((c) => dec.decode(c)).join("")).toBe(text);
      expect(concat(chunks)).toEqual(enc.encode(text));
    }
  });

  it("emoji exactly on a slice boundary moves whole to the next chunk", () => {
    // 3 units then a pair that would straddle the cut at 4.
    const chunks = [...encodeChunks("abc😀def", 4)].map((c) => dec.decode(c));
    expect(chunks).toEqual(["abc", "😀de", "f"]);
  });

  it("reassembled bytes equal TextEncoder of the whole string", () => {
    const text = Array.from({ length: 5000 }, (_, i) => `line ${i} é日😀`).join("\n");
    for (const units of [2, 3, 17, 1000, 100000]) expect(concat([...encodeChunks(text, units)])).toEqual(enc.encode(text));
  });

  it("chunk sizes are bounded by 3 bytes per slice unit", () => {
    const text = "日".repeat(1000) + "😀".repeat(500) + "x".repeat(1000);
    for (const c of encodeChunks(text, 100)) expect(c.length).toBeLessThanOrEqual(300);
  });

  it("accepts a CodeMirror Text (lines and breaks) and matches doc.toString()", () => {
    const doc = Text.of(["first é", "second 😀", "", "last"]);
    expect(concat([...encodeChunks(doc, 5)])).toEqual(enc.encode(doc.toString()));
  });

  it("default slice keeps an encoded chunk under CHUNK_BYTES even for 3-byte text", () => {
    expect(3 * SLICE_UNITS).toBeLessThanOrEqual(CHUNK_BYTES);
    const text = "日".repeat(SLICE_UNITS + 10);
    const sizes = [...encodeChunks(text)].map((c) => c.length);
    expect(sizes).toHaveLength(2);
    for (const n of sizes) expect(n).toBeLessThanOrEqual(CHUNK_BYTES);
  });

  it("rejects a degenerate slice size", () => {
    expect(() => [...encodeChunks("abc", 1)]).toThrow(RangeError);
  });
});
