<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { listCommands, onCommandsChanged, runCommand, type Command } from "#lib/commands.js";
  import { activateTab, getView, revealPosition, status } from "#lib/editorHost.svelte.js";
  import { explorer } from "#lib/explorer.svelte.js";
  import { openPath } from "#lib/files.js";
  import { formatBinding } from "#lib/keybindings.js";
  import { isMac } from "#lib/platform.js";
  import { tabsStore } from "#lib/tabs.svelte.js";
  import { normPath } from "#lib/paths.js";
  import { relativeTo } from "#lib/search/results.js";
  import { buildCandidates, candidatePath, type FileCandidate } from "#lib/palette/candidates.js";
  import { ensureFileIndex, fileIndex } from "#lib/palette/fileIndex.svelte.js";
  import { fuzzyFilter, highlightSegments, type Segment } from "#lib/palette/fuzzy.js";
  import { parsePaletteInput } from "#lib/palette/input.js";
  import { closePalette, palette, recents, recordCommand, recordFile } from "#lib/palette/state.svelte.js";

  const MAX_ROWS = 200;

  interface Row {
    key: string;
    kind: "command" | "file" | "goto" | "note";
    /** Primary text segments (command label / file basename / goto text). */
    name: Segment[];
    /** Dim secondary text (file dir). */
    dir?: Segment[];
    category?: string;
    shortcut?: string;
    tag?: string;
    /** Notes cannot be picked. */
    pick?: () => void | Promise<void>;
  }

  let listEl = $state<HTMLDivElement | null>(null);
  let selected = $state(0);
  let commandsVersion = $state(0);

  onMount(() => onCommandsChanged(() => commandsVersion++));

  // Recently opened files: remember whichever file becomes active.
  $effect(() => {
    const p = tabsStore.active?.path;
    if (p) untrack(() => recordFile(p));
  });

  // On open: refresh the (possibly stale) file list.
  $effect(() => {
    if (palette.open) untrack(() => void ensureFileIndex(explorer.root));
  });

  /** Focuses the input the moment it mounts (before the user can type), caret at the end. */
  function focusOnMount(node: HTMLInputElement): void {
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }

  const parsed = $derived(parsePaletteInput(palette.input));

  function shortcutOf(c: Command): string {
    const k = c.keys?.[0] ?? c.hintKeys?.[0];
    return k ? formatBinding(k, isMac) : "";
  }

  function recentCommandBoost(id: string): number {
    const i = recents.commands.indexOf(id);
    return i < 0 ? 0 : Math.max(0.5, 3 - i * 0.1);
  }

  const commandRows = $derived.by((): Row[] => {
    void commandsVersion;
    if (parsed.mode !== "command") return [];
    const cmds = listCommands();
    const toRow = (c: Command, indices: number[]): Row => ({
      key: c.id,
      kind: "command",
      name: highlightSegments(c.label, indices),
      category: c.category,
      shortcut: shortcutOf(c),
      pick: async () => {
        recordCommand(c.id);
        await runCommand(c.id);
      },
    });
    if (parsed.query === "") {
      const rank = (c: Command) => {
        const i = recents.commands.indexOf(c.id);
        return i < 0 ? Number.MAX_SAFE_INTEGER : i;
      };
      return [...cmds]
        .sort((a, b) => rank(a) - rank(b) || a.category.localeCompare(b.category) || a.label.localeCompare(b.label))
        .slice(0, MAX_ROWS)
        .map((c) => toRow(c, []));
    }
    return fuzzyFilter(cmds, parsed.query, (c) => c.label, { limit: MAX_ROWS, boost: (c) => recentCommandBoost(c.id) }).map((r) =>
      toRow(r.item, r.indices),
    );
  });

  // Candidates depend on the file list and open tabs only, not on the query.
  const candidates = $derived(
    buildCandidates(
      explorer.root,
      fileIndex.files,
      tabsStore.tabs.map((t) => ({ id: t.id, path: t.path, title: t.title })),
    ),
  );

  const recentRel = $derived.by((): Map<string, number> => {
    const map = new Map<string, number>();
    const root = explorer.root;
    recents.files.forEach((p, i) => {
      const rel = root ? relativeTo(root, p) : p;
      map.set(normPath(rel), Math.max(0.5, 1.5 - i * 0.05));
    });
    return map;
  });

  function fileRow(c: FileCandidate, indices: number[]): Row {
    const bs = Math.max(c.text.lastIndexOf("/"), c.text.lastIndexOf("\\")) + 1;
    return {
      key: `${c.tabId ?? "f"}:${c.text}`,
      kind: "file",
      name: highlightSegments(c.text.slice(bs), indices, bs),
      dir: bs > 0 ? highlightSegments(c.text.slice(0, bs - 1), indices, 0) : undefined,
      tag: c.tabId !== null ? "open" : undefined,
      pick: async () => {
        if (c.tabId !== null) {
          activateTab(c.tabId);
          return;
        }
        const abs = candidatePath(explorer.root, c);
        if (abs) await openPath(abs);
      },
    };
  }

  const fileRows = $derived.by((): Row[] => {
    if (parsed.mode !== "file") return [];
    if (parsed.query === "") {
      const tabs = candidates.filter((c) => c.tabId !== null);
      const byRel = new Map<string, FileCandidate>();
      for (const c of candidates) if (c.tabId === null) byRel.set(normPath(c.text), c);
      const recentList: FileCandidate[] = [];
      for (const p of recents.files) {
        const rel = explorer.root ? relativeTo(explorer.root, p) : p;
        const hit = byRel.get(normPath(rel));
        if (hit) {
          recentList.push(hit);
          byRel.delete(normPath(rel));
        }
      }
      const rest = candidates.filter((c) => c.tabId === null && byRel.has(normPath(c.text)));
      return [...tabs, ...recentList, ...rest].slice(0, MAX_ROWS).map((c) => fileRow(c, []));
    }
    const useRecent = recentRel.size > 0;
    return fuzzyFilter(candidates, parsed.query, (c) => c.text, {
      path: true,
      limit: MAX_ROWS,
      boost: (c) => (c.tabId !== null ? 2 : useRecent ? (recentRel.get(normPath(c.text)) ?? 0) : 0),
    }).map((r) => fileRow(r.item, r.indices));
  });

  const gotoRows = $derived.by((): Row[] => {
    if (parsed.mode !== "goto") return [];
    if (!tabsStore.active) return [{ key: "note", kind: "note", name: [{ text: "Open a file to go to a line", hit: false }] }];
    const t = parsed.target;
    if (!t) {
      return [
        {
          key: "note",
          kind: "note",
          name: [{ text: `Type a line number (:120 or :120:5). Current line ${status.line} of ${status.lines}`, hit: false }],
        },
      ];
    }
    const clamped = Math.min(t.line, status.lines);
    const text = `Go to line ${clamped}${t.col !== null ? `, column ${t.col}` : ""}${t.line > status.lines ? ` (last line)` : ""}`;
    return [
      {
        key: "goto",
        kind: "goto",
        name: [{ text, hit: false }],
        pick: () => {
          revealPosition(t.line, t.col ?? 1, 0);
        },
      },
    ];
  });

  const rows = $derived<Row[]>(parsed.mode === "command" ? commandRows : parsed.mode === "goto" ? gotoRows : fileRows);

  // New results: selection back to the top.
  $effect(() => {
    void palette.input;
    selected = 0;
  });

  // Keep the selected row visible.
  $effect(() => {
    void selected;
    void rows;
    untrack(() => listEl?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }));
  });

  function close(): void {
    closePalette();
    getView()?.focus();
  }

  async function pickRow(row: Row | undefined): Promise<void> {
    if (!row?.pick) return;
    close();
    await row.pick();
  }

  function move(delta: number): void {
    if (rows.length === 0) return;
    selected = Math.min(rows.length - 1, Math.max(0, selected + delta));
  }

  function onKeydown(e: KeyboardEvent): void {
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "PageDown":
        e.preventDefault();
        move(8);
        break;
      case "PageUp":
        e.preventDefault();
        move(-8);
        break;
      case "Enter":
        if (e.isComposing) break;
        e.preventDefault();
        void pickRow(rows[selected]);
        break;
    }
  }

  const placeholder = $derived(
    parsed.mode === "command" ? "Type a command" : parsed.mode === "goto" ? "Line number (:120 or :120:5)" : "Go to file (type > for commands, : for a line)",
  );

  const footer = $derived.by((): string => {
    if (parsed.mode !== "file") return "";
    if (!explorer.root) return "No folder open: showing open tabs only";
    if (fileIndex.loading && fileIndex.files.length === 0) return "Loading files…";
    if (fileIndex.truncated) return `File list truncated at ${fileIndex.files.length.toLocaleString()} files`;
    return "";
  });
</script>

{#if palette.open}
  <div class="backdrop" role="presentation" onmousedown={close}>
    <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette" tabindex="-1" onmousedown={(e) => e.stopPropagation()}>
      <input
        use:focusOnMount
        type="text"
        class="input"
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={rows[selected] ? `palette-row-${selected}` : undefined}
        spellcheck="false"
        autocomplete="off"
        {placeholder}
        bind:value={palette.input}
        onkeydown={onKeydown}
      />
      <div class="list" id="palette-list" role="listbox" bind:this={listEl}>
        {#each rows as row, i (row.key)}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div
            id="palette-row-{i}"
            class="row"
            class:selected={i === selected}
            class:note={row.kind === "note"}
            role="option"
            aria-selected={i === selected}
            tabindex="-1"
            onclick={() => void pickRow(row)}
            onmousemove={() => (selected = i)}
          >
            <span class="name">
              {#each row.name as s, k (k)}{#if s.hit}<mark>{s.text}</mark>{:else}{s.text}{/if}{/each}
            </span>
            {#if row.dir}
              <span class="dir">
                {#each row.dir as s, k (k)}{#if s.hit}<mark>{s.text}</mark>{:else}{s.text}{/if}{/each}
              </span>
            {/if}
            <span class="spacer"></span>
            {#if row.tag}<span class="tag">{row.tag}</span>{/if}
            {#if row.category}<span class="category">{row.category}</span>{/if}
            {#if row.shortcut}<kbd>{row.shortcut}</kbd>{/if}
          </div>
        {:else}
          {#if parsed.mode !== "goto"}<div class="none">No matches</div>{/if}
        {/each}
      </div>
      {#if footer}<div class="footer">{footer}</div>{/if}
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 10vh;
  }
  .palette {
    width: min(640px, 92vw);
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow);
    overflow: hidden;
  }
  .input {
    margin: 8px;
    padding: 7px 9px;
    font-size: 14px;
  }
  .list {
    overflow-y: auto;
    padding: 0 4px 4px;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
  }
  .row.selected {
    background: var(--bg-active);
  }
  .row.note {
    cursor: default;
    color: var(--fg-dim);
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dir {
    color: var(--fg-dim);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .spacer {
    flex: 1;
  }
  mark {
    background: none;
    color: var(--accent);
    font-weight: 700;
  }
  .tag,
  .category {
    color: var(--fg-dim);
    font-size: 11px;
  }
  kbd {
    font: inherit;
    font-size: 11px;
    color: var(--fg-dim);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0 5px;
  }
  .none,
  .footer {
    padding: 6px 12px;
    color: var(--fg-dim);
  }
  .footer {
    border-top: 1px solid var(--border);
    font-size: 12px;
  }
</style>
