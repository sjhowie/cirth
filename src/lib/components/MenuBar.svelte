<script lang="ts">
  import { listCommands, runCommand, type Command } from "$lib/commands";
  import { formatBinding } from "$lib/keybindings";
  import { isMac } from "$lib/platform";

  const menus = ["File", "Edit", "View", "Format", "Help"];
  let openMenu = $state<string | null>(null);
  let items = $state<Command[]>([]);

  function show(menu: string): void {
    items = listCommands().filter((c) => c.category === menu);
    openMenu = menu;
  }

  function shortcut(c: Command): string {
    const k = c.keys?.[0] ?? c.hintKeys?.[0];
    return k ? formatBinding(k, isMac) : "";
  }

  function pick(c: Command): void {
    openMenu = null;
    void runCommand(c.id);
  }
</script>

<svelte:window onclick={() => (openMenu = null)} onkeydowncapture={(e) => e.key === "Escape" && (openMenu = null)} />

<nav class="bar" aria-label="Main menu">
  {#each menus as menu (menu)}
    <div class="menu">
      <button
        class="top"
        class:open={openMenu === menu}
        aria-haspopup="menu"
        aria-expanded={openMenu === menu}
        onclick={(e) => {
          e.stopPropagation();
          if (openMenu === menu) openMenu = null;
          else show(menu);
        }}
        onmouseenter={() => openMenu !== null && show(menu)}
      >
        {menu}
      </button>
      {#if openMenu === menu}
        <div class="drop" role="menu">
          {#each items as c (c.id)}
            <button class="entry" role="menuitem" onclick={() => pick(c)}>
              <span>{c.label}</span>
              <span class="keys">{shortcut(c)}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
</nav>

<style>
  .bar {
    display: flex;
    flex: none;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    padding: 0 4px;
  }
  .menu {
    position: relative;
  }
  .top {
    padding: 4px 10px;
    border-radius: 4px;
  }
  .top:hover,
  .top.open {
    background: var(--bg-hover);
  }
  .drop {
    position: absolute;
    top: 100%;
    left: 0;
    min-width: 240px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: var(--shadow);
    padding: 4px;
    z-index: 950;
  }
  .entry {
    display: flex;
    justify-content: space-between;
    gap: 24px;
    width: 100%;
    text-align: left;
    padding: 5px 10px;
    border-radius: 4px;
  }
  .entry:hover {
    background: var(--bg-hover);
  }
  .keys {
    color: var(--fg-dim);
  }
</style>
