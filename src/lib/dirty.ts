import type { Text } from "@codemirror/state";

/**
 * Dirty = doc !== savedDoc and not (same length and doc.eq(savedDoc)).
 * Identity and length checks are O(1); `eq` short-circuits at the first difference
 * and walks shared subtrees cheaply, so this is safe on large documents.
 */
export function isDocDirty(doc: Text, savedDoc: Text): boolean {
  if (doc === savedDoc) return false;
  if (doc.length !== savedDoc.length) return true;
  return !doc.eq(savedDoc);
}

/** Splits like CodeMirror does (\r\n, \r, \n) so disk text compares equal to a doc. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n?|\n/);
}
