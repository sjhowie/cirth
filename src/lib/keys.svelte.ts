/**
 * One global capture-phase keydown handler. Registry bindings win over CodeMirror's keymap
 * (the event is stopped before it reaches the editor); everything unbound falls through.
 */
import { listCommands, runCommand } from "./commands";
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

function onKeyDown(e: KeyboardEvent): void {
  if (e.isComposing) return;
  const stroke = eventToStroke(e, isMac);
  if (stroke === null) return;
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
