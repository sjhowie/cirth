/**
 * Splits text into UTF-8 chunks without ever holding the whole encoded document: used to stage
 * raw request bodies that are too big for one WebView2 request (docs/ipc.md "Chunked uploads").
 */

/** Payloads below this many bytes stay one inline request; staged chunks are cut near it. */
export const CHUNK_BYTES = 32 * 1024 * 1024;

/**
 * UTF-16 units per slice. A unit encodes to at most 3 UTF-8 bytes (a surrogate pair is 2 units for
 * 4 bytes), so an encoded chunk is at most 3 * SLICE_UNITS = 30 MiB, under CHUNK_BYTES.
 */
export const SLICE_UNITS = 10 * 1024 * 1024;

const encoder = new TextEncoder();

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** End index (exclusive) for a slice of at most `max` units starting at 0, never splitting a pair. */
function cutPoint(text: string, max: number): number {
  if (text.length <= max) return text.length;
  return isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
}

/**
 * Encodes `pieces` (a string, or any iterable of strings such as a CodeMirror `Text`) into chunks of
 * at most `3 * sliceUnits` bytes. Concatenating the chunks equals `TextEncoder.encode(pieces.join(""))`.
 * Yields nothing for empty input.
 */
export function* encodeChunks(pieces: string | Iterable<string>, sliceUnits: number = SLICE_UNITS): Generator<Uint8Array> {
  if (sliceUnits < 2) throw new RangeError("sliceUnits must be at least 2");
  let buffer = "";
  for (const piece of typeof pieces === "string" ? [pieces] : pieces) {
    buffer += piece;
    while (buffer.length > sliceUnits) {
      const cut = cutPoint(buffer, sliceUnits);
      yield encoder.encode(buffer.slice(0, cut));
      buffer = buffer.slice(cut);
    }
  }
  if (buffer.length > 0) yield encoder.encode(buffer);
}
