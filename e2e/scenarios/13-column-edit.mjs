import { ed, write, join, readFileSync, waitFor } from '../lib.mjs';

export const name = '13 column edit';

const lines = ['alpha one', 'bravo two', 'charlie three', 'delta four'];

export async function run(t) {
  const dir = t.tmp();
  const file = write(join(dir, 'cols.txt'), lines.join('\n'));
  const app = await t.launch({ args: [file] });
  const page = app.page;
  await page.waitForFunction(() => document.querySelectorAll('.strip .tab').length === 1, null, { timeout: 15000 });
  await ed.focus(page);

  // Caret at line 1 col 3 (offset 2), Shift+Alt+Down x3 selects a 4-line column; typing inserts on every line.
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+Alt+ArrowDown');
  const n = await page.evaluate(() => {
    const v = (document.querySelector('.cm-content')?.cmTile ?? document.querySelector('.cm-content')?.cmView)?.view;
    return v.state.selection.ranges.length;
  });
  t.eq(n, 4, 'Shift+Alt+Down x3 gives 4 carets');
  await page.keyboard.type('X');
  await page.keyboard.press('Control+s');
  const expected1 = lines.map((l) => l.slice(0, 2) + 'X' + l.slice(2)).join('\n');
  await waitFor(() => readFileSync(file, 'utf8') === expected1, { label: 'column insert saved', timeout: 5000 }).catch(() => {});
  t.eq(readFileSync(file, 'utf8'), expected1, 'X inserted at col 3 on all 4 lines on disk');

  // Alt+drag across 3 lines, then Delete removes the boxed text.
  // Exact screen points from the editor (a .cm-line box includes its left padding).
  const [from, to] = await page.evaluate(() => {
    const v = (document.querySelector('.cm-content')?.cmTile ?? document.querySelector('.cm-content')?.cmView)?.view;
    const at = (lineNo, col) => {
      const c = v.coordsAtPos(v.state.doc.line(lineNo).from + col);
      return { x: c.left, y: (c.top + c.bottom) / 2 };
    };
    return [at(1, 5), at(3, 7)];
  });
  await page.keyboard.down('Alt');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Control+s');
  const afterDrag = lines.map((l) => l.slice(0, 2) + 'X' + l.slice(2));
  const expected2 = afterDrag.map((l, i) => (i < 3 ? l.slice(0, 5) + l.slice(7) : l)).join('\n');
  await waitFor(() => readFileSync(file, 'utf8') === expected2, { label: 'box delete saved', timeout: 5000 }).catch(() => {});
  t.eq(readFileSync(file, 'utf8'), expected2, 'Alt+drag over 3 lines then Delete removes cols 6-7 on those lines only');

  // Shift+Alt+Up selects (box), it does not copy the line.
  const before = await ed.doc(page);
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Shift+Alt+ArrowUp');
  t.eq(await ed.doc(page), before, 'Shift+Alt+Up leaves the document unchanged (no copy line)');
  const m = await page.evaluate(() => {
    const v = (document.querySelector('.cm-content')?.cmTile ?? document.querySelector('.cm-content')?.cmView)?.view;
    return v.state.selection.ranges.length;
  });
  t.eq(m, 2, 'Shift+Alt+Up extends the box to 2 ranges');
  await page.keyboard.press('Escape');
  const k = await page.evaluate(() => {
    const v = (document.querySelector('.cm-content')?.cmTile ?? document.querySelector('.cm-content')?.cmView)?.view;
    return v.state.selection.ranges.length;
  });
  t.eq(k, 1, 'Escape collapses to a single caret');

  // Tab inserts an indent at the caret (CodeMirror leaves Tab unbound by default); Shift+Tab outdents the line.
  const beforeTab = await ed.doc(page);
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Tab');
  const afterTab = await ed.doc(page);
  const indent = afterTab.slice(0, afterTab.length - beforeTab.length);
  t.eq(/^(\t| +)$/.test(indent) && afterTab === indent + beforeTab, true, `Tab inserts an indent at line start (got ${JSON.stringify(indent)})`);
  await page.keyboard.press('Control+s');
  await waitFor(() => readFileSync(file, 'utf8') === afterTab, { label: 'tab saved', timeout: 5000 }).catch(() => {});
  t.eq(readFileSync(file, 'utf8'), afterTab, 'the indent is saved to disk');
  await page.keyboard.press('Shift+Tab');
  t.eq(await ed.doc(page), beforeTab, 'Shift+Tab removes the indent');
  t.eq(app.consoleErrors, [], 'no console errors');
}
