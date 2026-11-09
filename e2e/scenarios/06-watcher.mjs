import { writeFileSync, unlinkSync } from 'node:fs';
import { ed, ui, write, join, readFileSync, existsSync, waitFor, sleep } from '../lib.mjs';

export const name = '06 watcher';

const banner = (page) => page.locator('[role=alert]', { hasText: 'Changed on disk' });
const tabOf = async (page, title) => (await ui.tabs(page)).find((x) => x.title === title);
const docIs = (page, text) => waitFor(async () => (await ed.doc(page)) === text, { timeout: 6000, label: `doc to equal ${JSON.stringify(text.slice(0, 30))}` }).then(() => true, () => false);

export async function run(t) {
  const root = t.tmp();
  const clean = write(join(root, 'clean.txt'), 'clean v1\n');
  const dirty = write(join(root, 'dirty.txt'), 'dirty v1\n');
  const del = write(join(root, 'del.txt'), 'delete me\n');
  const own = write(join(root, 'own.txt'), 'own v1\n');
  const app = await t.launch({ args: [root, clean, dirty, del, own] });
  const page = app.page;
  await page.waitForFunction(() => document.querySelectorAll('.strip .tab').length === 4, null, { timeout: 15000 });
  await sleep(500);

  // ---- clean file, active: external edit reloads ----
  await ui.clickTab(page, 'clean.txt');
  writeFileSync(clean, 'clean v2 from outside\n');
  t.ok(await docIs(page, 'clean v2 from outside\n'), 'clean active tab reloads after an external edit');
  t.ok(!(await tabOf(page, 'clean.txt')).dirty, 'reloaded tab is not dirty');
  t.eq(await banner(page).count(), 0, 'no banner for a clean tab');

  // ---- clean file, inactive: reloads too, shown when switching back ----
  await ui.clickTab(page, 'own.txt');
  writeFileSync(clean, 'clean v3 while inactive\n');
  await sleep(1200);
  await ui.clickTab(page, 'clean.txt');
  t.ok(await docIs(page, 'clean v3 while inactive\n'), 'inactive clean tab picked up the external edit');

  // ---- dirty file: banner, Keep mine, Reload ----
  await ui.clickTab(page, 'dirty.txt');
  await ed.typeAtEnd(page, 'MINE');
  writeFileSync(dirty, 'dirty v2 external\n');
  await banner(page).waitFor({ timeout: 6000 }).catch(() => {});
  t.eq(await banner(page).count(), 1, 'dirty tab shows the "Changed on disk" banner');
  t.eq(await ed.doc(page), 'dirty v1\nMINE', 'dirty content untouched while the banner is up');
  await banner(page).locator('button', { hasText: 'Keep mine' }).click();
  t.eq(await banner(page).count(), 0, 'Keep mine dismisses the banner');
  t.eq(await ed.doc(page), 'dirty v1\nMINE', 'Keep mine keeps my text');
  t.ok((await tabOf(page, 'dirty.txt')).dirty, 'tab still dirty after Keep mine');
  // A later external change raises it again.
  writeFileSync(dirty, 'dirty v3 external\n');
  await banner(page).waitFor({ timeout: 6000 }).catch(() => {});
  t.eq(await banner(page).count(), 1, 'banner returns on the next external change');
  await banner(page).locator('button', { hasText: 'Reload' }).click();
  t.ok(await docIs(page, 'dirty v3 external\n'), 'Reload takes the disk version');
  t.eq(await banner(page).count(), 0, 'Reload dismisses the banner');
  await waitFor(async () => !(await tabOf(page, 'dirty.txt')).dirty, { timeout: 3000, label: 'clean after reload' }).catch(() => {});
  t.ok(!(await tabOf(page, 'dirty.txt')).dirty, 'tab clean after Reload');
  await ed.focus(page);
  await page.keyboard.press('Control+z');
  t.eq(await ed.doc(page), 'dirty v1\nMINE', 'Reload is undoable (my text comes back)');
  // Keep mine then save overwrites disk with my text.
  writeFileSync(dirty, 'dirty v4 external\n');
  await banner(page).waitFor({ timeout: 6000 }).catch(() => {});
  await banner(page).locator('button', { hasText: 'Keep mine' }).click();
  await page.keyboard.press('Control+s');
  await waitFor(() => readFileSync(dirty, 'utf8') === 'dirty v1\nMINE', { timeout: 5000, label: 'my text saved over the external edit' }).catch(() => {});
  t.eq(readFileSync(dirty, 'utf8'), 'dirty v1\nMINE', 'Keep mine + Save overwrites the external version');
  await sleep(1000);
  t.eq(await banner(page).count(), 0, 'no banner after saving over it');

  // ---- external delete ----
  await ui.clickTab(page, 'del.txt');
  unlinkSync(del);
  await waitFor(async () => (await tabOf(page, 'del.txt')).deleted, { timeout: 6000, label: 'tab marked deleted' }).catch(() => {});
  t.ok((await tabOf(page, 'del.txt')).deleted, 'external delete marks the tab deleted');
  t.ok(/Deleted on disk/.test(await ui.status(page)), 'status bar says deleted on disk');
  t.ok((await page.locator('.strip [role=tab]', { hasText: 'del.txt' }).innerText()).includes('(deleted)'), 'tab label shows (deleted)');
  t.eq(await ed.doc(page), 'delete me\n', 'content stays in the editor');
  // Saving recreates it.
  await ed.focus(page);
  await page.keyboard.press('Control+s');
  await waitFor(() => existsSync(del), { timeout: 5000, label: 'file recreated' }).catch(() => {});
  t.ok(existsSync(del) && readFileSync(del, 'utf8') === 'delete me\n', 'Save recreates the deleted file');
  await sleep(800);
  t.ok(!(await tabOf(page, 'del.txt')).deleted, 'deleted flag cleared after save');

  // ---- our own save does not reload or banner ----
  await ui.clickTab(page, 'own.txt');
  await ed.typeAtEnd(page, 'abc');
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('Q');
  await page.keyboard.press('Control+s');
  await waitFor(() => readFileSync(own, 'utf8') === 'Qown v1\nabc'.replace('\n', '\n'), { timeout: 5000, label: 'own save on disk' }).catch(() => {});
  t.eq(readFileSync(own, 'utf8'), 'Qown v1\nabc', 'own save written');
  const before = await ed.selection(page);
  await sleep(1500); // watcher debounce (200 ms) + re-read
  t.eq(await banner(page).count(), 0, 'own save raises no banner');
  t.eq(await ed.doc(page), 'Qown v1\nabc', 'own save leaves the document alone');
  t.eq((await ed.selection(page)).from, before.from, 'cursor not moved by a spurious reload');
  await page.keyboard.press('Control+z');
  t.ok((await ed.doc(page)) !== 'Qown v1\nabc', 'undo history survives our own save (no reload happened)');
  t.eq(app.consoleErrors, [], 'no console errors');
}
