import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { xml } from "@codemirror/lang-xml";
import { markdown } from "@codemirror/lang-markdown";
import { linter, lintGutter } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";

export const PLAIN_TEXT = "Plain Text";
export const JSON_LANG = "JSON";
export const XML_LANG = "XML";
export const MARKDOWN_LANG = "Markdown";

const xmlExtensions = new Set([
  "xml", "csproj", "vbproj", "fsproj", "config", "xaml", "svg", "xsd", "xslt", "xsl", "resx", "props", "targets",
  "nuspec", "plist", "wsdl", "manifest", "vsixmanifest", "ruleset", "axml",
]);
const jsonExtensions = new Set(["json", "jsonc", "map", "webmanifest"]);
const markdownExtensions = new Set(["md", "markdown", "mdown", "mkd", "mdx"]);

function extensionOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i < 0 ? "" : filename.slice(i + 1).toLowerCase();
}

/** Language display name for a file name; "Plain Text" when unknown. */
export function detectLanguageName(filename: string): string {
  const ext = extensionOf(filename);
  if (jsonExtensions.has(ext)) return JSON_LANG;
  if (xmlExtensions.has(ext)) return XML_LANG;
  if (markdownExtensions.has(ext)) return MARKDOWN_LANG;
  return LanguageDescription.matchFilename(languages, filename)?.name ?? PLAIN_TEXT;
}

/** Names offered by the status-bar language picker. */
export function listLanguageNames(): string[] {
  const names = new Set<string>([JSON_LANG, XML_LANG, MARKDOWN_LANG]);
  for (const l of languages) names.add(l.name);
  return [PLAIN_TEXT, ...[...names].sort((a, b) => a.localeCompare(b))];
}

/** Whether a language has a Format Document implementation (json/xml) and which one. */
export function formatterKind(languageName: string): "json" | "xml" | null {
  if (languageName === JSON_LANG) return "json";
  if (languageName === XML_LANG) return "xml";
  return null;
}

/**
 * Lazily loads the CodeMirror extension for a language name (full mode only; light mode
 * never loads a language). Unknown names give plain text (no extension).
 */
export async function loadLanguageExtension(name: string): Promise<Extension> {
  switch (name) {
    case PLAIN_TEXT:
      return [];
    case JSON_LANG:
      return [json(), linter(jsonParseLinter()), lintGutter()];
    case XML_LANG:
      return xml();
    case MARKDOWN_LANG:
      return markdown({ codeLanguages: languages });
    default: {
      const desc = languages.find((l) => l.name === name);
      if (!desc) return [];
      return await desc.load();
    }
  }
}
