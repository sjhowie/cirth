import { describe, expect, it } from "vitest";
import { rekeyUnder, repoint, validName } from "./explorerLogic";
import { normPath } from "./paths";

describe("validName", () => {
  it("accepts ordinary names", () => {
    for (const n of ["a.txt", "notes", ".gitignore", "my file.md", "console.log", "COM10", "com", "a-b_c"]) expect(validName(n)).toBeNull();
  });

  it("rejects empty and dot names and separators", () => {
    expect(validName("")).toMatch(/empty/);
    expect(validName(".")).toMatch(/empty/);
    expect(validName("..")).toMatch(/empty/);
    expect(validName("a/b")).toMatch(/\//);
    expect(validName("a\\b")).toMatch(/\//);
  });

  it("rejects ':' with the alternate-data-stream message", () => {
    expect(validName("notes:x")).toMatch(/alternate data stream/);
  });

  it("rejects the other invalid characters", () => {
    for (const c of ["<", ">", '"', "|", "?", "*"]) expect(validName(`a${c}b`)).toContain(c);
  });

  it("rejects control characters", () => {
    expect(validName("a\u0000b")).toMatch(/control/);
    expect(validName("a\tb")).toMatch(/control/);
  });

  it("rejects a trailing dot or space", () => {
    expect(validName("a.")).toMatch(/dot or a space/);
    expect(validName("a ")).toMatch(/dot or a space/);
  });

  it("rejects reserved device names with or without extension, any case", () => {
    for (const n of ["CON", "con", "PRN", "Aux", "NUL", "COM1", "com9", "LPT1", "lpt9", "nul.txt", "COM1.tar.gz"]) {
      expect(validName(n)).toMatch(/reserved/);
    }
  });
});

describe("rekeyUnder / repoint", () => {
  const dir = (path: string) => ({ path, entries: [] as string[] });

  it("re-keys the folder and everything below it, leaving siblings alone", () => {
    const map = {
      [normPath("D:/p/old")]: dir("D:/p/old"),
      [normPath("D:/p/old/sub")]: dir("D:/p/old/sub"),
      [normPath("D:/p/older")]: dir("D:/p/older"),
      [normPath("D:/p")]: dir("D:/p"),
    };
    const out = rekeyUnder(map, "D:\\p\\old", "D:\\p\\new", (d) => ({ ...d, path: d.path.replace("/old", "/new") }));
    expect(Object.keys(out).sort()).toEqual([normPath("D:/p"), normPath("D:/p/new"), normPath("D:/p/new/sub"), normPath("D:/p/older")].sort());
    expect(out[normPath("D:/p/new/sub")].path).toBe("D:/p/new/sub");
    expect(out[normPath("D:/p/older")].path).toBe("D:/p/older");
  });

  it("re-keys expanded flags", () => {
    const out = rekeyUnder({ [normPath("D:/p/old")]: true, [normPath("D:/p/x")]: false }, "D:/p/old", "D:/p/new");
    expect(out[normPath("D:/p/new")]).toBe(true);
    expect(out[normPath("D:/p/old")]).toBeUndefined();
    expect(out[normPath("D:/p/x")]).toBe(false);
  });

  it("re-points a selected path inside, itself, and leaves others and null", () => {
    expect(repoint("D:/p/old/a.txt", "D:/p/old", "D:/p/new")).toBe("D:/p/new/a.txt");
    expect(repoint("D:/p/old", "D:/p/old", "D:/p/new")).toBe("D:/p/new");
    expect(repoint("D:/p/older/a.txt", "D:/p/old", "D:/p/new")).toBe("D:/p/older/a.txt");
    expect(repoint(null, "D:/p/old", "D:/p/new")).toBeNull();
  });
});
