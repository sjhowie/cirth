import { toAppError } from "./ipc";

export type ToastKind = "error" | "info";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

export const toasts = $state<{ items: Toast[] }>({ items: [] });
let nextId = 1;

export function dismissToast(id: number): void {
  toasts.items = toasts.items.filter((t) => t.id !== id);
}

export function notify(kind: ToastKind, message: string, timeoutMs = kind === "error" ? 8000 : 4000): void {
  const id = nextId++;
  toasts.items = [...toasts.items, { id, kind, message }].slice(-5);
  if (timeoutMs > 0) setTimeout(() => dismissToast(id), timeoutMs);
}

export const notifyInfo = (message: string): void => notify("info", message);
export const notifyError = (message: string): void => notify("error", message);

/** Logs to the console and shows an error toast. Use this instead of swallowing errors. */
export function reportError(context: string, e: unknown): void {
  const err = toAppError(e);
  console.error(context, e);
  notify("error", `${context}: ${err.message}`);
}
