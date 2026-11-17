/**
 * One global capture-phase keydown handler. Registry bindings win over CodeMirror's keymap
 * (the event is stopped before it reaches the editor); everything unbound falls through.
 */
import { listCommands, runCommand } from "./commands";
import { dialogs } from "./dialogs.svelte";
import { eventToStroke, formatBinding, KeyResolver } from "./keybindings";
import { isMac } from "./platform";

export const chordHint = $state({ text: "" });

const resolver = new KeyResolver(() => listCommands());
let hintTimer: ReturnType<typeof setTimeout> | null = null;

function clearHint(): void {
  chordHint.text = "";
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = null;
}

/** Keys a modal dialog handles itself (Modal.svelte and its focused buttons); never swallowed. */
const dialogKeys = new Set(["Escape", "Enter", " ", "Tab", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

/**
 * While a modal dialog is open no app command runs: a second Ctrl+W or Ctrl+S would otherwise act on
 * tabs behind the prompt. Bound shortcuts are swallowed (so the WebView's own Ctrl+S etc. don't run
 * either); the dialog's own keys and unbound keys pass through.
 */
function onKeyDownInDialog(e: KeyboardEvent, stroke: string): void {
  resolver.reset();
  clearHint();
  if (dialogKeys.has(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) return;
  const result = resolver.handle(stroke, Date.now());
  resolver.reset();
  if (result.type === "none") return;
  e.preventDefault();
  e.stopPropagation();
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.isComposing) return;
  const stroke = eventToStroke(e, isMac);
  if (stroke === null) return;
  if (dialogs.queue.length > 0) {
    onKeyDownInDialog(e, stroke);
    return;
  }
  const result = resolver.handle(stroke, Date.now());
  switch (result.type) {
    case "none":
      return;
    case "pending":
      chordHint.text = `${formatBinding(result.prefix, isMac)} was pressed… waiting for second key`;
      hintTimer = setTimeout(() => {
        resolver.reset();
        clearHint();
      }, 1500);
      break;
    case "cancelled":
      clearHint();
      break;
    case "run":
      clearHint();
      void runCommand(result.id);
      break;
  }
  e.preventDefault();
  e.stopPropagation();
}

/** Installs the handler; returns an uninstall function. */
export function installKeyHandler(): () => void {
  window.addEventListener("keydown", onKeyDown, true);
  return () => window.removeEventListener("keydown", onKeyDown, true);
}
