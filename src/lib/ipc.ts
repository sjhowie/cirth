/**
 * Typed wrappers for every command and event in docs/ipc.md.
 * Every wrapper throws an `AppError` (never a bare string); callers must handle it explicitly.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ---------- errors ----------

export type AppErrorKind =
  | "io"
  | "encoding"
  | "parse"
  | "notFound"
  | "invalidArg"
  | "cancelled"
  /** Frontend-only: the Tauri runtime is not present (plain browser). */
  | "unavailable";

export interface AppError {
  kind: AppErrorKind;
  message: string;
  line?: number;
  col?: number;
}

const errorKinds: readonly string[] = ["io", "encoding", "parse", "notFound", "invalidArg", "cancelled", "unavailable"];

export function isAppError(e: unknown): e is AppError {
  if (typeof e !== "object" || e === null) return false;
  const o = e as Record<string, unknown>;
  return typeof o.kind === "string" && errorKinds.includes(o.kind) && typeof o.message === "string";
}

/** Normalises anything thrown by `invoke` (AppError JSON, string, Error) into an AppError. */
export function toAppError(e: unknown): AppError {
  if (isAppError(e)) return e;
  if (e instanceof Error) return { kind: "io", message: e.message };
  if (typeof e === "string") return { kind: "io", message: e };
  return { kind: "io", message: "Unknown error" };
}

export function isTauri(): boolean {
  return typeof globalThis !== "undefined" && "__TAURI_INTERNALS__" in globalThis;
}

function ensureTauri(): void {
  if (!isTauri()) {
    const err: AppError = { kind: "unavailable", message: "Not running in Tauri: this action needs the desktop app" };
    throw err;
  }
}

// ---------- low-level calls ----------

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  ensureTauri();
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

async function callRaw<T>(cmd: string, body: Uint8Array, headers: Record<string, string>): Promise<T> {
  ensureTauri();
  try {
    return await invoke<T>(cmd, body, { headers });
  } catch (e) {
    throw toAppError(e);
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

// ---------- files ----------

export type Eol = "lf" | "crlf";

export interface FileMeta {
  encoding: string;
  bom: boolean;
  eol: Eol;
  size: number;
}

export interface ReadFileResult {
  meta: FileMeta;
  text: string;
}

/** Parses `[u32 LE metaLen][meta JSON][text]`. */
export function parseReadFileResponse(buf: ArrayBuffer): ReadFileResult {
  if (buf.byteLength < 4) throw { kind: "io", message: "Malformed read_file response (too short)" } satisfies AppError;
  const metaLen = new DataView(buf).getUint32(0, true);
  if (4 + metaLen > buf.byteLength) {
    throw { kind: "io", message: "Malformed read_file response (meta length out of range)" } satisfies AppError;
  }
  const meta = JSON.parse(decoder.decode(new Uint8Array(buf, 4, metaLen))) as FileMeta;
  const text = decoder.decode(new Uint8Array(buf, 4 + metaLen));
  return { meta, text };
}

export async function readFile(path: string): Promise<ReadFileResult> {
  const buf = await call<ArrayBuffer>("read_file", { path });
  try {
    return parseReadFileResponse(buf);
  } catch (e) {
    throw toAppError(e);
  }
}

export interface WriteOptions {
  encoding: string;
  bom: boolean;
  eol: Eol;
}

export function buildWriteHeaders(path: string, opts: WriteOptions): Record<string, string> {
  return {
    "x-path": encodeURIComponent(path),
    "x-encoding": opts.encoding,
    "x-bom": opts.bom ? "1" : "0",
    "x-eol": opts.eol,
  };
}

export async function writeFile(path: string, text: string, opts: WriteOptions): Promise<{ size: number }> {
  return callRaw<{ size: number }>("write_file", encoder.encode(text), buildWriteHeaders(path, opts));
}

// ---------- formatting ----------

export type FormatMode = "pretty" | "minify";
export type FormatIndent = "2" | "4" | "tab";
export type FormatKind = "json" | "xml";

export function buildFormatHeaders(mode: FormatMode, indent: FormatIndent): Record<string, string> {
  return { "x-mode": mode, "x-indent": indent };
}

export async function formatText(kind: FormatKind, text: string, mode: FormatMode, indent: FormatIndent): Promise<string> {
  const cmd = kind === "json" ? "format_json" : "format_xml";
  const buf = await callRaw<ArrayBuffer>(cmd, encoder.encode(text), buildFormatHeaders(mode, indent));
  return decoder.decode(buf);
}

// ---------- folder tree and file operations ----------

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export const listDir = (path: string) => call<DirEntry[]>("list_dir", { path });

export interface ListFilesResult {
  files: string[];
  truncated: boolean;
}
export const listFiles = (root: string) => call<ListFilesResult>("list_files", { root });
export const createFile = (path: string) => call<void>("create_file", { path });
export const createDir = (path: string) => call<void>("create_dir", { path });
export const renamePath = (from: string, to: string) => call<void>("rename_path", { from, to });
export const trashPath = (path: string) => call<void>("trash_path", { path });
export const getStartupPaths = () => call<string[]>("get_startup_paths", {});

// ---------- watching ----------

export const watchPaths = (paths: string[]) => call<void>("watch_paths", { paths });

export interface FsChangedPayload {
  paths: string[];
}

async function listenTo<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  ensureTauri();
  try {
    return await listen<T>(event, (e) => handler(e.payload));
  } catch (e) {
    throw toAppError(e);
  }
}

export const onFsChanged = (handler: (payload: FsChangedPayload) => void) =>
  listenTo<FsChangedPayload>("fs://changed", handler);

// ---------- folder search / replace ----------

export interface SearchParams {
  searchId: string;
  root: string;
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  include: string;
  exclude: string;
}

export interface SearchItem {
  line: number;
  col: number;
  preview: string;
  matchLen: number;
}

export interface SearchResultPayload {
  searchId: string;
  path: string;
  items: SearchItem[];
}

export interface SearchDonePayload {
  searchId: string;
  files: number;
  matches: number;
  truncated: boolean;
  cancelled: boolean;
}

export interface ReplaceParams {
  root: string;
  query: string;
  replacement: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  paths: string[];
}

export const searchFolder = (params: SearchParams) => call<void>("search_folder", { ...params });
export const cancelSearch = (searchId: string) => call<void>("cancel_search", { searchId });
export const replaceInFolder = (params: ReplaceParams) =>
  call<{ filesChanged: number; replacements: number }>("replace_in_folder", { ...params });
export const onSearchResult = (handler: (payload: SearchResultPayload) => void) =>
  listenTo<SearchResultPayload>("search://result", handler);
export const onSearchDone = (handler: (payload: SearchDonePayload) => void) =>
  listenTo<SearchDonePayload>("search://done", handler);

// ---------- settings ----------

export type ThemeSetting = "system" | "light" | "dark";

export interface Settings {
  theme: ThemeSetting;
  fontFamily: string;
  fontSize: number;
  indent: FormatIndent;
  largeFileThresholdMb: number;
  wordWrap: boolean;
}

export const defaultSettings: Settings = {
  theme: "system",
  fontFamily: "Cascadia Code, Consolas, Menlo, monospace",
  fontSize: 14,
  indent: "2",
  largeFileThresholdMb: 10,
  wordWrap: false,
};

export const loadSettings = () => call<Settings>("load_settings", {});
export const saveSettings = (settings: Settings) => call<void>("save_settings", { settings });
