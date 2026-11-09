/** Palette open/closed state and the recently used commands / files (persisted best-effort). */
import { pushRecent } from "./input";

export const palette = $state({ open: false, input: "" });

/** Opens the palette with `prefix` in the input: ">" commands, "" files, ":" go to line. Re-opening just switches mode. */
export function openPalette(prefix: ">" | "" | ":" = ""): void {
  palette.input = prefix;
  palette.open = true;
}

export function closePalette(): void {
  palette.open = false;
}

const COMMANDS_KEY = "simpleeditor.recentCommands";
const FILES_KEY = "simpleeditor.recentFiles";

function load(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch (e) {
    console.error(`Load ${key}`, e);
    return [];
  }
}

function save(key: string, list: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch (e) {
    console.error(`Save ${key}`, e);
  }
}

export const recents = $state({ commands: load(COMMANDS_KEY), files: load(FILES_KEY) });

export function recordCommand(id: string): void {
  recents.commands = pushRecent(recents.commands, id, 30);
  save(COMMANDS_KEY, recents.commands);
}

export function recordFile(path: string): void {
  if (recents.files[0] === path) return;
  recents.files = pushRecent(recents.files, path, 50);
  save(FILES_KEY, recents.files);
}
