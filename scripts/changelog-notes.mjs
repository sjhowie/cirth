// Reads CHANGELOG.md (format: see the file's own header; "## Unreleased" then "## X.Y.Z - YYYY-MM-DD", newest first).
//   node scripts/changelog-notes.mjs X.Y.Z [path]   prints that version's sections as markdown; exits 1 when it has no entry.
// The pure functions are shared with release.mjs (preflight and the Unreleased -> version rename).
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isItem = (line) => /^\s*[-*] \S/.test(line);

/** Lines of the "## <heading>" section (exact heading text, or "<heading> - <anything>"), without the heading; null when absent. */
function sectionLines(text, heading) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^## ${escapeRe(heading)}(?: - .*)?\\s*$`).test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

/** Number of bullet items under "## Unreleased" (0 when the section is missing or empty). */
export function unreleasedItemCount(text) {
  return (sectionLines(text, 'Unreleased') ?? []).filter(isItem).length;
}

/** The markdown under "## <version> - date" (the ### New / Improved / Fixed sections), or null when absent or empty. */
export function notesFor(text, version) {
  const lines = sectionLines(text, version);
  if (!lines || !lines.some(isItem)) return null;
  return lines.join('\n').trim();
}

/** Renames "## Unreleased" to "## <version> - <date>". Throws when Unreleased is missing or has no items, or the version already has an entry. */
export function stampUnreleased(text, version, date) {
  if (unreleasedItemCount(text) === 0) throw new Error('CHANGELOG.md has no "## Unreleased" section with items');
  if (sectionLines(text, version) !== null) throw new Error(`CHANGELOG.md already has an entry for ${version}`);
  return text.replace(/^## Unreleased[ \t]*$/m, `## ${version} - ${date}`);
}

/** Local date as YYYY-MM-DD. */
export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, file = join(ROOT, 'CHANGELOG.md')] = process.argv.slice(2);
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    console.error('usage: node scripts/changelog-notes.mjs X.Y.Z [path]');
    process.exit(2);
  }
  const notes = notesFor(readFileSync(file, 'utf8'), version);
  if (notes === null) {
    console.error(`changelog-notes: ${file} has no entry with items for ${version}`);
    process.exit(1);
  }
  console.log(notes);
}
