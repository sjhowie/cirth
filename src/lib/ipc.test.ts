import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { SLICE_UNITS } from "./chunks";
import { buildWriteHeaders, checkRawRequestSize, isAppError, MAX_RAW_REQUEST_BYTES, parseReadFileResponse, readFile, toAppError, writeFile } from "./ipc";

function buildResponse(meta: object, text: string): ArrayBuffer {
  const enc = new TextEncoder();
  const metaBytes = enc.encode(JSON.stringify(meta));
  const textBytes = enc.encode(text);
  const out = new Uint8Array(4 + metaBytes.length + textBytes.length);
  new DataView(out.buffer).setUint32(0, metaBytes.length, true);
  out.set(metaBytes, 4);
  out.set(textBytes, 4 + metaBytes.length);
  return out.buffer;
}

const meta = { encoding: "utf-8", bom: false, eol: "lf", size: 0 };

describe("parseReadFileResponse", () => {
  it("parses ASCII text", () => {
    const r = parseReadFileResponse(buildResponse({ ...meta, size: 5 }, "hello"));
    expect(r.text).toBe("hello");
    expect(r.meta.size).toBe(5);
  });

  it("parses non-ASCII text and meta", () => {
    const text = "héllo wörld — 日本語 😀";
    const r = parseReadFileResponse(buildResponse({ ...meta, encoding: "windows-1252", bom: true, eol: "crlf" }, text));
    expect(r.text).toBe(text);
    expect(r.meta).toMatchObject({ encoding: "windows-1252", bom: true, eol: "crlf" });
  });

  it("parses an empty file", () => {
    const r = parseReadFileResponse(buildResponse(meta, ""));
    expect(r.text).toBe("");
    expect(r.meta.eol).toBe("lf");
  });

  it("parses CR line endings and the lossy flag", () => {
    const r = parseReadFileResponse(buildResponse({ ...meta, eol: "cr", lossy: true }, "a\rb�"));
    expect(r.meta).toMatchObject({ eol: "cr", lossy: true });
    expect(r.text).toBe("a\rb�");
  });

  it("treats a missing or non-true lossy as a clean decode", () => {
    expect(parseReadFileResponse(buildResponse(meta, "x")).meta.lossy).toBe(false);
    expect(parseReadFileResponse(buildResponse({ ...meta, lossy: "yes" }, "x")).meta.lossy).toBe(false);
  });

  it("keeps a literal U+FEFF in the text", () => {
    expect(parseReadFileResponse(buildResponse(meta, "\uFEFFx")).text).toBe("\uFEFFx");
  });

  it("rejects truncated responses", () => {
    expect(() => parseReadFileResponse(new ArrayBuffer(2))).toThrow();
    const bad = new Uint8Array(8);
    new DataView(bad.buffer).setUint32(0, 100, true);
    expect(() => parseReadFileResponse(bad.buffer)).toThrow();
  });
});

describe("header encoding", () => {
  it("percent-encodes paths with spaces and unicode", () => {
    const h = buildWriteHeaders("C:\\My Docs\\naïve 日本.txt", { encoding: "utf-8", bom: true, eol: "crlf" });
    expect(h["x-path"]).toBe(encodeURIComponent("C:\\My Docs\\naïve 日本.txt"));
    expect(h["x-path"]).toMatch(/^[\x20-\x7e]+$/);
    expect(decodeURIComponent(h["x-path"])).toBe("C:\\My Docs\\naïve 日本.txt");
    expect(h).toMatchObject({ "x-encoding": "utf-8", "x-bom": "1", "x-eol": "crlf" });
  });

  it("sends CR line endings as x-eol: cr", () => {
    expect(buildWriteHeaders("a.txt", { encoding: "utf-8", bom: false, eol: "cr" })["x-eol"]).toBe("cr");
  });
});

describe("wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });

  it("writeFile sends raw bytes with headers", async () => {
    invokeMock.mockResolvedValue({ size: 3 });
    const r = await writeFile("/a b/é.txt", "héy", { encoding: "utf-8", bom: false, eol: "lf" });
    expect(r.size).toBe(3);
    const [cmd, body, opts] = invokeMock.mock.calls[0];
    expect(cmd).toBe("write_file");
    expect(new TextDecoder().decode(body as Uint8Array)).toBe("héy");
    expect((opts as { headers: Record<string, string> }).headers["x-path"]).toBe(encodeURIComponent("/a b/é.txt"));
  });

  it("readFile parses the invoke result", async () => {
    invokeMock.mockResolvedValue(buildResponse(meta, "abc"));
    expect((await readFile("/x")).text).toBe("abc");
  });

  it("maps rejections to AppError", async () => {
    invokeMock.mockRejectedValue({ kind: "notFound", message: "gone" });
    await expect(readFile("/x")).rejects.toMatchObject({ kind: "notFound", message: "gone" });
    invokeMock.mockRejectedValue("boom");
    await expect(readFile("/x")).rejects.toMatchObject({ kind: "io", message: "boom" });
  });

  it("reports unavailable outside Tauri", async () => {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    await expect(readFile("/x")).rejects.toMatchObject({ kind: "unavailable" });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("AppError guard", () => {
  it("recognises valid errors only", () => {
    expect(isAppError({ kind: "parse", message: "x", line: 1, col: 2 })).toBe(true);
    expect(isAppError({ kind: "nope", message: "x" })).toBe(false);
    expect(isAppError("x")).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(toAppError(new Error("e")).message).toBe("e");
  });
});

describe("raw request size limit", () => {
  it("allows bodies up to the limit", () => {
    expect(() => checkRawRequestSize("write_file", MAX_RAW_REQUEST_BYTES)).not.toThrow();
  });

  it("rejects larger bodies with an invalidArg AppError instead of crashing the webview", () => {
    let thrown: unknown;
    try {
      checkRawRequestSize("format_json", MAX_RAW_REQUEST_BYTES + 1);
    } catch (e) {
      thrown = e;
    }
    expect(isAppError(thrown)).toBe(true);
    expect(thrown).toMatchObject({ kind: "invalidArg" });
    expect((thrown as { message: string }).message).toMatch(/format_json.*limit/);
  });
});

describe("chunked staging", () => {
  const opts = { encoding: "utf-8", bom: false, eol: "lf" as const };
  const big = "a".repeat(SLICE_UNITS + 5);

  beforeEach(() => {
    invokeMock.mockReset();
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });

  it("sends small payloads as one inline request", async () => {
    invokeMock.mockResolvedValue({ size: 3 });
    await writeFile("/x", "abc", opts);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0][0]).toBe("write_file");
    expect(invokeMock.mock.calls[0][2].headers["x-upload-id"]).toBeUndefined();
  });

  it("stages large payloads: begin, chunks in order, then the command with x-upload-id and an empty body", async () => {
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "upload_begin" ? { uploadId: "u1" } : { size: 1 }));
    await writeFile("/x", big, opts);
    const cmds = invokeMock.mock.calls.map((c) => c[0]);
    expect(cmds).toEqual(["upload_begin", "upload_chunk", "upload_chunk", "write_file"]);
    const chunks = invokeMock.mock.calls.filter((c) => c[0] === "upload_chunk");
    expect(chunks.map((c) => (c[1] as Uint8Array).length)).toEqual([SLICE_UNITS, 5]);
    for (const c of chunks) expect(c[2].headers).toEqual({ "x-upload-id": "u1" });
    const last = invokeMock.mock.calls[3];
    expect((last[1] as Uint8Array).length).toBe(0);
    expect(last[2].headers["x-upload-id"]).toBe("u1");
    expect(last[2].headers["x-path"]).toBe(encodeURIComponent("/x"));
  });

  it("discards the staged upload and rethrows when a chunk fails", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "upload_begin") return { uploadId: "u2" };
      if (cmd === "upload_chunk") throw { kind: "io", message: "disk full" };
      return undefined;
    });
    await expect(writeFile("/x", big, opts)).rejects.toMatchObject({ kind: "io", message: "disk full" });
    const discard = invokeMock.mock.calls.find((c) => c[0] === "upload_discard");
    expect(discard?.[1]).toEqual({ uploadId: "u2" });
    expect(invokeMock.mock.calls.some((c) => c[0] === "write_file")).toBe(false);
  });

  it("discards (idempotent) and rethrows when the consuming command fails", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "upload_begin") return { uploadId: "u3" };
      if (cmd === "write_file") throw { kind: "encoding", message: "cannot encode" };
      return undefined;
    });
    await expect(writeFile("/x", big, opts)).rejects.toMatchObject({ kind: "encoding" });
    expect(invokeMock.mock.calls.some((c) => c[0] === "upload_discard" && c[1].uploadId === "u3")).toBe(true);
  });
});
