/**
 * Fuzzy subsequence scorer (fzy-style DP) for the command palette and quick open.
 *
 * Case-insensitive. Bonuses for consecutive matches and for matches at word starts (after
 * `/ \ . _ - space`, at camelCase humps). For paths the basename is matched on its own as well and
 * a basename match gets an extra bonus, so `tab` prefers `a/Tab.ts` over `tab/x.ts`.
 */

export interface FuzzyMatch {
  score: number;
  /** Indices (UTF-16) into the target of the matched characters, ascending. */
  indices: number[];
}

const NEG = -Infinity;
const SCORE_GAP_LEADING = -0.005;
const SCORE_GAP_TRAILING = -0.005;
const SCORE_GAP_INNER = -0.01;
const SCORE_CONSECUTIVE = 1.0;
const BONUS_SLASH = 0.9;
const BONUS_SEPARATOR = 0.8;
const BONUS_CAMEL = 0.7;
/** Added to a basename match so it beats a same-quality match smeared across directories. */
const BASENAME_BONUS = 3;
/** Queries longer than this are not scored (the DP matrix would be pointless). */
const MAX_QUERY = 64;
const MAX_TARGET = 1024;

function boundaryBonus(prev: string, cur: string): number {
  if (prev === "/" || prev === "\\") return BONUS_SLASH;
  if (prev === " " || prev === "-" || prev === "_" || prev === ".") return BONUS_SEPARATOR;
  if (prev >= "a" && prev <= "z" && cur >= "A" && cur <= "Z") return BONUS_CAMEL;
  return 0;
}

// Reused matrices (JS is single-threaded; grown on demand).
let dBuf = new Float64Array(0);
let mBuf = new Float64Array(0);
let bonusBuf = new Float64Array(0);

function ensureBuffers(cells: number, targetLen: number): void {
  if (dBuf.length < cells) {
    dBuf = new Float64Array(cells);
    mBuf = new Float64Array(cells);
  }
  if (bonusBuf.length < targetLen) bonusBuf = new Float64Array(targetLen);
}

function isSubsequence(q: string, lowerTarget: string): boolean {
  let j = 0;
  for (let i = 0; i < q.length; i++) {
    j = lowerTarget.indexOf(q[i], j);
    if (j < 0) return false;
    j++;
  }
  return true;
}

/**
 * Core scorer. `q` must already be lower-case. Returns null when `q` is not a subsequence of `target`.
 * `indices` is only computed when `wantIndices` is set.
 */
function scoreLower(q: string, target: string, lower: string, wantIndices: boolean): FuzzyMatch | null {
  const n = q.length;
  const m = target.length;
  if (n === 0) return { score: 0, indices: [] };
  if (n > MAX_QUERY || m > MAX_TARGET || n > m) return null;
  if (!isSubsequence(q, lower)) return null;

  ensureBuffers(n * m, m);
  for (let j = 0; j < m; j++) bonusBuf[j] = j === 0 ? BONUS_SLASH : boundaryBonus(target[j - 1], target[j]);

  for (let i = 0; i < n; i++) {
    let prevScore = NEG;
    const gap = i === n - 1 ? SCORE_GAP_TRAILING : SCORE_GAP_INNER;
    const qc = q.charCodeAt(i);
    const row = i * m;
    for (let j = 0; j < m; j++) {
      if (qc === lower.charCodeAt(j)) {
        let score = NEG;
        if (i === 0) score = j * SCORE_GAP_LEADING + bonusBuf[j];
        else if (j > 0) {
          const diag = (i - 1) * m + (j - 1);
          score = Math.max(mBuf[diag] + bonusBuf[j], dBuf[diag] + SCORE_CONSECUTIVE);
        }
        dBuf[row + j] = score;
        prevScore = Math.max(score, prevScore + gap);
        mBuf[row + j] = prevScore;
      } else {
        dBuf[row + j] = NEG;
        prevScore = prevScore + gap;
        mBuf[row + j] = prevScore;
      }
    }
  }

  const best = mBuf[(n - 1) * m + (m - 1)];
  if (best === NEG) return null;
  if (!wantIndices) return { score: best, indices: [] };

  const indices = new Array<number>(n);
  let matchRequired = false;
  let j = m - 1;
  for (let i = n - 1; i >= 0; i--) {
    for (; j >= 0; j--) {
      const d = dBuf[i * m + j];
      if (d !== NEG && (matchRequired || d === mBuf[i * m + j])) {
        matchRequired = i > 0 && j > 0 && mBuf[i * m + j] === dBuf[(i - 1) * m + (j - 1)] + SCORE_CONSECUTIVE;
        indices[i] = j;
        j--;
        break;
      }
    }
  }
  return { score: best, indices };
}

function baseStart(path: string): number {
  return Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
}

function matchLower(q: string, target: string, isPath: boolean, wantIndices: boolean): FuzzyMatch | null {
  const lower = target.toLowerCase();
  if (lower.length !== target.length) return null; // exotic characters whose lower-case changes length
  const full = scoreLower(q, target, lower, wantIndices);
  if (!isPath) return full;
  const bs = baseStart(target);
  if (bs === 0) return full === null ? null : { score: full.score + BASENAME_BONUS, indices: full.indices };
  if (full === null) return null; // not a subsequence of the whole path, so not of the basename either
  const base = scoreLower(q, target.slice(bs), lower.slice(bs), wantIndices);
  if (base === null) return full;
  const candidate: FuzzyMatch = {
    score: base.score + BASENAME_BONUS,
    indices: wantIndices ? base.indices.map((i) => i + bs) : [],
  };
  return full.score > candidate.score ? full : candidate;
}

export interface FuzzyOptions {
  /** Treat `target` as a path: `/` and `\` separate segments and the basename is preferred. */
  path?: boolean;
}

/** Match one target. Returns null when `query` is not a case-insensitive subsequence of it. */
export function fuzzyMatch(query: string, target: string, opts: FuzzyOptions = {}): FuzzyMatch | null {
  return matchLower(query.toLowerCase(), target, opts.path === true, true);
}

export interface Ranked<T> {
  item: T;
  score: number;
  indices: number[];
}

export interface FilterOptions<T> extends FuzzyOptions {
  /** Keep only the best `limit` results (all when omitted). */
  limit?: number;
  /** Added to an item's score (recent / open items rank higher). */
  boost?: (item: T) => number;
}

/**
 * Filters and ranks `items` by `query`; best first, ties broken by shorter text. Indices are only
 * computed for the returned results, so 50 000 paths stay cheap.
 */
export function fuzzyFilter<T>(items: readonly T[], query: string, getText: (item: T) => string, opts: FilterOptions<T> = {}): Ranked<T>[] {
  const q = query.toLowerCase();
  const isPath = opts.path === true;
  type Scored = { item: T; score: number; len: number };
  const better = (a: Scored, b: Scored) => a.score > b.score || (a.score === b.score && a.len < b.len);
  const limit = opts.limit;
  // Keeps only the best `limit` entries (binary insertion) so a query matching all 50 000 paths never sorts them all.
  const top: Scored[] = [];
  for (const item of items) {
    const text = getText(item);
    const r = matchLower(q, text, isPath, false);
    if (!r) continue;
    const entry: Scored = { item, score: r.score + (opts.boost?.(item) ?? 0), len: text.length };
    if (limit !== undefined && top.length >= limit && !better(entry, top[top.length - 1])) continue;
    let lo = 0;
    let hi = top.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (better(top[mid], entry)) lo = mid + 1;
      else hi = mid;
    }
    top.splice(lo, 0, entry);
    if (limit !== undefined && top.length > limit) top.pop();
  }
  return top.map((s) => ({
    item: s.item,
    score: s.score,
    indices: matchLower(q, getText(s.item), isPath, true)?.indices ?? [],
  }));
}

export interface Segment {
  text: string;
  hit: boolean;
}

/** Splits `text` (a slice of the matched target starting at `offset`) into hit / non-hit runs. */
export function highlightSegments(text: string, indices: readonly number[], offset = 0): Segment[] {
  const hits = new Set<number>();
  for (const i of indices) if (i >= offset && i < offset + text.length) hits.add(i - offset);
  const out: Segment[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(i);
    const last = out[out.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else out.push({ text: text[i], hit });
  }
  return out;
}
