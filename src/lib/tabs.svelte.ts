import type { EditorState, Text } from "@codemirror/state";
import type { Eol } from "./ipc";
import { samePath } from "./paths";

export interface Tab {
  id: number;
  path: string | null;
  title: string;
  /** Authoritative only while the tab is inactive; use getTabState() from editorHost. */
  state: EditorState;
  encoding: string;
  bom: boolean;
  eol: Eol;
  savedDoc: Text;
  dirty: boolean;
  /** Encoding/EOL changed since the last save (counts as dirty). */
  metaChanged: boolean;
  languageName: string;
  largeFile: boolean;
  scrollTop: number;
  /** File changed on disk while the tab has unsaved edits (shows the banner). */
  diskChanged: boolean;
  /** File no longer exists on disk (still saveable). */
  deleted: boolean;
}

class TabsStore {
  tabs = $state<Tab[]>([]);
  activeId = $state<number | null>(null);
  private nextId = 1;
  private untitledCount = 0;

  get active(): Tab | null {
    return this.tabs.find((t) => t.id === this.activeId) ?? null;
  }

  newId(): number {
    return this.nextId++;
  }

  nextUntitledTitle(): string {
    this.untitledCount += 1;
    return `Untitled-${this.untitledCount}`;
  }

  byId(id: number): Tab | undefined {
    return this.tabs.find((t) => t.id === id);
  }

  byPath(path: string): Tab | undefined {
    return this.tabs.find((t) => t.path !== null && samePath(t.path, path));
  }

  /** Adds a tab and returns the reactive (proxied) instance; always mutate that one. */
  add(tab: Tab): Tab {
    this.tabs.push(tab);
    return this.tabs[this.tabs.length - 1];
  }

  remove(id: number): void {
    this.tabs = this.tabs.filter((t) => t.id !== id);
  }
}

export const tabsStore = new TabsStore();
