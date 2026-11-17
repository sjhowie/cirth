/**
 * App updates through tauri-plugin-updater: GitHub Releases' latest.json (endpoint in tauri.conf.json), signed installers.
 * Checks a few seconds after startup and every 6 hours in release builds; the status bar offers the update when one exists.
 */
import type { Update } from "@tauri-apps/plugin-updater";
import { showDialog } from "./dialogs.svelte";
import { confirmExit } from "./files";
import { isTauri } from "./ipc";
import { notifyInfo, reportError } from "./notifications.svelte";
import { flushSettings } from "./settings.svelte";

/** "confirming": one of our prompts is open (blocks checks and a second install from the status bar). */
type Phase = "idle" | "checking" | "confirming" | "downloading" | "installing";

class UpdaterStore {
  /** The running version ("" until loaded). */
  version = $state("");
  /** A newer release, once a check found one. */
  available = $state<string | null>(null);
  phase = $state<Phase>("idle");
  /** Download progress 0..1, or null when the size is unknown. */
  progress = $state<number | null>(null);
}

export const updater = new UpdaterStore();

const FIRST_CHECK_MS = 5_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
let pending: Update | null = null;
/** `pending` once its installer has been downloaded (install() can run without downloading again). */
let downloaded: Update | null = null;

/** Rust sets this to false when CIRTH_NO_UPDATE_CHECK=1 (E2E). Dev builds never check. */
function autoCheckEnabled(): boolean {
  return isTauri() && !import.meta.env.DEV && (window as { __CIRTH_UPDATE_CHECK__?: boolean }).__CIRTH_UPDATE_CHECK__ !== false;
}

/** Loads the running version and starts background checks. Returns a stop function. */
export function startUpdater(): () => void {
  if (!isTauri()) return () => {};
  import("@tauri-apps/api/app")
    .then(({ getVersion }) => getVersion())
    .then((v) => (updater.version = v))
    .catch((e) => reportError("Read app version", e));
  if (!autoCheckEnabled()) return () => {};
  const first = setTimeout(() => void checkForUpdate(false), FIRST_CHECK_MS);
  const every = setInterval(() => void checkForUpdate(false), CHECK_EVERY_MS);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

/** `manual`: the user asked, so report "up to date" and errors; background checks only log failures (offline is normal). */
export async function checkForUpdate(manual: boolean): Promise<void> {
  if (!isTauri() || updater.phase !== "idle") return;
  updater.phase = "checking";
  let offer = false;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (update && pending && pending === downloaded && update.version === pending.version) {
      // Keep the handle whose installer is already downloaded; the new one is the same release.
      await update.close().catch((e) => console.warn("Release duplicate update handle", e));
    } else {
      const previous = pending;
      pending = update;
      downloaded = null;
      updater.available = update?.version ?? null;
      if (previous && previous !== update) await previous.close().catch((e) => console.warn("Release old update handle", e));
    }
    offer = manual && pending !== null;
    if (manual && !pending) notifyInfo(`Cirth ${updater.version} is the latest version`);
  } catch (e) {
    if (manual) reportError("Check for updates", e);
    else console.warn("Background update check failed", e);
  } finally {
    if (updater.phase === "checking") updater.phase = "idle";
  }
  // Only now is the phase back to idle, which installUpdate requires.
  if (offer) await installUpdate();
}

/**
 * Asks, downloads (the editor stays usable meanwhile), then settles unsaved files and installs; the
 * installer closes Cirth and reopens it. Unsaved-file handling runs after the download so edits made
 * while it ran are covered. Cancelling that prompt keeps the download and the status-bar offer.
 */
export async function installUpdate(): Promise<void> {
  const update = pending;
  if (!update || updater.phase !== "idle") return;
  updater.phase = "confirming";
  let answer: string;
  try {
    answer = await showDialog({
      title: `Update to Cirth ${update.version}?`,
      message: `You have ${updater.version}. Cirth will download the update, then close, install it and reopen.`,
      buttons: [
        { label: "Update", value: "update", primary: true },
        { label: "Later", value: "later" },
      ],
      cancelValue: "later",
    });
  } finally {
    updater.phase = "idle";
  }
  // A check may have replaced the update while the dialog was open.
  if (answer !== "update" || pending !== update) return;
  if (downloaded !== update && !(await download(update))) return;
  if (pending !== update || updater.phase !== "idle") return;
  updater.phase = "confirming";
  let ok: boolean;
  try {
    ok = await confirmExit();
  } catch (e) {
    reportError("Install update", e);
    ok = false;
  } finally {
    updater.phase = "idle";
  }
  if (!ok || pending !== update) return;
  updater.phase = "installing";
  try {
    await flushSettings();
    await update.install();
    // Windows: the installer has already exited the app. Elsewhere, restart into the new version.
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    updater.phase = "idle";
    reportError("Install update", e);
  }
}

async function download(update: Update): Promise<boolean> {
  updater.phase = "downloading";
  updater.progress = 0;
  let total = 0;
  let received = 0;
  try {
    await update.download((event) => {
      if (event.event === "Started") total = event.data.contentLength ?? 0;
      else if (event.event === "Progress") {
        received += event.data.chunkLength;
        updater.progress = total > 0 ? received / total : null;
      }
    });
    downloaded = update;
    return true;
  } catch (e) {
    reportError("Download update", e);
    return false;
  } finally {
    updater.phase = "idle";
    updater.progress = null;
  }
}
