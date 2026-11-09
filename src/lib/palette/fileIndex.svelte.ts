/**
 * Cached `list_files` result for the open folder. Invalidated (not dropped) on `fs://changed`:
 * the stale list keeps serving while the next palette open refreshes it in the background.
 */
import { isTauri, listFiles, onFsChanged } from "../ipc";
import { reportError } from "../notifications.svelte";
import { samePath } from "../paths";

class FileIndex {
  root = $state<string | null>(null);
  files = $state.raw<string[]>([]);
  truncated = $state(false);
  loading = $state(false);
  stale = true;
  inFlight: Promise<void> | null = null;
}

export const fileIndex = new FileIndex();

/** Marks the cache stale; the next ensureFileIndex() refetches. */
export function invalidateFileIndex(): void {
  fileIndex.stale = true;
}

/** Loads (or refreshes when stale / the root changed) the file list for `root`. Errors are reported, not thrown. */
export async function ensureFileIndex(root: string | null): Promise<void> {
  if (root === null || !isTauri()) {
    fileIndex.root = root;
    fileIndex.files = [];
    fileIndex.truncated = false;
    return;
  }
  const rootChanged = fileIndex.root === null || !samePath(fileIndex.root, root);
  if (rootChanged) {
    fileIndex.root = root;
    fileIndex.files = [];
    fileIndex.truncated = false;
    fileIndex.stale = true;
  }
  if (!fileIndex.stale) return;
  if (fileIndex.inFlight) return fileIndex.inFlight;
  fileIndex.stale = false;
  fileIndex.loading = true;
  const request = (async () => {
    try {
      const result = await listFiles(root);
      // The user may have opened another folder while this ran.
      if (fileIndex.root !== null && samePath(fileIndex.root, root)) {
        fileIndex.files = result.files;
        fileIndex.truncated = result.truncated;
      }
    } catch (e) {
      fileIndex.stale = true;
      reportError("List files", e);
    } finally {
      fileIndex.loading = false;
      fileIndex.inFlight = null;
    }
  })();
  fileIndex.inFlight = request;
  return request;
}

/** Subscribes to `fs://changed` to invalidate the cache. Returns an unsubscribe function. */
export async function watchFileIndex(): Promise<() => void> {
  return onFsChanged(() => invalidateFileIndex());
}
