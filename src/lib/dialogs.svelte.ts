export interface DialogButton {
  label: string;
  value: string;
  primary?: boolean;
  danger?: boolean;
}

export interface DialogSpec {
  title: string;
  message: string;
  buttons: DialogButton[];
  /** Value returned for Escape / backdrop click. */
  cancelValue: string;
}

interface Pending extends DialogSpec {
  resolve: (value: string) => void;
}

export const dialogs = $state<{ queue: Pending[] }>({ queue: [] });

/** Shows an in-app modal and resolves with the clicked button's value. Calls queue. */
export function showDialog(spec: DialogSpec): Promise<string> {
  return new Promise((resolve) => {
    dialogs.queue = [...dialogs.queue, { ...spec, resolve }];
  });
}

export function answerDialog(value: string): void {
  const [current, ...rest] = dialogs.queue;
  if (!current) return;
  dialogs.queue = rest;
  current.resolve(value);
}
