/** Save-as encodings offered in the status bar, and the label shown for a tab's encoding. */
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
