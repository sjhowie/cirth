/**
 * Pure keybinding logic: parse CodeMirror-style bindings ("Mod-Shift-s", chords "Mod-k Mod-o"),
 * turn keyboard events into the same canonical form, resolve chords, and format for display.
 */

export interface Stroke {
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  /** Lower-cased key name, e.g. "s", ",", "enter", "arrowup". */
  key: string;
}

const modifierNames: Record<string, keyof Omit<Stroke, "key">> = {
  mod: "mod",
  ctrl: "ctrl",
  control: "ctrl",
  cmd: "meta",
  meta: "meta",
  command: "meta",
  alt: "alt",
  option: "alt",
  shift: "shift",
};

/** Parses one stroke such as "Mod-Shift-s" (also "Mod--" for the minus key). */
export function parseStroke(text: string): Stroke {
  const stroke: Stroke = { mod: false, ctrl: false, meta: false, alt: false, shift: false, key: "" };
  let rest = text.trim();
  for (;;) {
    const dash = rest.indexOf("-");
    if (dash <= 0) break;
    const name = modifierNames[rest.slice(0, dash).toLowerCase()];
    if (!name) break;
    stroke[name] = true;
    rest = rest.slice(dash + 1);
  }
  stroke.key = rest.toLowerCase();
  if (stroke.key === "") throw new Error(`Invalid key binding: "${text}"`);
  return stroke;
}

/** Canonical string for a stroke; modifier order is fixed so equal strokes compare equal. */
export function strokeToString(s: Stroke): string {
  const parts: string[] = [];
  if (s.mod) parts.push("Mod");
  if (s.ctrl) parts.push("Ctrl");
  if (s.meta) parts.push("Meta");
  if (s.alt) parts.push("Alt");
  if (s.shift) parts.push("Shift");
  parts.push(s.key);
  return parts.join("-");
}

/** Canonical form of a whole binding (one or more strokes). */
export function normalizeBinding(binding: string): string {
  return binding
    .trim()
    .split(/\s+/)
    .map((p) => strokeToString(parseStroke(p)))
    .join(" ");
}

export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const modifierKeys = new Set(["control", "shift", "alt", "meta", "altgraph", "os", "capslock"]);

/** Canonical stroke string for a keyboard event, or null for a bare modifier press. */
export function eventToStroke(e: KeyEventLike, isMac: boolean): string | null {
  let key = e.key.toLowerCase();
  if (modifierKeys.has(key)) return null;
  // Alt changes the produced character on macOS (Alt+f -> "ƒ"); use the physical key instead.
  if (e.altKey && e.code) {
    const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(e.code);
    if (m) key = (m[1] ?? m[2]).toLowerCase();
  }
  if (key === " ") key = "space";
  const isLetter = key.length === 1 && key.toLowerCase() !== key.toUpperCase();
  const isNamed = key.length > 1;
  return strokeToString({
    mod: isMac ? e.metaKey : e.ctrlKey,
    ctrl: isMac ? e.ctrlKey : false,
    meta: isMac ? false : e.metaKey,
    alt: e.altKey,
    // Shift on symbol keys is already folded into the produced character.
    shift: e.shiftKey && (isLetter || isNamed),
    key,
  });
}

export interface BindingEntry {
  id: string;
  keys?: string[];
}

export type ResolveResult =
  | { type: "none" }
  | { type: "pending"; prefix: string }
  | { type: "cancelled" }
  | { type: "run"; id: string };

/** Resolves strokes (including two-step chords) against a binding table. */
export class KeyResolver {
  private pending: string | null = null;
  private pendingAt = 0;

  constructor(
    private readonly getBindings: () => BindingEntry[],
    private readonly timeoutMs = 1500,
  ) {}

  /** Feed the canonical stroke of a keydown. `now` is a millisecond clock. */
  handle(stroke: string, now: number): ResolveResult {
    const { single, chords, prefixes } = this.table();
    if (this.pending !== null) {
      const expired = now - this.pendingAt > this.timeoutMs;
      const prefix = this.pending;
      this.pending = null;
      if (!expired) {
        const id = chords.get(`${prefix} ${stroke}`);
        return id ? { type: "run", id } : { type: "cancelled" };
      }
    }
    if (prefixes.has(stroke)) {
      this.pending = stroke;
      this.pendingAt = now;
      return { type: "pending", prefix: stroke };
    }
    const id = single.get(stroke);
    return id ? { type: "run", id } : { type: "none" };
  }

  reset(): void {
    this.pending = null;
  }

  private table() {
    const single = new Map<string, string>();
    const chords = new Map<string, string>();
    const prefixes = new Set<string>();
    for (const b of this.getBindings()) {
      for (const key of b.keys ?? []) {
        const norm = normalizeBinding(key);
        const parts = norm.split(" ");
        if (parts.length === 1) single.set(norm, b.id);
        else if (parts.length === 2) {
          chords.set(norm, b.id);
          prefixes.add(parts[0]);
        } else throw new Error(`Only 1 or 2 step bindings are supported: "${key}"`);
      }
    }
    return { single, chords, prefixes };
  }
}

const keyLabels: Record<string, string> = {
  enter: "Enter",
  escape: "Esc",
  space: "Space",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  backspace: "Backspace",
  delete: "Delete",
  tab: "Tab",
};

function formatStroke(stroke: string, isMac: boolean): string {
  const s = parseStroke(stroke);
  const key = keyLabels[s.key] ?? (s.key.length === 1 ? s.key.toUpperCase() : s.key);
  if (isMac) {
    return (
      (s.ctrl ? "⌃" : "") + (s.alt ? "⌥" : "") + (s.shift ? "⇧" : "") + (s.mod || s.meta ? "⌘" : "") + key
    );
  }
  const parts: string[] = [];
  if (s.mod || s.ctrl) parts.push("Ctrl");
  if (s.meta) parts.push("Win");
  if (s.alt) parts.push("Alt");
  if (s.shift) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

/** Human-readable shortcut: "Ctrl+Shift+S" / "⇧⌘S"; chords are space separated. */
export function formatBinding(binding: string, isMac: boolean): string {
  return binding
    .trim()
    .split(/\s+/)
    .map((p) => formatStroke(p, isMac))
    .join(" ");
}
