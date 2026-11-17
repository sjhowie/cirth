<script lang="ts">
  import changelogMd from "../../../CHANGELOG.md?raw";
  import { formatReleaseDate, parseChangelog, visibleReleases } from "$lib/changelog";
  import { dialogs } from "$lib/dialogs.svelte";
  import { helpDialogs, showWhatsNewIfUpdated } from "$lib/helpDialogs.svelte";
  import { updater } from "$lib/updater.svelte";

  // Items are HTML-escaped by the parser; only <code> is added back.
  const releases = visibleReleases(parseChangelog(changelogMd), import.meta.env.DEV);

  // updater.version arrives asynchronously after startup; the store acts only on the first non-empty value.
  $effect(() => showWhatsNewIfUpdated(updater.version));

  function close(): void {
    helpDialogs.changelogOpen = false;
  }

  function onKeydown(e: KeyboardEvent): void {
    if (!helpDialogs.changelogOpen || dialogs.queue.length > 0 || e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }

  function focusNode(node: HTMLElement): void {
    node.focus();
  }
</script>

<svelte:window onkeydowncapture={onKeydown} />

{#if helpDialogs.changelogOpen}
  <div class="backdrop" role="presentation" onclick={close}>
    <div
      class="panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="changelog-title"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <header>
        <h2 id="changelog-title">What's new</h2>
        <button class="x" aria-label="Close" title="Close" use:focusNode onclick={close}>✕</button>
      </header>
      <div class="body">
        {#each releases as r (r.version ?? "unreleased")}
          <section class="release" data-version={r.version ?? "unreleased"}>
            <div class="head">
              <h3>{r.version === null ? "Unreleased" : r.date ? formatReleaseDate(r.date) : r.version}</h3>
              {#if r.version !== null}<span class="badge">{r.version}</span>{/if}
            </div>
            {#each r.sections as s (s.kind)}
              <div class="label">{s.label}</div>
              <ul>
                {#each s.items as item, i (i)}
                  <li>{@html item}</li>
                {/each}
              </ul>
            {/each}
          </section>
        {:else}
          <p class="empty">No release notes.</p>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1500;
  }
  .panel {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow);
    width: min(560px, calc(100vw - 32px));
    max-height: min(640px, calc(100vh - 64px));
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px 10px 20px;
    border-bottom: 1px solid var(--border);
  }
  h2 {
    margin: 0;
    font-size: 15px;
  }
  .x {
    width: 26px;
    height: 26px;
    border-radius: 4px;
    color: var(--fg-dim);
  }
  .x:hover {
    background: var(--bg-hover);
    color: var(--fg);
  }
  .body {
    overflow-y: auto;
    padding: 0 20px 8px;
  }
  .release {
    padding: 16px 0 10px;
  }
  .release + .release {
    border-top: 1px solid var(--border);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }
  h3 {
    margin: 0;
    font-size: 14px;
  }
  .badge,
  li :global(code) {
    font-family: Consolas, "Cascadia Mono", ui-monospace, monospace;
    font-size: 11.5px;
    background: var(--bg-hover);
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  .badge {
    padding: 1px 6px;
    color: var(--fg-dim);
  }
  li :global(code) {
    padding: 0 4px;
  }
  .label {
    margin: 10px 0 4px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: var(--fg-dim);
  }
  ul {
    margin: 0;
    padding-left: 18px;
  }
  li {
    margin: 3px 0;
    line-height: 1.45;
  }
  .empty {
    color: var(--fg-dim);
  }
</style>
