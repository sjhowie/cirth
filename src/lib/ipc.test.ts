import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

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
