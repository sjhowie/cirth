/** Pure helpers for the explorer store: name validation and folder-rename re-keying. */
import { isInside, normPath, replacePrefix } from "./paths";

const reservedDeviceName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Returns why `name` cannot be a file or folder name on Windows, or null when it is fine. */
export function validName(name: string): string | null {
  if (!name || name === "." || name === "..") return "Name cannot be empty";
  if (/[\\/]/.test(name)) return "Name cannot contain / or \\";
  if (/[\u0000-\u001f]/.test(name)) return "Name cannot contain control characters";
  const bad = /[<>:"|?*]/.exec(name);
  if (bad) {
    return bad[0] === ":"
      ? 'Name cannot contain ":" (it would create an NTFS alternate data stream)'
      : `Name cannot contain ${bad[0]}  (none of < > : " | ? * are allowed)`;
  }
  if (/[. ]$/.test(name)) return "Name cannot end with a dot or a space";
  if (reservedDeviceName.test(name.split(".")[0])) return `"${name.split(".")[0]}" is a reserved Windows device name`;
  return null;
}

/**
 * Re-keys every entry of `map` whose key is at or below `from` so it lives under `to`.
 * Keys are normPath keys; `mapValue` can rewrite the value (e.g. a stored path).
 */
export function rekeyUnder<T>(map: Record<string, T>, from: string, to: string, mapValue?: (value: T) => T): Record<string, T> {
  const out: Record<string, T> = {};
  const fromKey = normPath(from);
  for (const [key, value] of Object.entries(map)) {
    if (isInside(from, key)) {
      out[normPath(replacePrefix(key, fromKey, to))] = mapValue ? mapValue(value) : value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Path after renaming `from` to `to`: re-rooted when it is inside `from`, unchanged otherwise. */
export function repoint(path: string | null, from: string, to: string): string | null {
  return path !== null && isInside(from, path) ? replacePrefix(path, from, to) : path;
}
