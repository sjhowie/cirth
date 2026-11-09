<script lang="ts">
  import ContextMenu, { type MenuItem } from "./ContextMenu.svelte";
  import SearchBar from "./SearchBar.svelte";
  import SearchResults from "./SearchResults.svelte";
  import TreeNode from "./TreeNode.svelte";
  import { deleteEntry, explorer, startCreate, startRename } from "$lib/explorer.svelte";
  import { openFolderDialog } from "$lib/files";
  import type { DirEntry } from "$lib/ipc";
  import { basename } from "$lib/paths";
  import { search } from "$lib/search/search.svelte";

  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);

  function showMenu(e: MouseEvent, entry: DirEntry | null, parent: string): void {
    // Files create siblings; folders create children.
    const target = entry?.isDir ? entry.path : parent;
    const items: MenuItem[] = [
      { label: "New File", action: () => startCreate(target, "file") },
      { label: "New Folder", action: () => startCreate(target, "dir") },
    ];
    if (entry) {
      items.push({ label: "Rename", action: () => startRename(entry.path) });
      items.push({ label: "Delete", action: () => void deleteEntry(entry.path, entry.isDir) });
    }
    menu = { x: e.clientX, y: e.clientY, items };
  }
</script>

<div class="explorer">
  {#if explorer.root}
    {@const root = explorer.root}
    <div class="head">
      <span class="title" title={root}>{basename(root) || root}</span>
      <button class="icon-btn" title="New File" aria-label="New File" onclick={() => startCreate(root, "file")}>+</button>
      <button class="icon-btn" title="New Folder" aria-label="New Folder" onclick={() => startCreate(root, "dir")}>▣</button>
    </div>
    <SearchBar />
    {#if search.query !== ""}
      <SearchResults />
    {:else}
      <div
        class="tree"
        role="tree"
        tabindex="-1"
        oncontextmenu={(e) => {
          e.preventDefault();
          showMenu(e, null, root);
        }}
      >
        <TreeNode dir={root} depth={0} oncontext={showMenu} />
      </div>
    {/if}
  {:else}
    <div class="empty">
      <p>No folder open</p>
      <button class="btn" onclick={() => void openFolderDialog()}>Open Folder</button>
    </div>
  {/if}
</div>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menu.items} onclose={() => (menu = null)} />
{/if}

<style>
  .explorer {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 6px 4px 10px;
    text-transform: uppercase;
    font-size: 11px;
    letter-spacing: 0.04em;
    color: var(--fg-dim);
  }
  .title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .icon-btn {
    width: 20px;
    height: 20px;
    border-radius: 4px;
    color: var(--fg-dim);
  }
  .icon-btn:hover {
    background: var(--bg-hover);
  }
  .tree {
    flex: 1;
    overflow: auto;
    padding-bottom: 20px;
  }
  .empty {
    padding: 16px;
    color: var(--fg-dim);
    text-align: center;
  }
</style>
