/** Pure helpers for relative references inside a Markdown file (images and links). */

/** `scheme:` references (http:, mailto:, data:, asset:, file:...). A single letter is a Windows drive, not a scheme. */
const SCHEME = /^[a-z][a-z0-9+.-]+:/i;
const DRIVE = /^[a-z]:[\\/]/i;

export function isExternalRef(ref: string): boolean {
  return SCHEME.test(ref) || ref.startsWith("//");
}

/** Splits `path?query#hash` into the path and the trailing `#hash` (query is dropped). */
export function splitRef(ref: string): { path: string; hash: string } {
  const h = ref.indexOf("#");
  const hash = h < 0 ? "" : ref.slice(h + 1);
  let path = h < 0 ? ref : ref.slice(0, h);
  const q = path.indexOf("?");
  if (q >= 0) path = path.slice(0, q);
  return { path, hash };
}

/** GitHub-style heading slug: lower case, punctuation dropped, spaces to hyphens. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function safeDecode(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    // Malformed percent-escape: the literal text is the best remaining guess for a file name.
    return s;
  }
}

/**
 * Resolves a relative file reference against the document's directory, keeping the directory's
 * separator style. `..` stops at the root. Returns null when the reference is external, empty
 * or there is no directory (Untitled tabs).
 */
export function resolveRelativePath(docDir: string | null, ref: string): string | null {
  if (!docDir || ref === "" || isExternalRef(ref)) return null;
  const decoded = safeDecode(ref);
  const sep = docDir.includes("\\") && !docDir.includes("/") ? "\\" : "/";
  const absolute = DRIVE.test(decoded) || decoded.startsWith("/") || decoded.startsWith("\\");

  // A rooted ref ("/x.png") keeps only the drive of the document directory.
  const drive = /^[a-z]:/i.exec(docDir);
  const prefix = absolute && !DRIVE.test(decoded) ? (drive ? drive[0] : "") : "";
  const parts = absolute ? [] : docDir.split(/[\\/]+/);
  for (const seg of decoded.split(/[\\/]+/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      // Never pop the root segment (drive letter or the empty segment of a POSIX root).
      if (parts.length > 1) parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const joined = parts.join(sep);
  if (!absolute) return docDir.startsWith("\\\\") ? "\\" + joined : joined; // UNC root
  if (DRIVE.test(decoded)) return joined;
  return prefix + sep + joined;
}
