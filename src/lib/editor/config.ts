import { Compartment, EditorState, type Extension, type StateEffect } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { defaultHighlightStyle, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";
import { fullModeExtensions, lightModeExtensions } from "./largeFile";
import type { FormatIndent } from "../ipc";

/** One compartment per reconfigurable concern; shared by every tab's state. */
export const languageC = new Compartment();
export const themeC = new Compartment();
export const indentC = new Compartment();
export const wrapC = new Compartment();
export const fontC = new Compartment();

export interface EditorSettings {
  fontFamily: string;
  fontSize: number;
  indent: FormatIndent;
  wordWrap: boolean;
}

export function indentExtension(indent: FormatIndent): Extension {
  const size = indent === "tab" ? 4 : Number(indent);
  return [indentUnit.of(indent === "tab" ? "\t" : " ".repeat(size)), EditorState.tabSize.of(size)];
}

export function themeExtension(dark: boolean): Extension {
  return dark ? oneDark : [syntaxHighlighting(defaultHighlightStyle, { fallback: true }), EditorView.theme({}, { dark: false })];
}

export function wrapExtension(wordWrap: boolean, largeFile: boolean): Extension {
  return wordWrap && !largeFile ? EditorView.lineWrapping : [];
}

export function fontExtension(fontFamily: string, fontSize: number): Extension {
  return EditorView.theme({
    "&": { fontSize: `${fontSize}px` },
    ".cm-scroller": { fontFamily },
    ".cm-content": { fontFamily },
  });
}

const layoutTheme = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { overflow: "auto" },
});

export interface BuildOptions {
  largeFile: boolean;
  /** Language extension (ignored in light mode). */
  lang: Extension;
  settings: EditorSettings;
  dark: boolean;
  onUpdate: (u: ViewUpdate) => void;
}

/** Full extension set for one tab: light/full base plus the compartments. */
export function buildExtensions(o: BuildOptions): Extension[] {
  return [
    o.largeFile ? [lightModeExtensions(), languageC.of([])] : fullModeExtensions(languageC.of(o.lang)),
    themeC.of(themeExtension(o.dark)),
    indentC.of(indentExtension(o.settings.indent)),
    wrapC.of(wrapExtension(o.settings.wordWrap, o.largeFile)),
    fontC.of(fontExtension(o.settings.fontFamily, o.settings.fontSize)),
    layoutTheme,
    EditorView.updateListener.of(o.onUpdate),
  ];
}

/** Effects that apply new settings/theme to an existing state. */
export function settingsEffects(settings: EditorSettings, dark: boolean, largeFile: boolean): StateEffect<unknown>[] {
  return [
    themeC.reconfigure(themeExtension(dark)),
    indentC.reconfigure(indentExtension(settings.indent)),
    wrapC.reconfigure(wrapExtension(settings.wordWrap, largeFile)),
    fontC.reconfigure(fontExtension(settings.fontFamily, settings.fontSize)),
  ];
}
