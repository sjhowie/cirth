/**
 * Folder search store: query/options, the debounced + cancellable search run, streamed results,
 * and replace-all. Result bookkeeping lives in the pure `SearchResults` model.
 */
import { showDialog } from "../dialogs.svelte";
import { refreshAllDirty, getView, revealPosition } from "../editorHost.svelte";
import { explorer } from "../explorer.svelte";
import { openPath } from "../files";
import {
  cancelSearch,
  isTauri,
  onSearchDone,
  onSearchResult,
  replaceInFolder,
  searchFolder,
  toAppError,
  type SearchItem,
} from "../ipc";
import { notifyError, notifyInfo, reportError } from "../notifications.svelte";
import { tabsStore } from "../tabs.svelte";
import { locateMatch, planReplace, SearchResults } from "./results";

export const DEBOUNCE_MS = 300;

class SearchStore {
  query = $state("");
  replacement = $state("");
  caseSensitive = $state(false);
  wholeWord = $state(false);
  regex = $state(false);
  include = $state("");
  exclude = $state("");
  replaceOpen = $state(false);
  /** Search in flight (no `search://done` yet). */
  searching = $state(false);
  /** Inline error from `search_folder` (e.g. bad regex). */
  error = $state<string | null>(null);
  /** Bumped whenever the model changes; read it to re-render. */
  version = $state(0);
  collapsed = $state<Record<string, boolean>>({});
  results: SearchResults | null = null;
  /** Bumped to ask the panel to focus its query input. */
  focusRequest = $state(0);
  replacing = $state(false);
}

export const search = new SearchStore();

/** The query + options a search runs with; replace must use the ones the results came from. */
interface SearchOptions {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  include: string;
  exclude: string;
}

function currentOptions(): SearchOptions {
  return {
    query: search.query,
    regex: search.regex,
    caseSensitive: search.caseSensitive,
    wholeWord: search.wholeWord,
    include: search.include,
    exclude: search.exclude,
  };
}

function sameOptions(a: SearchOptions, b: SearchOptions): boolean {
  return (
    a.query === b.query &&
    a.regex === b.regex &&
    a.caseSensitive === b.caseSensitive &&
    a.wholeWord === b.wholeWord &&
    a.include === b.include &&
    a.exclude === b.exclude
  );
}

/** Options of the search that produced `search.results`. */
let resultsOptions: SearchOptions | null = null;

let currentId: string | null = null;
let counter = 0;
let debounce: ReturnType<typeof setTimeout> | null = null;
let flushQueued = false;

function bump(): void {
  if (flushQueued) return;
  flushQueued = true;
  const flush = () => {
    flushQueued = false;
    search.version++;
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
  else flush();
}

function stopCurrent(): void {
  const id = currentId;
  currentId = null;
  search.searching = false;
  if (id !== null && isTauri()) cancelSearch(id).catch((e) => console.error("cancel_search", e));
}

/** Cancels any running search and clears results. */
export function clearSearch(): void {
  if (debounce) clearTimeout(debounce);
  debounce = null;
  stopCurrent();
  search.results = null;
  resultsOptions = null;
  search.error = null;
  search.version++;
}

/** Starts a search now (cancelling the previous one). */
export async function runSearch(): Promise<void> {
  if (debounce) clearTimeout(debounce);
  debounce = null;
  const root = explorer.root;
  if (!root || search.query === "") {
    clearSearch();
    return;
  }
  stopCurrent();
  const searchId = `s${Date.now().toString(36)}-${++counter}`;
  currentId = searchId;
  const options = currentOptions();
  resultsOptions = options;
  search.results = new SearchResults(searchId);
  search.collapsed = {};
  search.error = null;
  search.searching = true;
  search.version++;
  try {
    await searchFolder({
      searchId,
      root,
      ...options,
    });
  } catch (e) {
    if (currentId !== searchId) return; // superseded: ignore its error
    currentId = null;
    search.searching = false;
    const err = toAppError(e);
    console.error("search_folder", e);
    search.error = err.message;
    search.version++;
  }
}

/** Debounced runSearch for typing. */
export function scheduleSearch(): void {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => void runSearch(), DEBOUNCE_MS);
}

/** Subscribes to the backend search events. Returns an unsubscribe function. */
export async function listenForSearchEvents(): Promise<() => void> {
  const offResult = await onSearchResult((p) => {
    if (search.results?.addResult(p)) bump();
  });
  const offDone = await onSearchDone((p) => {
    if (search.results?.finish(p)) {
      if (currentId === p.searchId) currentId = null;
      search.searching = false;
      search.version++;
    }
  });
  return () => {
    offResult();
    offDone();
  };
}

/** Opens the file and selects the match (the preview's column is mapped onto the live line). */
export async function openMatch(path: string, item: SearchItem): Promise<void> {
  const tab = await openPath(path);
  if (!tab) return;
  const view = getView();
  if (!view) return;
  const doc = view.state.doc;
  const line = Math.min(Math.max(1, item.line), doc.lines);
  const loc = item.line <= doc.lines ? locateMatch(doc.line(line).text, item) : null;
  if (loc) {
    revealPosition(line, loc.col, loc.len);
  } else {
    notifyInfo("File changed since the search; run it again");
    revealPosition(line, 1, 0);
  }
}

/** True while the results on screen belong to a different query/options than the form shows, or a search is queued. */
export function resultsStale(): boolean {
  return debounce !== null || resultsOptions === null || !sameOptions(resultsOptions, currentOptions());
}

export function canReplaceAll(): boolean {
  const r = search.results;
  return (
    search.replacement !== "" &&
    r !== null &&
    r.finished &&
    r.matches > 0 &&
    !search.searching &&
    !search.replacing &&
    search.error === null &&
    !resultsStale()
  );
}

export async function replaceAll(): Promise<void> {
  const root = explorer.root;
  const results = search.results;
  const options = resultsOptions;
  if (!root || !results || !options) return;
  if (resultsStale()) {
    notifyInfo("The search options changed; wait for the new results before replacing");
    return;
  }
  if (!canReplaceAll()) return;
  refreshAllDirty();
  const plan = planReplace(results, (p) => tabsStore.byPath(p)?.dirty === true);
  if (plan.paths.length === 0) {
    notifyError(
      plan.skipped.length > 0
        ? `All ${plan.skipped.length} matching files have unsaved changes; save them first`
        : "Nothing to replace",
    );
    return;
  }
  const files = plan.paths.length;
  const extra: string[] = [];
  if (plan.skipped.length > 0) extra.push(`${plan.skipped.length} ${plan.skipped.length === 1 ? "file" : "files"} with unsaved changes skipped.`);
  if (results.done?.truncated) extra.push("Results were truncated, so files beyond the cap are not touched.");
  const answer = await showDialog({
    title: `Replace ${plan.occurrences} ${plan.occurrences === 1 ? "occurrence" : "occurrences"} in ${files} ${files === 1 ? "file" : "files"}?`,
    message: [`"${options.query}" will be replaced with "${search.replacement}". This writes the files to disk.`, ...extra].join(" "),
    buttons: [
      { label: "Cancel", value: "cancel" },
      { label: "Replace All", value: "replace", primary: true, danger: true },
    ],
    cancelValue: "cancel",
  });
  if (answer !== "replace") return;
  if (resultsStale() || search.results !== results) {
    notifyInfo("The search changed while the dialog was open; run Replace All again");
    return;
  }
  search.replacing = true;
  try {
    const r = await replaceInFolder({
      root,
      query: options.query,
      replacement: search.replacement,
      regex: options.regex,
      caseSensitive: options.caseSensitive,
      wholeWord: options.wholeWord,
      paths: plan.paths,
    });
    notifyInfo(`Replaced ${r.replacements} ${r.replacements === 1 ? "occurrence" : "occurrences"} in ${r.filesChanged} ${r.filesChanged === 1 ? "file" : "files"}`);
  } catch (e) {
    reportError("Replace in folder", e);
  } finally {
    search.replacing = false;
  }
  await runSearch();
}
