/** Pure helpers that build the quick-open candidate list from the cached file list and the open tabs. */
import { isInside, normPath } from "../paths";
import { relativeTo } from "../search/results";

export interface FileCandidate {
  /** Text that is matched and shown: root-relative path, full path outside the root, or the title of an unsaved tab. */
  text: string;
  /** Absolute path, or null for an unsaved (Untitled) tab. For index entries use joinRelative(). */
  abs: string | null;
  /** Set for entries that are open tabs. */
  tabId: number | null;
}

export interface OpenTabInfo {
  id: number;
  path: string | null;
  title: string;
}

/** Root + root-relative `/` path, using the root's own separator style. */
export function joinRelative(root: string, rel: string): string {
  const backslash = root.includes("\\") && !root.includes("/");
  const base = root.replace(/[\\/]+$/, "");
  return backslash ? `${base}\\${rel.replace(/\//g, "\\")}` : `${base}/${rel}`;
}

/** Absolute path of a candidate (index entries are root-relative). */
export function candidatePath(root: string | null, c: FileCandidate): string | null {
  if (c.abs !== null) return c.abs;
  return root === null ? null : joinRelative(root, c.text);
}

/** Open tabs first (in tab order), then every indexed file that is not already an open tab. */
export function buildCandidates(root: string | null, files: readonly string[], tabs: readonly OpenTabInfo[]): FileCandidate[] {
  const out: FileCandidate[] = [];
  const openRel = new Set<string>();
  for (const t of tabs) {
    if (t.path === null) {
      out.push({ text: t.title, abs: null, tabId: t.id });
      continue;
    }
    const inRoot = root !== null && isInside(root, t.path);
    const text = inRoot ? relativeTo(root, t.path) : t.path;
    if (inRoot) openRel.add(normPath(text));
    out.push({ text, abs: t.path, tabId: t.id });
  }
  for (const rel of files) {
    if (openRel.size > 0 && openRel.has(normPath(rel))) continue;
    out.push({ text: rel, abs: null, tabId: null });
  }
  return out;
}
