import { describe, expect, it } from "vitest";
import { eventToStroke, formatBinding, KeyResolver, normalizeBinding, parseStroke, type KeyEventLike } from "./keybindings";

function ev(key: string, mods: Partial<KeyEventLike> = {}): KeyEventLike {
  return { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods };
}

describe("parseStroke / normalizeBinding", () => {
  it("parses modifiers and key", () => {
    expect(parseStroke("Mod-Shift-s")).toMatchObject({ mod: true, shift: true, alt: false, key: "s" });
  });

  it("handles punctuation keys", () => {
    expect(parseStroke("Mod-,").key).toBe(",");
    expect(parseStroke("Mod--").key).toBe("-");
  });

  it("normalises modifier order and case", () => {
    expect(normalizeBinding("Shift-Alt-F")).toBe("Alt-Shift-f");
    expect(normalizeBinding("Ctrl-Alt-Shift-x")).toBe("Ctrl-Alt-Shift-x");
    expect(normalizeBinding("Mod-k  Mod-o")).toBe("Mod-k Mod-o");
  });

  it("rejects an empty key", () => {
    expect(() => parseStroke("Mod-")).toThrow();
  });
});

describe("eventToStroke", () => {
  it("maps Ctrl to Mod on non-mac", () => {
    expect(eventToStroke(ev("s", { ctrlKey: true }), false)).toBe("Mod-s");
    expect(eventToStroke(ev("S", { ctrlKey: true, shiftKey: true }), false)).toBe("Mod-Shift-s");
  });

  it("maps Cmd to Mod on mac and keeps Ctrl distinct", () => {
    expect(eventToStroke(ev("s", { metaKey: true }), true)).toBe("Mod-s");
    expect(eventToStroke(ev("s", { ctrlKey: true }), true)).toBe("Ctrl-s");
  });

  it("uses the physical key when Alt changes the character", () => {
    expect(eventToStroke(ev("ƒ", { altKey: true, shiftKey: true, code: "KeyF" }), true)).toBe("Alt-Shift-f");
  });

  it("ignores bare modifiers and drops Shift on symbols", () => {
    expect(eventToStroke(ev("Control", { ctrlKey: true }), false)).toBeNull();
    expect(eventToStroke(ev("<", { ctrlKey: true, shiftKey: true }), false)).toBe("Mod-<");
    expect(eventToStroke(ev(",", { ctrlKey: true }), false)).toBe("Mod-,");
  });
});

describe("KeyResolver", () => {
  const bindings = [
    { id: "save", keys: ["Mod-s"] },
    { id: "openFolder", keys: ["Mod-k Mod-o"] },
    { id: "open", keys: ["Mod-o"] },
  ];
  const make = () => new KeyResolver(() => bindings, 1500);

  it("runs single bindings and ignores unbound keys", () => {
    const r = make();
    expect(r.handle("Mod-s", 0)).toEqual({ type: "run", id: "save" });
    expect(r.handle("Mod-q", 0)).toEqual({ type: "none" });
  });

  it("resolves a two-step chord", () => {
    const r = make();
    expect(r.handle("Mod-k", 0)).toEqual({ type: "pending", prefix: "Mod-k" });
    expect(r.handle("Mod-o", 500)).toEqual({ type: "run", id: "openFolder" });
  });

  it("the second stroke does not trigger its own single binding", () => {
    const r = make();
    r.handle("Mod-k", 0);
    expect(r.handle("Mod-o", 10)).toEqual({ type: "run", id: "openFolder" });
    expect(r.handle("Mod-o", 20)).toEqual({ type: "run", id: "open" });
  });

  it("cancels on a non-matching second stroke", () => {
    const r = make();
    r.handle("Mod-k", 0);
    expect(r.handle("Mod-s", 100)).toEqual({ type: "cancelled" });
    expect(r.handle("Mod-s", 200)).toEqual({ type: "run", id: "save" });
  });

  it("times out after 1.5 s and treats the stroke fresh", () => {
    const r = make();
    r.handle("Mod-k", 0);
    expect(r.handle("Mod-s", 1501)).toEqual({ type: "run", id: "save" });
  });

  it("rejects 3-step chords", () => {
    const r = new KeyResolver(() => [{ id: "x", keys: ["Mod-a Mod-b Mod-c"] }]);
    expect(() => r.handle("Mod-a", 0)).toThrow();
  });
});

describe("formatBinding", () => {
  it("formats for Windows/Linux", () => {
    expect(formatBinding("Mod-Shift-s", false)).toBe("Ctrl+Shift+S");
    expect(formatBinding("Mod-k Mod-o", false)).toBe("Ctrl+K Ctrl+O");
    expect(formatBinding("Shift-Alt-f", false)).toBe("Alt+Shift+F");
  });

  it("formats for macOS", () => {
    expect(formatBinding("Mod-Shift-s", true)).toBe("⇧⌘S");
    expect(formatBinding("Mod-,", true)).toBe("⌘,");
  });
});
