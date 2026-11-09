<script lang="ts">
  import { dismissToast, toasts } from "$lib/notifications.svelte";
</script>

<div class="stack" aria-live="polite">
  {#each toasts.items as toast (toast.id)}
    <div class="toast {toast.kind}" role={toast.kind === "error" ? "alert" : "status"}>
      <span class="msg">{toast.message}</span>
      <button class="close" aria-label="Dismiss" onclick={() => dismissToast(toast.id)}>×</button>
    </div>
  {/each}
</div>

<style>
  .stack {
    position: fixed;
    right: 14px;
    bottom: 34px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 1000;
    max-width: min(460px, calc(100vw - 28px));
  }
  .toast {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 9px 12px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-left: 4px solid var(--accent);
    border-radius: 5px;
    box-shadow: var(--shadow);
    word-break: break-word;
  }
  .toast.error {
    border-left-color: var(--danger);
  }
  .msg {
    flex: 1;
  }
  .close {
    font-size: 16px;
    line-height: 1;
    color: var(--fg-dim);
  }
</style>
