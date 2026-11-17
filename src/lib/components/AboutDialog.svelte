<script lang="ts">
  import { buildCommit, buildDate } from "$lib/buildInfo";
  import { dialogs } from "$lib/dialogs.svelte";
  import { helpDialogs, openChangelog } from "$lib/helpDialogs.svelte";
  import { isTauri } from "$lib/ipc";
  import { reportError } from "$lib/notifications.svelte";
  import { checkForUpdate, updater } from "$lib/updater.svelte";

  const REPO_URL = "https://github.com/sjhowie/cirth";
  let tauriVersion = $state("");

  $effect(() => {
    if (!helpDialogs.aboutOpen || tauriVersion !== "" || !isTauri()) return;
    import("@tauri-apps/api/app")
      .then(({ getTauriVersion }) => getTauriVersion())
      .then((v) => (tauriVersion = v))
      .catch((e) => reportError("Read Tauri version", e));
  });

  function close(): void {
    helpDialogs.aboutOpen = false;
  }

  async function openRepo(): Promise<void> {
    try {
      if (isTauri()) {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(REPO_URL);
      } else window.open(REPO_URL, "_blank", "noopener");
    } catch (e) {
      reportError("Open the GitHub page", e);
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    // A prompt from dialogs.svelte (e.g. the update question) sits on top and takes Esc first.
    if (!helpDialogs.aboutOpen || dialogs.queue.length > 0 || e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }

  function focusNode(node: HTMLElement): void {
    node.focus();
  }
</script>

<svelte:window onkeydowncapture={onKeydown} />

{#if helpDialogs.aboutOpen}
  <div class="backdrop" role="presentation" onclick={close}>
    <div
      class="panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="about-title"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <h2 id="about-title">Cirth</h2>
      <p class="meaning">
        Cirth (singular <em>certh</em>) are the runes of the Dwarves in Tolkien's Middle-earth: small, sharp marks cut for writing.
      </p>
      <dl>
        <dt>Version</dt>
        <dd class="about-version">{updater.version || "unknown"}</dd>
        <dt>Build</dt>
        <dd><code>{buildCommit}</code> · {buildDate}</dd>
        <dt>Tauri</dt>
        <dd>{tauriVersion || "unknown"}</dd>
        <dt>License</dt>
        <dd>MIT · Copyright (c) 2026 Steve Howie</dd>
        <dt>Source</dt>
        <dd><button class="link" onclick={() => void openRepo()}>github.com/sjhowie/cirth</button></dd>
      </dl>
      <div class="buttons">
        <button class="btn" disabled={updater.phase !== "idle"} onclick={() => void checkForUpdate(true)}>Check for Updates</button>
        <button class="btn" onclick={openChangelog}>What's New</button>
        <button class="btn primary" use:focusNode onclick={close}>Close</button>
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
    padding: 16px 20px;
    width: min(440px, calc(100vw - 32px));
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  h2 {
    margin: 0;
    font-size: 15px;
  }
  .meaning {
    margin: 0;
    color: var(--fg-dim);
  }
  dl {
    display: grid;
    grid-template-columns: 80px 1fr;
    gap: 4px 8px;
    margin: 4px 0;
  }
  dt {
    color: var(--fg-dim);
  }
  dd {
    margin: 0;
    word-break: break-word;
  }
  code {
    font-family: Consolas, "Cascadia Mono", ui-monospace, monospace;
    font-size: 12px;
  }
  .link {
    color: var(--accent);
    text-decoration: underline;
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }
</style>
