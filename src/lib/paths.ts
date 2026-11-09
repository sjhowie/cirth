import { isMac, isWindows } from "./platform";

const caseInsensitive = isWindows || isMac;

/** Comparison key for a path: forward slashes, no trailing slash, case-folded on Windows/macOS. */
export function normPath(p: string): string {
  let n = p.replace(/\\/g, "/");
  if (n.length > 1 && n.endsWith("/") && !/^[A-Za-z]:\/$/.test(n)) n = n.replace(/\/+$/, "");
  return caseInsensitive ? n.toLowerCase() : n;
}

export function samePath(a: string, b: string): boolean {
  return normPath(a) === normPath(b);
}

export function basename(p: string): string {
  const n = p.replace(/[\\/]+$/, "");
  const i = Math.max(n.lastIndexOf("/"), n.lastIndexOf("\\"));
  return i < 0 ? n : n.slice(i + 1);
}

export function dirname(p: string): string {
  const n = p.replace(/[\\/]+$/, "");
  const i = Math.max(n.lastIndexOf("/"), n.lastIndexOf("\\"));
  if (i < 0) return "";
  if (i === 0) return n.slice(0, 1);
  return n.slice(0, i);
}

/** Joins using the separator style already used by `dir`. */
export function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
}

/** True if `child` is `parent` or lives below it. */
export function isInside(parent: string, child: string): boolean {
  const p = normPath(parent);
  const c = normPath(child);
  return c === p || c.startsWith(p.endsWith("/") ? p : p + "/");
}

/** Re-roots `path` from `oldPrefix` to `newPrefix` (path must be inside oldPrefix). */
export function replacePrefix(path: string, oldPrefix: string, newPrefix: string): string {
  const rest = path.slice(oldPrefix.replace(/[\\/]+$/, "").length);
  return newPrefix.replace(/[\\/]+$/, "") + rest;
}
