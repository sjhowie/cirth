import { ed, ui, write, join, readFileSync, closeMainWindow, waitFor, sleep } from '../lib.mjs';

export const name = '10 close window';

const dirtyOf = async (page, title) => (await ui.tabs(page)).find((x) => x.title === title)?.dirty;

export async function run(t) {
  const dir = t.tmp();
  const f1 = write(join(dir, 'one.txt'), 'one\n');
  const f2 = write(join(dir, 'two.txt'), 'two\n');

  // ---- Cancel keeps the app, Discard exits ----
  let app = await t.launch({ args: [f1, f2] });
  let page = app.page;
  await page.waitForFunction(() => document.querySelectorAll('.strip .tab').length === 2, null, { timeout: 15000 });
  await ui.clickTab(page, 'one.txt');
  await ed.typeAtEnd(page, 'edit');
  await waitFor(async () => dirtyOf(page, 'one.txt'), { timeout: 3000, label: 'one.txt dirty' }).catch(() => {});
  t.ok(await dirtyOf(page, 'one.txt'), 'tab is dirty before closing');

  t.ok(closeMainWindow(app.pid), 'WM_CLOSE delivered to the main window');
  await ui.dialog(page).waitFor({ timeout: 8000 });
  const text = await ui.dialog(page).innerText();
  t.ok(/Unsaved changes/.test(text) && /one\.txt/.test(text) && !/two\.txt/.test(text), `prompt lists only the dirty file (${text.replace(/\s+/g, ' ').slice(0, 90)})`);

  // A second close request (X again, Alt+F4) while the prompt is open must not destroy the window.
  t.ok(closeMainWindow(app.pid), 'WM_CLOSE delivered while the prompt is open');
  await sleep(1500);
  t.ok(!app.exited(), 'second close request while prompting keeps the app running');
  t.eq(await ui.dialog(page).count(), 1, 'the unsaved-changes prompt is still up (and not stacked twice)');
  t.eq(await ed.doc(page), 'one\nedit', 'document intact after the second close request');

  await ui.dialogButton(page, 'Cancel').click();
  await ui.dialog(page).waitFor({ state: 'detached' });
  await sleep(1500);
  t.ok(!app.exited(), 'Cancel keeps the app running');
  t.ok(await dirtyOf(page, 'one.txt'), 'edit still there after Cancel');
  t.eq(await ed.doc(page), 'one\nedit', 'document intact after Cancel');

  // Closing again after Cancel must prompt again (re-entrancy guard reset).
  t.ok(closeMainWindow(app.pid), 'second WM_CLOSE delivered');
  await ui.dialog(page).waitFor({ timeout: 8000 });
  t.ok(true, 'second close request prompts again');
  await ui.dialogButton(page, 'Discard').click();
  await waitFor(() => app.exited(), { timeout: 10000, label: 'process exit after Discard' }).catch(() => {});
  t.ok(app.exited(), 'Discard exits the process');
  t.eq(readFileSync(f1, 'utf8'), 'one\n', 'Discard leaves the file unchanged');

  // ---- Save All saves then exits ----
  app = await t.relaunch(app, { args: [f1, f2] });
  page = app.page;
  await page.waitForFunction(() => document.querySelectorAll('.strip .tab').length === 2, null, { timeout: 15000 });
  await ui.clickTab(page, 'one.txt');
  await ed.typeAtEnd(page, 'A');
  await ui.clickTab(page, 'two.txt');
  await ed.typeAtEnd(page, 'B');
  await sleep(400);
  t.ok(closeMainWindow(app.pid), 'WM_CLOSE delivered (two dirty tabs)');
  await ui.dialog(page).waitFor({ timeout: 8000 });
  t.ok(/2 files have unsaved changes/.test(await ui.dialog(page).innerText()), 'prompt counts both dirty files');
  await ui.dialogButton(page, 'Save All').click();
  await waitFor(() => app.exited(), { timeout: 10000, label: 'process exit after Save All' }).catch(() => {});
  t.ok(app.exited(), 'Save All exits the process');
  t.eq([readFileSync(f1, 'utf8'), readFileSync(f2, 'utf8')], ['one\nA', 'two\nB'], 'Save All wrote both files before exiting');

  // ---- No dirty tabs: closes straight away ----
  app = await t.relaunch(app, { args: [f1] });
  page = app.page;
  await page.waitForFunction(() => document.querySelectorAll('.strip .tab').length === 1, null, { timeout: 15000 });
  t.ok(closeMainWindow(app.pid), 'WM_CLOSE delivered (clean)');
  await waitFor(() => app.exited(), { timeout: 10000, label: 'clean exit' }).catch(() => {});
  t.ok(app.exited(), 'a clean window closes without a prompt');
}
