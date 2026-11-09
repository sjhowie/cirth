/**
 * Syntax highlighting for rendered fenced code blocks. The render step leaves plain escaped
 * code; this runs afterwards: blocks whose parser is already loaded are highlighted at once,
 * the others load their language lazily and are highlighted when it arrives.
 */
import { LanguageDescription, type Language } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { classHighlighter, highlightCode } from "@lezer/highlight";

/** Loaded languages by description name; `null` = known to have no usable parser. */
const loaded = new Map<string, Language | null>();
const loading = new Map<string, Promise<void>>();

function descriptionFor(info: string): LanguageDescription | null {
  return LanguageDescription.matchLanguageName(languages, info, true);
}

function startLoad(desc: LanguageDescription): Promise<void> {
  let p = loading.get(desc.name);
  if (!p) {
    p = desc
      .load()
      .then((support) => {
        loaded.set(desc.name, support.language);
      })
      .catch((e: unknown) => {
        console.error(`Load highlighter for ${desc.name}`, e);
        loaded.set(desc.name, null);
      });
    loading.set(desc.name, p);
  }
  return p;
}

/** Replaces the code element's text with highlighted spans (same text, same whitespace). */
export function applyHighlight(code: HTMLElement, language: Language): void {
  const text = code.textContent ?? "";
  const tree = language.parser.parse(text);
  const frag = document.createDocumentFragment();
  highlightCode(
    text,
    tree,
    classHighlighter,
    (piece, classes) => {
      if (classes) {
        const span = document.createElement("span");
        span.className = classes;
        span.textContent = piece;
        frag.append(span);
      } else {
        frag.append(document.createTextNode(piece));
      }
    },
    () => frag.append(document.createTextNode("\n")),
  );
  code.replaceChildren(frag);
}

function blocksIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("pre > code[data-lang]")];
}

/**
 * Highlights every fenced block under `root`. Returns a promise that settles once languages
 * that had to be loaded have been applied (blocks found again under `root` at that time).
 * Unknown languages stay plain.
 */
export function highlightBlocks(root: HTMLElement): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const code of blocksIn(root)) {
    const info = code.dataset.lang ?? "";
    const desc = descriptionFor(info);
    if (!desc) continue;
    const lang = loaded.get(desc.name);
    if (lang) {
      applyHighlight(code, lang);
    } else if (lang === undefined) {
      pending.push(
        startLoad(desc).then(() => {
          const ready = loaded.get(desc.name);
          if (!ready || !root.isConnected) return;
          // The block may have been re-rendered meanwhile: highlight whatever is there now.
          for (const current of blocksIn(root)) {
            if (descriptionFor(current.dataset.lang ?? "")?.name === desc.name && current.childElementCount === 0) {
              applyHighlight(current, ready);
            }
          }
        }),
      );
    }
  }
  return Promise.all(pending).then(() => undefined);
}
