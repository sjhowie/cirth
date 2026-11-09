import type { Eol } from "./ipc";

export type { Eol };

export function detectMac(nav: { platform?: string; userAgent?: string } | undefined): boolean {
  if (!nav) return false;
  return /mac|iphone|ipad/i.test(nav.platform || nav.userAgent || "");
}

export function detectWindows(nav: { platform?: string; userAgent?: string } | undefined): boolean {
  if (!nav) return false;
  return /win/i.test(nav.platform || "") || /windows/i.test(nav.userAgent || "");
}

const nav = typeof navigator === "undefined" ? undefined : navigator;

export const isMac = detectMac(nav);
export const isWindows = detectWindows(nav);
export const defaultEol: Eol = isWindows ? "crlf" : "lf";
