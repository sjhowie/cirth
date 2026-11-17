import { defaultSettings, isTauri, loadSettings, saveSettings, type Settings } from "./ipc";
import { notifyInfo, reportError } from "./notifications.svelte";

/** The theme setting Rust injected before the page loaded, so the first render already has the right theme. */
function injectedTheme(): Settings["theme"] {
  const t = typeof window === "undefined" ? undefined : (window as { __CIRTH_THEME__?: unknown }).__CIRTH_THEME__;
  return t === "light" || t === "dark" || t === "system" ? t : defaultSettings.theme;
}

export const settings = $state<Settings>({ ...defaultSettings, theme: injectedTheme() });
export const themeState = $state({
  systemDark: typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true,
});

export function isDark(): boolean {
  return settings.theme === "dark" || (settings.theme === "system" && themeState.systemDark);
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function sanitize(s: Settings): Settings {
  return {
    ...s,
    fontSize: Math.min(48, Math.max(8, Number(s.fontSize) || defaultSettings.fontSize)),
    largeFileThresholdMb: Math.max(1, Number(s.largeFileThresholdMb) || defaultSettings.largeFileThresholdMb),
  };
}

/** Loads settings from the backend; keeps defaults (and says so once) outside Tauri. */
export async function initSettings(): Promise<void> {
  if (!isTauri()) {
    notifyInfo("Not running in Tauri: file access, settings persistence and watching are unavailable");
    return;
  }
  try {
    Object.assign(settings, sanitize(await loadSettings()));
  } catch (e) {
    reportError("Load settings", e);
  }
}

/** Applies a partial change live and persists it (debounced so typing in a field is one write). */
export function updateSettings(patch: Partial<Settings>): void {
  Object.assign(settings, sanitize({ ...settings, ...patch }));
  if (!isTauri()) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveSettings({ ...settings }).catch((e) => reportError("Save settings", e));
  }, 400);
}

/** Writes a debounced settings change now (before the window closes or an update installs). Never throws. */
export async function flushSettings(): Promise<void> {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    await saveSettings({ ...settings });
  } catch (e) {
    reportError("Save settings", e);
  }
}
