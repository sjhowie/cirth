/**
 * Command registry. Anything the user can trigger (menu, palette, keyboard) is a Command.
 *
 * Extension point for later features: call `registerCommand({...})` once at startup.
 * The menu bar lists commands whose `category` is File / Edit / View / Format / Help; the command
 * palette lists everything via `listCommands()`.
 */
export interface Command {
  id: string;
  label: string;
  /** Menu name (File, Edit, View, Format) or any other group shown in the palette. */
  category: string;
  /** Bindings in CodeMirror notation; chords are space separated, e.g. "Mod-k Mod-o". */
  keys?: string[];
  /** Shortcut shown in menus only (handled by CodeMirror itself, not the global key handler). */
  hintKeys?: string[];
  run: () => void | Promise<void>;
}

const registry = new Map<string, Command>();
const listeners = new Set<() => void>();
let errorHandler: (context: string, e: unknown) => void = (context, e) => console.error(context, e);

/** Registers (or replaces) a command. Returns an unregister function. */
export function registerCommand(cmd: Command): () => void {
  registry.set(cmd.id, cmd);
  listeners.forEach((fn) => fn());
  return () => {
    if (registry.get(cmd.id) === cmd) {
      registry.delete(cmd.id);
      listeners.forEach((fn) => fn());
    }
  };
}

export function listCommands(): Command[] {
  return [...registry.values()];
}

export function getCommand(id: string): Command | undefined {
  return registry.get(id);
}

/** Notified whenever the registry changes (palette/menu can refresh). */
export function onCommandsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setCommandErrorHandler(fn: (context: string, e: unknown) => void): void {
  errorHandler = fn;
}

/** Runs a command; errors are reported through the handler, never swallowed. Returns false if unknown or failed. */
export async function runCommand(id: string): Promise<boolean> {
  const cmd = registry.get(id);
  if (!cmd) {
    errorHandler(`Unknown command: ${id}`, new Error(`No command registered with id "${id}"`));
    return false;
  }
  try {
    await cmd.run();
    return true;
  } catch (e) {
    errorHandler(cmd.label, e);
    return false;
  }
}

/** Test helper. */
export function clearCommands(): void {
  registry.clear();
}
