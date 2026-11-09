/**
 * Pure model of one folder search: groups streamed `search://result` events per file and ignores
 * events from stale searches. No Svelte, no IPC, so it is testable with fake events.
 */
import type { SearchDonePayload, SearchItem, SearchResultPayload } from "../ipc";

export interface FileGroup {
  path: string;
  items: SearchItem[];
}

export class SearchResults {
  files: FileGroup[] = [];
  matches = 0;
  done: SearchDonePayload | null = null;
  private byPath = new Map<string, FileGroup>();

  constructor(readonly searchId: string) {}

  /** Adds a result event. Returns false (and changes nothing) when it belongs to another search or arrives after done. */
  addResult(p: SearchResultPayload): boolean {
    if (p.searchId !== this.searchId || this.done) return false;
    let group = this.byPath.get(p.path);
    if (!group) {
      group = { path: p.path, items: [] };
      this.byPath.set(p.path, group);
      this.files.push(group);
    }
    group.items.push(...p.items);
    this.matches += p.items.length;
    return true;
  }

  /** Marks the search finished. Returns false for a stale searchId. */
  finish(p: SearchDonePayload): boolean {
    if (p.searchId !== this.searchId) return false;
    this.done = p;
    return true;
  }

  get finished(): boolean {
    return this.done !== null;
  }
}

export interface ReplacePlan {
  /** Files that will be sent to `replace_in_folder`. */
  paths: string[];
  occurrences: number;
  /** Files skipped because they are open with unsaved changes. */
  skipped: string[];
}

/** Splits the results into files to replace in and files skipped for unsaved edits. */
export function planReplace(results: SearchResults, isDirty: (path: string) => boolean): ReplacePlan {
  const plan: ReplacePlan = { paths: [], occurrences: 0, skipped: [] };
  for (const f of results.files) {
    if (isDirty(f.path)) plan.skipped.push(f.path);
    else {
      plan.paths.push(f.path);
      plan.occurrences += f.items.length;
    }
  }
  return plan;
}

/** "N results in M files" plus "(truncated)" / "Cancelled". */
export function summaryText(r: SearchResults): string {
  const files = r.files.length;
  const parts = [`${r.matches} ${r.matches === 1 ? "result" : "results"} in ${files} ${files === 1 ? "file" : "files"}`];
  if (r.done?.truncated) parts.push("(truncated)");
  if (r.done?.cancelled) parts.push("Cancelled");
  return parts.join(" ");
}

/** Path relative to `root` for display (forward slashes); the path itself when it is outside `root`. */
export function relativeTo(root: string, path: string): string {
  const r = root.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  const p = path.replace(/\\/g, "/");
  const prefix = r + "/";
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (p.length > prefix.length && same(p.slice(0, prefix.length), prefix)) return p.slice(prefix.length);
  return p;
}

export interface PreviewParts {
  before: string;
  match: string;
  after: string;
}

/** Splits a preview around the match; `col`/`matchLen` count Unicode code points, not UTF-16 units. */
export function splitPreview(preview: string, col: number, matchLen: number): PreviewParts {
  const chars = Array.from(preview);
  const start = Math.min(Math.max(col - 1, 0), chars.length);
  const end = Math.min(start + Math.max(matchLen, 0), chars.length);
  return { before: chars.slice(0, start).join(""), match: chars.slice(start, end).join(""), after: chars.slice(end).join("") };
}

/**
 * Maps a search item onto the live document line: the preview is a trimmed, windowed substring of
 * the line and `col`/`matchLen` are code points within it. Returns a 1-based UTF-16 column and a
 * UTF-16 length for the editor, or null when the line no longer contains the previewed text.
 */
export function locateMatch(lineText: string, item: SearchItem): { col: number; len: number } | null {
  const { before, match } = splitPreview(item.preview, item.col, item.matchLen);
  const at = lineText.indexOf(item.preview);
  if (at >= 0) return { col: at + before.length + 1, len: match.length };
  // The line changed since the search; fall back to the first occurrence of the matched text.
  if (match.length > 0) {
    const i = lineText.indexOf(match);
    if (i >= 0) return { col: i + 1, len: match.length };
  }
  return null;
}
