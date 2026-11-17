/** Open state for Help > About Cirth and Help > What's New, plus the once-per-version What's New at startup. */
import { shouldShowWhatsNew } from "./changelog";

class HelpDialogsStore {
  aboutOpen = $state(false);
  changelogOpen = $state(false);
}

export const helpDialogs = new HelpDialogsStore();

export function openAbout(): void {
  helpDialogs.changelogOpen = false;
  helpDialogs.aboutOpen = true;
}

export function openChangelog(): void {
  helpDialogs.aboutOpen = false;
  helpDialogs.changelogOpen = true;
}

const LAST_SEEN_KEY = "cirth.lastSeenVersion";
let startupChecked = false;

/** Call once the running version is known. Records it, and opens What's New if it changed since the last run. */
export function showWhatsNewIfUpdated(version: string): void {
  if (startupChecked || version === "" || import.meta.env.DEV) return;
  startupChecked = true;
  let lastSeen: string | null = null;
  try {
    lastSeen = localStorage.getItem(LAST_SEEN_KEY);
    if (lastSeen !== version) localStorage.setItem(LAST_SEEN_KEY, version);
  } catch (e) {
    console.warn("What's New: localStorage unavailable", e);
    return;
  }
  if (shouldShowWhatsNew(version, lastSeen, import.meta.env.DEV)) openChangelog();
}
