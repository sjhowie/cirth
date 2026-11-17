<script lang="ts">
  import { answerDialog, dialogs } from "#lib/dialogs.svelte.js";

  const current = $derived(dialogs.queue[0]);

  function onKeydown(e: KeyboardEvent): void {
    if (!current) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      answerDialog(current.cancelValue);
    }
  }

  function focusPrimary(node: HTMLElement, primary: boolean | undefined): void {
    if (primary) node.focus();
  }
</script>

<svelte:window onkeydowncapture={onKeydown} />

{#if current}
  <div class="backdrop" role="presentation" onclick={() => answerDialog(current.cancelValue)}>
    <div
      class="dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="dlg-title"
      aria-describedby="dlg-msg"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <h2 id="dlg-title">{current.title}</h2>
      <p id="dlg-msg">{current.message}</p>
      <div class="buttons">
        {#each current.buttons as b (b.value)}
          <button
            class="btn"
            class:primary={b.primary}
            class:danger={b.danger}
            onclick={() => answerDialog(b.value)}
            use:focusPrimary={b.primary}
          >
            {b.label}
          </button>
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
    z-index: 2000;
  }
  .dialog {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow);
    padding: 18px 20px;
    width: min(440px, calc(100vw - 32px));
  }
  h2 {
    margin: 0 0 8px;
    font-size: 15px;
  }
  p {
    margin: 0 0 16px;
    color: var(--fg-dim);
    word-break: break-word;
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
