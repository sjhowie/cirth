import { ed, ui, write, join, readFileSync, waitFor, sleep } from '../lib.mjs';

export const name = '03 tabs';

const lines = (p) => Array.from({ length: 300 }, (_, i) => `${p} line ${i + 1}`).join('\n');
const dirtyOf = async (page, title) => (await ui.tabs(page)).find((x) => x.title === title)?.dirty;

export async function run(t) {
  const dir = t.tmp();
  const files = ['a.txt', 'b.txt', 'c.txt'].map((f) => write(join(dir, f), lines(f[0])));
  const app = await t.launch({ args: files });
  const page = app.page;
  await page.waitForFunction(() => document.querySelectorAll('.strip .tab').length === 3, null, { timeout: 15000 });
  t.eq((await ui.tabs(page)).map((x) => x.title), ['a.txt', 'b.txt', 'c.txt'], 'three tabs open');
  t.eq(await ui.activeTitle(page), 'c.txt', 'last opened is active');
  t.eq(await page.locator('aside.sidebar').count(), 0, 'sidebar hidden when launched with files only (no folder)');
  await page.keyboard.press('Control+b');
  await page.locator('aside.sidebar .empty').waitFor({ timeout: 5000 });
  t.ok((await page.locator('aside.sidebar .empty').innerText()).includes('No folder open'), 'Ctrl+B shows the empty Explorer when no folder is open');
  await page.keyboard.press('Control+b');
  t.eq(await page.locator('aside.sidebar').count(), 0, 'Ctrl+B hides the sidebar again');

  // Edit each. a.txt gets two separate undo groups (start, then end) and is left scrolled.
  await ui.clickTab(page, 'a.txt');
  await ed.focus(page);
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('Y1');
  await sleep(700); // outside CodeMirror's 500 ms history grouping window
  await page.keyboard.press('Control+End');
  await page.keyboard.type('X1');
  await page.evaluate(() => (document.querySelector('.cm-scroller').scrollTop = 1500));
  await sleep(200);
  const aScroll = await ed.scrollTop(page);
  t.ok(aScroll > 1000, `a.txt scrolled (scrollTop ${aScroll})`);

  await ui.clickTab(page, 'b.txt');
  await ed.typeAtEnd(page, 'B1');
  await ui.clickTab(page, 'c.txt');
  await ed.typeAtEnd(page, 'C1');

  await waitFor(async () => (await ui.tabs(page)).every((x) => x.dirty), { label: 'all tabs dirty', timeout: 4000 }).catch(() => {});
  t.eq((await ui.tabs(page)).map((x) => x.dirty), [true, true, true], 'dirty dots on all three edited tabs');
  t.ok(/^● c\.txt/.test(await page.title()), `window title marks dirty (${await page.title()})`);

  // Switching preserves content.
  await ui.clickTab(page, 'a.txt');
  const aDoc = await ed.doc(page);
  t.ok(aDoc.startsWith('Y1a line 1\n') && aDoc.endsWith('a line 300X1'), 'a.txt content kept after switching away and back');
  const back = await ed.scrollTop(page);
  t.ok(Math.abs(back - aScroll) < 5, `a.txt scroll position restored (${aScroll} -> ${back})`);
  await ui.clickTab(page, 'b.txt');
  t.ok((await ed.doc(page)).endsWith('b line 300B1'), 'b.txt content kept');
  await ui.clickTab(page, 'c.txt');
  t.ok((await ed.doc(page)).endsWith('c line 300C1'), 'c.txt content kept');
  t.ok(!(await ed.doc(page)).includes('B1') && !(await ed.doc(page)).includes('X1'), 'no cross-tab content bleed');

  // Undo after switching back undoes the right edit (X1, the last one in a.txt), not Y1 and not another tab's edit.
  await ui.clickTab(page, 'a.txt');
  await ed.focus(page);
  await page.keyboard.press('Control+z');
  let d = await ed.doc(page);
  t.ok(d.startsWith('Y1a line 1\n') && d.endsWith('a line 300'), 'first Ctrl+Z removes X1 only');
  await page.keyboard.press('Control+z');
  d = await ed.doc(page);
  t.ok(d.startsWith('a line 1\n') && d.endsWith('a line 300'), 'second Ctrl+Z removes Y1');
  await waitFor(async () => !(await dirtyOf(page, 'a.txt')), { label: 'a.txt clean after undoing to saved state', timeout: 3000 }).catch(() => {});
  t.ok(!(await dirtyOf(page, 'a.txt')), 'a.txt is clean again after undoing everything');
  await page.keyboard.press('Control+y');
  t.ok((await ed.doc(page)).startsWith('Y1a line 1\n'), 'redo works after tab switches');
  await ui.clickTab(page, 'b.txt');
  t.ok((await ed.doc(page)).endsWith('b line 300B1'), 'b.txt untouched by a.txt undo');

  // Ctrl+W on a dirty tab: modal; Cancel keeps; Don't Save closes.
  await ui.clickTab(page, 'b.txt');
  await ed.focus(page);
  await page.keyboard.press('Control+w');
  await ui.dialog(page).waitFor();
  t.ok(/Save changes to b\.txt\?/.test(await ui.dialog(page).innerText()), 'close prompt names the file');
  await ui.dialogButton(page, 'Cancel').click();
  await ui.dialog(page).waitFor({ state: 'detached' });
  t.eq((await ui.tabs(page)).map((x) => x.title), ['a.txt', 'b.txt', 'c.txt'], 'Cancel keeps the tab');
  t.ok(await dirtyOf(page, 'b.txt'), 'tab still dirty after Cancel');

  await page.keyboard.press('Control+w');
  await ui.dialog(page).waitFor();
  await ui.dialogButton(page, "Don't Save").click();
  await ui.dialog(page).waitFor({ state: 'detached' });
  t.eq((await ui.tabs(page)).map((x) => x.title), ['a.txt', 'c.txt'], "Don't Save closes the tab");
  t.ok(readFileSync(files[1], 'utf8') === lines('b'), "Don't Save leaves b.txt on disk unchanged");
  t.eq(await ui.activeTitle(page), 'c.txt', 'neighbour tab becomes active');

  // The Save button of the prompt writes the file and closes the tab.
  await page.keyboard.press('Control+w');
  await ui.dialog(page).waitFor();
  await ui.dialogButton(page, 'Save').first().click();
  await ui.dialog(page).waitFor({ state: 'detached' });
  await waitFor(async () => (await ui.tabs(page)).length === 1, { label: 'c.txt closed after Save', timeout: 5000 }).catch(() => {});
  t.ok(readFileSync(files[2], 'utf8').endsWith('c line 300C1'), 'Save from the prompt writes the file');
  t.eq((await ui.tabs(page)).map((x) => x.title), ['a.txt'], 'tab closed after Save');
  t.eq(app.consoleErrors, [], 'no console errors');
}
