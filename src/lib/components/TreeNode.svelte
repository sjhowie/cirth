<script lang="ts">
  import TreeNode from "./TreeNode.svelte";
  import { cancelEdit, commitCreate, commitRename, entriesOf, explorer, isExpanded, startRename, toggleDir } from "$lib/explorer.svelte";
  import { openPath } from "$lib/files";
  import type { DirEntry } from "$lib/ipc";
  import { samePath } from "$lib/paths";

  let {
    dir,
    depth,
    oncontext,
  }: { dir: string; depth: number; oncontext: (e: MouseEvent, entry: DirEntry | null, parent: string) => void } = $props();

  const entries = $derived(entriesOf(dir) ?? []);

  function focusSelect(node: HTMLInputElement): void {
    node.focus();
    node.select();
  }

  function onEditKey(e: KeyboardEvent, commit: (name: string) => void): void {
    e.stopPropagation();
    if (e.key === "Enter" && !e.isComposing) commit((e.currentTarget as HTMLInputElement).value);
    else if (e.key === "Escape") cancelEdit();
  }

  async function createAndOpen(name: string): Promise<void> {
    const path = await commitCreate(name);
    if (path) await openPath(path);
  }

  function activate(e: MouseEvent, entry: DirEntry): void {
    explorer.selected = entry.path;
    // Alt+click renames instead of opening or toggling.
    if (e.altKey) {
      startRename(entry.path);
      return;
    }
    if (entry.isDir) void toggleDir(entry.path);
    else void openPath(entry.path);
  }
</script>

{#if explorer.creating && samePath(explorer.creating.parent, dir)}
  <div class="row" style:padding-left="{8 + depth * 14}px">
    <span class="icon">{explorer.creating.kind === "dir" ? "▸" : ""}</span>
    <input
      type="text"
      aria-label="New name"
      use:focusSelect
      onkeydown={(e) => onEditKey(e, (n) => void createAndOpen(n))}
      onblur={cancelEdit}
    />
  </div>
{/if}

{#each entries as entry (entry.path)}
  {#if explorer.renaming && samePath(explorer.renaming, entry.path)}
    <div class="row" style:padding-left="{8 + depth * 14}px">
      <span class="icon"></span>
      <input type="text" aria-label="Rename" value={entry.name} use:focusSelect onkeydown={(e) => onEditKey(e, (n) => void commitRename(n))} onblur={cancelEdit} />
    </div>
  {:else}
    <button
      class="row item"
      class:selected={explorer.selected !== null && samePath(explorer.selected, entry.path)}
      style:padding-left="{8 + depth * 14}px"
      onclick={(e) => activate(e, entry)}
      oncontextmenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        explorer.selected = entry.path;
        oncontext(e, entry, dir);
      }}
    >
      <span class="icon">{entry.isDir ? (isExpanded(entry.path) ? "▾" : "▸") : ""}</span>
      <span class="name">{entry.name}</span>
    </button>
  {/if}
  {#if entry.isDir && isExpanded(entry.path)}
    <TreeNode dir={entry.path} depth={depth + 1} {oncontext} />
  {/if}
{/each}

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    padding-right: 6px;
    min-height: 22px;
  }
  .item {
    text-align: left;
  }
  .item:hover {
    background: var(--bg-hover);
  }
  .item.selected {
    background: var(--bg-active);
  }
  .icon {
    width: 12px;
    flex: none;
    color: var(--fg-dim);
    font-size: 10px;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  input {
    flex: 1;
    min-width: 0;
    padding: 1px 4px;
  }
</style>
