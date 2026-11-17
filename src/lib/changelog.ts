/**
 * Parses CHANGELOG.md for Help > What's New. Format (scripts/release.mjs depends on it too):
 *   ## Unreleased | ## X.Y.Z - YYYY-MM-DD, then ### New / ### Improved / ### Fixed, then "- item" lines.
 * Items are untrusted text: everything is HTML-escaped, and only `code` spans become markup.
 */

export type SectionKind = "new" | "improved" | "fixed";

export interface ChangelogSection {
  kind: SectionKind;
  /** Display label: NEW / IMPROVED / FIXED. */
  label: string;
  /** Safe HTML, one entry per bullet. */
  items: string[];
}

export interface ChangelogRelease {
  /** null for the Unreleased section. */
  version: string | null;
  /** YYYY-MM-DD, or null when absent. */
  date: string | null;
  sections: ChangelogSection[];
}

const SECTION_ORDER: SectionKind[] = ["new", "improved", "fixed"];
const RELEASE_RE = /^##\s+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s+[-–]\s+(\d{4}-\d{2}-\d{2}))?\s*$/;
const UNRELEASED_RE = /^##\s+unreleased\s*$/i;
const SECTION_RE = /^###\s+(\S.*?)\s*$/;
const ITEM_RE = /^[-*]\s+(.*\S)\s*$/;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Escapes the text and turns each `pair` of backticks into <code>; an unpaired backtick stays literal. */
export function renderInline(text: string): string {
  const parts = text.split("`");
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const inCode = i % 2 === 1 && i < parts.length - 1;
    if (inCode) out += `<code>${escapeHtml(parts[i])}</code>`;
    else out += (i % 2 === 1 ? "`" : "") + escapeHtml(parts[i]);
  }
  return out;
}

/** "2026-11-17" -> "November 17, 2026"; anything else is returned unchanged. */
export function formatReleaseDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return iso;
  return `${MONTHS[month - 1]} ${day}, ${m[1]}`;
}

/** Releases in file order (newest first by convention), Unreleased first; empty releases are dropped. */
export function parseChangelog(md: string): ChangelogRelease[] {
  type Draft = { version: string | null; date: string | null; items: Map<SectionKind, string[]> };
  const drafts: Draft[] = [];
  let release: Draft | null = null;
  let section: SectionKind | null = null;

  for (const raw of md.split(/\r?\n|\r/)) {
    const line = raw.trim();
    if (line.startsWith("## ") || line === "##") {
      section = null;
      const rel = RELEASE_RE.exec(line);
      if (rel) release = { version: rel[1], date: rel[2] ?? null, items: new Map() };
      else if (UNRELEASED_RE.test(line)) release = { version: null, date: null, items: new Map() };
      else release = null; // unknown heading: ignore its content
      if (release) drafts.push(release);
      continue;
    }
    const sec = SECTION_RE.exec(line);
    if (sec) {
      const kind = sec[1].toLowerCase();
      section = (SECTION_ORDER as string[]).includes(kind) ? (kind as SectionKind) : null;
      continue;
    }
    const item = ITEM_RE.exec(line);
    if (item && release && section) {
      const list = release.items.get(section) ?? [];
      list.push(renderInline(item[1]));
      release.items.set(section, list);
    }
  }

  const releases = drafts
    .map((d) => ({
      version: d.version,
      date: d.date,
      sections: SECTION_ORDER.filter((k) => (d.items.get(k)?.length ?? 0) > 0).map((k) => ({
        kind: k,
        label: k.toUpperCase(),
        items: d.items.get(k) ?? [],
      })),
    }))
    .filter((r) => r.sections.length > 0);
  return [...releases.filter((r) => r.version === null).slice(0, 1), ...releases.filter((r) => r.version !== null)];
}

/** Unreleased is shown only in dev builds. */
export function visibleReleases(releases: ChangelogRelease[], dev: boolean): ChangelogRelease[] {
  return dev ? releases : releases.filter((r) => r.version !== null);
}

/**
 * Whether to open What's New at startup: only in release builds, only once per new version,
 * never on the first run (nothing stored yet). The caller records `current` either way.
 */
export function shouldShowWhatsNew(current: string, lastSeen: string | null, dev: boolean): boolean {
  return !dev && current !== "" && lastSeen !== null && lastSeen !== current;
}
