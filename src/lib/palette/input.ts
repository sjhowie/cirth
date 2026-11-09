/** Pure parsing of the palette input box: which mode is it in, and what is the query? */

export interface GotoTarget {
  line: number;
  /** 1-based column, or null when not given. */
  col: number | null;
}

export type PaletteInput =
  | { mode: "command"; query: string }
  | { mode: "goto"; text: string; target: GotoTarget | null }
  | { mode: "file"; query: string };

/** Parses `:12`, `:12:4` (leading colon optional). Returns null unless it is positive integers. */
export function parseGoto(text: string): GotoTarget | null {
  const m = /^:?\s*(\d+)(?::(\d+))?\s*$/.exec(text);
  if (!m) return null;
  const line = Number(m[1]);
  const col = m[2] === undefined ? null : Number(m[2]);
  if (line < 1 || (col !== null && col < 1)) return null;
  return { line, col };
}

export function parsePaletteInput(input: string): PaletteInput {
  if (input.startsWith(">")) return { mode: "command", query: input.slice(1).trim() };
  if (input.startsWith(":")) return { mode: "goto", text: input.slice(1), target: parseGoto(input) };
  return { mode: "file", query: input.trim() };
}

/** Moves `id` to the front of a most-recent-first list, de-duplicated and capped. */
export function pushRecent(list: readonly string[], id: string, max = 50): string[] {
  return [id, ...list.filter((x) => x !== id)].slice(0, max);
}
