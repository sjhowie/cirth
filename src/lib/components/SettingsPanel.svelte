<script lang="ts">
  import { layout } from "$lib/layout.svelte";
  import { settings, updateSettings } from "$lib/settings.svelte";
  import type { FormatIndent, ThemeSetting } from "$lib/ipc";
  import { checkForUpdate, updater } from "$lib/updater.svelte";

  function close(): void {
    layout.settingsOpen = false;
  }

  function focusNode(node: HTMLElement): void {
    node.focus();
  }
</script>

{#if layout.settingsOpen}
  <div class="backdrop" role="presentation" onclick={close}>
    <div
      class="panel"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") close();
      }}
    >
      <h2>Settings</h2>
      <label>
        <span>Theme</span>
        <select value={settings.theme} use:focusNode onchange={(e) => updateSettings({ theme: e.currentTarget.value as ThemeSetting })}>
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <label>
        <span>Font family</span>
        <input type="text" value={settings.fontFamily} onchange={(e) => updateSettings({ fontFamily: e.currentTarget.value })} />
      </label>
      <label>
        <span>Font size</span>
        <input type="number" min="8" max="48" value={settings.fontSize} onchange={(e) => updateSettings({ fontSize: Number(e.currentTarget.value) })} />
      </label>
      <label>
        <span>Indent</span>
        <select value={settings.indent} onchange={(e) => updateSettings({ indent: e.currentTarget.value as FormatIndent })}>
          <option value="2">2 spaces</option>
          <option value="4">4 spaces</option>
          <option value="tab">Tab</option>
        </select>
      </label>
      <label class="check">
        <input type="checkbox" checked={settings.wordWrap} onchange={(e) => updateSettings({ wordWrap: e.currentTarget.checked })} />
        <span>Word wrap</span>
      </label>
      <label>
        <span>Light mode above (MB)</span>
        <input
          type="number"
          min="1"
          value={settings.largeFileThresholdMb}
          onchange={(e) => updateSettings({ largeFileThresholdMb: Number(e.currentTarget.value) })}
        />
      </label>
      <p class="hint">Applies to files opened after the change; open tabs keep their mode.</p>
      <div class="buttons">
        <span class="version">Cirth {updater.version}</span>
        <button class="btn" disabled={updater.phase !== "idle"} onclick={() => void checkForUpdate(true)}>Check for Updates</button>
        <button class="btn primary" onclick={close}>Close</button>
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
    margin: 0 0 4px;
    font-size: 15px;
  }
  label {
    display: grid;
    grid-template-columns: 160px 1fr;
    align-items: center;
    gap: 8px;
  }
  label.check {
    grid-template-columns: auto 1fr;
  }
  .hint {
    margin: 0;
    color: var(--fg-dim);
    font-size: 12px;
  }
  .buttons {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
  }
  .version {
    margin-right: auto;
    color: var(--fg-dim);
    font-size: 12px;
  }
</style>
