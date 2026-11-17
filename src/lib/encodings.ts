/** Save-as encodings and line endings offered in the status bar, and the labels shown for a tab's. */
import type { Eol } from "./ipc";

/** Line endings offered in the status bar, by label. */
export const eolChoices: Record<string, Eol> = { LF: "lf", CRLF: "crlf", CR: "cr" };

export function eolLabel(eol: Eol): string {
  return eol.toUpperCase();
}

/** The EOL for a picker label, or null for an unknown label. */
export function eolFromLabel(label: string): Eol | null {
  return eolChoices[label] ?? null;
}

export interface EncodingChoice {
  encoding: string;
  bom: boolean;
}

/**
 * UTF-16 always carries a BOM: the backend cannot detect UTF-16 without one (docs/ipc.md), so a
 * BOM-less UTF-16 file would reopen as garbage. Keep the picker honest by not offering it.
 */
export const encodingChoices: Record<string, EncodingChoice> = {
  "UTF-8": { encoding: "utf-8", bom: false },
  "UTF-8 with BOM": { encoding: "utf-8", bom: true },
  "UTF-16 LE": { encoding: "utf-16le", bom: true },
  "UTF-16 BE": { encoding: "utf-16be", bom: true },
  "Windows-1252": { encoding: "windows-1252", bom: false },
};

export function encodingLabel(encoding: string, bom: boolean): string {
  const match = Object.entries(encodingChoices).find(([, v]) => v.encoding === encoding && v.bom === bom);
  if (match) return match[0];
  return encoding.toUpperCase() + (bom ? " with BOM" : "");
}

/** For a lossy read: the encoding label its bytes were invalid for (Tab.lossy); null for a clean read. */
export function lossyLabel(meta: { lossy: boolean; encoding: string; bom: boolean }): string | null {
  return meta.lossy ? encodingLabel(meta.encoding, meta.bom) : null;
}
