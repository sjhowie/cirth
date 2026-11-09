import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCommands, getCommand, listCommands, onCommandsChanged, registerCommand, runCommand, setCommandErrorHandler } from "./commands";

afterEach(() => clearCommands());

describe("command registry", () => {
  it("registers, lists and runs", async () => {
    const run = vi.fn();
    registerCommand({ id: "a", label: "A", category: "File", keys: ["Mod-a"], run });
    expect(listCommands().map((c) => c.id)).toEqual(["a"]);
    expect(getCommand("a")?.label).toBe("A");
    expect(await runCommand("a")).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it("replaces a command with the same id and unregisters", () => {
    const off = registerCommand({ id: "a", label: "old", category: "File", run: () => {} });
    registerCommand({ id: "a", label: "new", category: "File", run: () => {} });
    expect(listCommands()).toHaveLength(1);
    expect(getCommand("a")?.label).toBe("new");
    off(); // stale handle: must not remove the replacement
    expect(getCommand("a")?.label).toBe("new");
  });

  it("awaits async commands and reports thrown errors through the handler", async () => {
    const handler = vi.fn();
    setCommandErrorHandler(handler);
    registerCommand({
      id: "bad",
      label: "Bad",
      category: "File",
      run: async () => {
        throw new Error("nope");
      },
    });
    expect(await runCommand("bad")).toBe(false);
    expect(handler).toHaveBeenCalledWith("Bad", expect.any(Error));
  });

  it("reports unknown ids and notifies subscribers", async () => {
    const handler = vi.fn();
    setCommandErrorHandler(handler);
    const changed = vi.fn();
    const off = onCommandsChanged(changed);
    expect(await runCommand("missing")).toBe(false);
    expect(handler).toHaveBeenCalled();
    registerCommand({ id: "x", label: "X", category: "View", run: () => {} });
    expect(changed).toHaveBeenCalledTimes(1);
    off();
  });
});
