import { ed, write, join, readFileSync, waitFor } from '../lib.mjs';

export const name = '15 drag text';

// The drags here are dispatched through CDP, which bypasses Windows' OLE drag-and-drop, so they don't prove that
// Tauri's native drop handler is off (tauri.conf.json, dragDropEnabled); they cover the editor's drop handling.

/** Selects [from, to) in the active document (none if equal) and returns screen points for offset from+1 and for `dropAt`. */
async function selectAndLocate(page, from, to, dropAt) {
  return page.evaluate(
    ([from, to, dropAt]) => {
      const v = (document.querySelector('.cm-content')?.cmTile ?? document.querySelector('.cm-content')?.cmView)?.view;
      if (from !== to) v.dispatch({ selection: { anchor: from, head: to } });
      const mid = v.coordsAtPos(from + 1);
      const drop = v.coordsAtPos(dropAt);
      return { grab: { x: mid.left, y: (mid.top + mid.bottom) / 2 }, drop: { x: drop.left, y: (drop.top + drop.bottom) / 2 } };
    },
    [from, to, dropAt],
  );
}

async function tabCenter(page, index) {
  const box = await page.locator('.strip .tab').nth(index).boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export async function run(t) {
  const dir = t.tmp();
  const a = write(join(dir, 'a.txt'), 'one two three\n');
  const b = write(join(dir, 'b.txt'), 'XY\n');
  const app = await t.launch({ args: [a, b] });
  const page = app.page;
  await page.waitForFunction(() => document.querySelectorAll('.strip .tab').length === 2, null, { timeout: 15000 });
  await page.locator('.strip .tab').nth(0).locator('.label').click();
  await waitFor(async () => (await ed.doc(page)) === 'one two three\n', { label: 'a.txt shown' });

  // Within one document: dragging "two " to the start moves it.
  let p = await selectAndLocate(page, 4, 8, 0);
  await page.mouse.move(p.grab.x, p.grab.y);
  await page.mouse.down();
  await page.mouse.move(p.drop.x, p.drop.y, { steps: 8 });
  await page.mouse.up();
  t.eq(await ed.doc(page), 'two one three\n', 'dragging text within a document moves it');

  // Into another tab: rest on b.txt's tab until it opens, then drop after "X". The text leaves a.txt.
  p = await selectAndLocate(page, 0, 4, 0);
  await page.mouse.move(p.grab.x, p.grab.y);
  await page.mouse.down();
  const tabB = await tabCenter(page, 1);
  await page.mouse.move(tabB.x, tabB.y, { steps: 8 });
  await page.mouse.move(tabB.x + 2, tabB.y, { steps: 2 });
  await waitFor(async () => (await ed.doc(page)) === 'XY\n', { label: 'b.txt opened by hovering its tab', timeout: 3000 });
  const into = (await selectAndLocate(page, 0, 0, 1)).drop;
  await page.mouse.move(into.x, into.y, { steps: 8 });
  await page.mouse.up();
  t.eq(await ed.doc(page), 'Xtwo Y\n', 'the text is dropped into the other tab');

  await page.keyboard.press('Control+s');
  await waitFor(() => readFileSync(b, 'utf8') === 'Xtwo Y\n', { label: 'b.txt saved', timeout: 5000 }).catch(() => {});
  t.eq(readFileSync(b, 'utf8'), 'Xtwo Y\n', 'b.txt on disk has the dropped text');

  await page.locator('.strip .tab').nth(0).locator('.label').click();
  await waitFor(async () => (await ed.doc(page)) !== 'Xtwo Y\n', { label: 'a.txt shown again' });
  t.eq(await ed.doc(page), 'one three\n', 'the text left its source tab (a move, not a copy)');
  await page.keyboard.press('Control+z');
  t.eq(await ed.doc(page), 'two one three\n', 'Ctrl+Z in the source tab brings the text back');
  t.eq(app.consoleErrors, [], 'no console errors');
}
