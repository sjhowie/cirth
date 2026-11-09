import { describe, expect, it } from "vitest";
import { detectLanguageName, formatterKind, listLanguageNames, loadLanguageExtension } from "./languages";

describe("detectLanguageName", () => {
  it.each([
    ["a.json", "JSON"],
    ["package.json", "JSON"],
    ["a.xml", "XML"],
    ["App.csproj", "XML"],
    ["web.config", "XML"],
    ["x.xaml", "XML"],
    ["logo.svg", "XML"],
    ["s.xsd", "XML"],
    ["t.xslt", "XML"],
    ["r.resx", "XML"],
    ["Directory.Build.props", "XML"],
    ["x.targets", "XML"],
    ["README.md", "Markdown"],
    ["a.ts", "TypeScript"],
    ["a.py", "Python"],
    ["a.unknownext", "Plain Text"],
    ["noextension", "Plain Text"],
  ])("%s -> %s", (file, lang) => {
    expect(detectLanguageName(file)).toBe(lang);
  });

  it("is case-insensitive on extensions", () => {
    expect(detectLanguageName("A.CSPROJ")).toBe("XML");
    expect(detectLanguageName("A.JSON")).toBe("JSON");
  });
});

describe("languages", () => {
  it("lists plain text first and includes the explicit ones", () => {
    const names = listLanguageNames();
    expect(names[0]).toBe("Plain Text");
    expect(names).toEqual(expect.arrayContaining(["JSON", "XML", "Markdown", "TypeScript"]));
  });

  it("maps formatters", () => {
    expect(formatterKind("JSON")).toBe("json");
    expect(formatterKind("XML")).toBe("xml");
    expect(formatterKind("Python")).toBeNull();
  });

  it("loads unknown names as plain text", async () => {
    expect(await loadLanguageExtension("Nope")).toEqual([]);
    expect(await loadLanguageExtension("Plain Text")).toEqual([]);
  });
});
