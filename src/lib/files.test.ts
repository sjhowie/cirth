import { Text } from "@codemirror/state";
import { beforeEach, describe, expect, it, vi } from "vitest";

// files.ts depends on runes modules (*.svelte.ts) that vitest doesn't compile; replace them with plain fakes.
interface FakeTab {
  id: number;
  path: string | null;
  title: string;
  doc: Text;
  savedDoc: Text;
  dirty: boolean;
  metaChanged: boolean;
  encoding: string;
  bom: boolean;
  eol: string;
  deleted: boolean;
  diskChanged: boolean;
  lossy: string | null;
}

const store = vi.hoisted(() => {
  const s = {
    tabs: [] as FakeTab[],
    activeId: null as number | null,
    get active() {
      return s.tabs.find((t) => t.id === s.activeId) ?? null;
    },
    byId: (id: number) => s.tabs.find((t) => t.id === id),
    byPath: (p: string) => s.tabs.find((t) => t.path === p),
    remove: (id: number) => {
      s.tabs = s.tabs.filter((t) => t.id !== id);
    },
  };
  return s;
});

const dialog = vi.hoisted(() => ({ answers: [] as Array<(v: string) => void>, specs: [] as Array<{ title: string }> }));
const writeFileMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("./tabs.svelte", () => ({ tabsStore: store }));
vi.mock("./editorHost.svelte", () => ({
  activateTab: (id: number) => (store.activeId = id),
  getTabDoc: (t: FakeTab) => t.doc,
  makeTabState: vi.fn(),
  recomputeDirty: (t: FakeTab) => (t.dirty = t.metaChanged || !t.doc.eq(t.savedDoc)),
  removeTab: (id: number) => store.remove(id),
  setTabLanguageExtension: vi.fn(),
}));
vi.mock("./dialogs.svelte", () => ({
  showDialog: (spec: { title: string }) =>
    new Promise<string>((resolve) => {
      dialog.specs.push(spec);
      dialog.answers.push(resolve);
    }),
}));
vi.mock("./editor/languages", () => ({ PLAIN_TEXT: "Plain Text", detectLanguageName: () => "Plain Text", loadLanguageExtension: vi.fn() }));
vi.mock("./explorer.svelte", () => ({ setRoot: vi.fn() }));
vi.mock("./notifications.svelte", () => ({ notifyError: vi.fn(), notifyInfo: vi.fn(), reportError: vi.fn() }));
vi.mock("./settings.svelte", () => ({ settings: { largeFileThresholdMb: 10 } }));
vi.mock("./watch.svelte", () => ({ noteOwnWrite: vi.fn() }));
vi.mock("./ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ipc")>()),
  isTauri: () => true,
  writeFile: writeFileMock,
}));

import { closeTab, saveTab } from "./files";
import type { Tab } from "./tabs.svelte";

const flush = () => new Promise((r) => setTimeout(r, 0));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

function addTab(text: string, saved = text, lossy: string | null = null): FakeTab {
  const tab: FakeTab = {
    id: store.tabs.length + 1,
    path: `C:/t/${store.tabs.length + 1}.txt`,
    title: `${store.tabs.length + 1}.txt`,
    doc: Text.of(text.split("\n")),
    savedDoc: Text.of(saved.split("\n")),
    dirty: text !== saved,
    metaChanged: false,
    encoding: "utf-8",
    bom: false,
    eol: "lf",
    deleted: false,
    diskChanged: false,
    lossy,
  };
  store.tabs.push(tab);
  store.activeId = tab.id;
  return tab;
}

const asTab = (t: FakeTab) => t as unknown as Tab;
const writtenText = (call: number) => (writeFileMock.mock.calls[call][1] as Text).toString();

beforeEach(() => {
  store.tabs = [];
  store.activeId = null;
  dialog.answers = [];
  dialog.specs = [];
  writeFileMock.mockReset();
  writeFileMock.mockResolvedValue({ size: 1 });
});

describe("closeTab", () => {
  it("joins a second close request for the same tab instead of prompting twice", async () => {
    const tab = addTab("edited", "original");
    const first = closeTab(tab.id);
    const second = closeTab(tab.id);
    await flush();
    expect(dialog.answers).toHaveLength(1);
    dialog.answers[0]("save");
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(writtenText(0)).toBe("edited");
    expect(store.tabs).toHaveLength(0);
  });

  it("does not save a tab that was closed while its prompt was open", async () => {
    const tab = addTab("edited", "original");
    const closing = closeTab(tab.id);
    await flush();
    store.remove(tab.id);
    dialog.answers[0]("save");
    expect(await closing).toBe(true);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("Cancel keeps the tab", async () => {
    const tab = addTab("edited", "original");
    const closing = closeTab(tab.id);
    await flush();
    dialog.answers[0]("cancel");
    expect(await closing).toBe(false);
    expect(store.tabs).toHaveLength(1);
  });
});

describe("saveTab", () => {
  it("runs saves of one tab one at a time, so the newest text lands last", async () => {
    const tab = addTab("v1", "v0");
    const firstWrite = deferred<{ size: number }>();
    writeFileMock.mockReturnValueOnce(firstWrite.promise);
    const s1 = saveTab(asTab(tab));
    await flush();
    tab.doc = Text.of(["v2"]);
    const s2 = saveTab(asTab(tab));
    await flush();
    expect(writeFileMock).toHaveBeenCalledTimes(1); // the second waits for the first
    firstWrite.resolve({ size: 2 });
    expect(await s1).toBe(true);
    expect(await s2).toBe(true);
    expect(writeFileMock).toHaveBeenCalledTimes(2);
    expect(writtenText(0)).toBe("v1");
    expect(writtenText(1)).toBe("v2");
    expect(tab.savedDoc.toString()).toBe("v2");
    expect(tab.dirty).toBe(false);
  });

  it("a failed save does not block the next one", async () => {
    const tab = addTab("v1", "v0");
    writeFileMock.mockRejectedValueOnce({ kind: "io", message: "disk full" });
    expect(await saveTab(asTab(tab))).toBe(false);
    expect(await saveTab(asTab(tab))).toBe(true);
    expect(tab.savedDoc.toString()).toBe("v1");
  });

  it("asks before saving a lossy tab; Cancel writes nothing", async () => {
    const tab = addTab("a\uFFFD", "a\uFFFD", "UTF-8");
    const saving = saveTab(asTab(tab));
    await flush();
    expect(dialog.specs[0].title).toMatch(/replacement characters/);
    dialog.answers[0]("cancel");
    expect(await saving).toBe(false);
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(tab.lossy).toBe("UTF-8");
  });

  it("Save anyway writes and clears the notice; later saves don't ask again", async () => {
    const tab = addTab("a\uFFFD", "a\uFFFD", "UTF-8");
    const saving = saveTab(asTab(tab));
    await flush();
    dialog.answers[0]("save");
    expect(await saving).toBe(true);
    expect(tab.lossy).toBeNull();
    expect(await saveTab(asTab(tab))).toBe(true);
    expect(dialog.specs).toHaveLength(1);
    expect(writeFileMock).toHaveBeenCalledTimes(2);
  });

  it("two saves of a lossy tab share one prompt", async () => {
    const tab = addTab("a\uFFFD", "a\uFFFD", "UTF-8");
    const s1 = saveTab(asTab(tab));
    const s2 = saveTab(asTab(tab));
    await flush();
    expect(dialog.answers).toHaveLength(1);
    dialog.answers[0]("save");
    expect([await s1, await s2]).toEqual([true, true]);
  });
});
