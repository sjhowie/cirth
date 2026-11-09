import { ed, ui, write, join, waitFor, sleep } from '../lib.mjs';

export const name = '08 palette / quick open';

const PAL = '[role=dialog][aria-label="Command palette"]';
/** Row identity: dir + "/" + name when there is a dir (name segments are split by <mark>, so use textContent of spans). */
const rowPaths = (page) =>
  page.evaluate((sel) => [...document.querySelectorAll(`${sel} [role=option]`)].map((r) => {
    const name = r.querySelector('.name')?.textContent.replace(/\s+/g, '') ?? '';
    const dir = r.querySelector('.dir')?.textContent.replace(/\s+/g, '') ?? '';
    return dir ? `${dir}/${name}` : name;
  }), PAL);

async function openPalette(page, keys, text) {
  await page.keyboard.press(keys);
  await page.waitForSelector(`${PAL} input`);
  if (text) await page.keyboard.type(text);
}

export async function run(t) {
  const root = t.tmp();
  write(join(root, '.gitignore'), 'ignored.log\nbuild/\n');
  write(join(root, 'ignored.log'), 'x');
  write(join(root, 'build', 'out.js'), 'x');
  write(join(root, 'src', 'alpha.ts'), 'export const a = 1;\n');
  write(join(root, 'src', 'beta.ts'), 'export const b = 2;\n');
  write(join(root, 'src', 'deep', 'gamma.ts'), 'export const g = 3;\n');
  write(join(root, 'docs', 'readme.md'), '# readme\n');
  write(join(root, 'lines.txt'), Array.from({ length: 12 }, (_, i) => `line number ${i + 1} text`).join('\n'));
  const app = await t.launch({ args: [root] });
  const page = app.page;
  await page.waitForSelector('.tree .row');
  await page.locator('.cm-content').click();

  // ---- Ctrl+P lists real list_files ----
  await openPalette(page, 'Control+p');
  await waitFor(async () => (await rowPaths(page)).length >= 6, { timeout: 8000, label: 'file rows' }).catch(() => {});
  const all = (await rowPaths(page)).filter((p) => p !== 'Untitled-1').sort(); // the open untitled tab is listed too
  t.eq(all, ['.gitignore', 'docs/readme.md', 'lines.txt', 'src/alpha.ts', 'src/beta.ts', 'src/deep/gamma.ts'], 'quick open lists exactly the non-ignored files');
  t.ok(!all.some((p) => /ignored\.log|out\.js/.test(p)), 'gitignored file and folder are absent');

  // ---- typing filters, Enter opens ----
  await page.keyboard.type('alp');
  await waitFor(async () => (await rowPaths(page)).length === 1, { timeout: 3000, label: 'filtered' }).catch(() => {});
  t.eq(await rowPaths(page), ['src/alpha.ts'], 'typing "alp" filters to alpha.ts');
  await page.keyboard.press('Enter');
  await page.waitForSelector(PAL, { state: 'detached' });
  await waitFor(async () => (await ui.activeTitle(page)) === 'alpha.ts', { label: 'alpha.ts opened' });
  t.eq((await ed.doc(page)).trim(), 'export const a = 1;', 'Enter opened the highlighted file');

  // fuzzy / path matching
  await openPalette(page, 'Control+p', 'sdg');
  await waitFor(async () => (await rowPaths(page)).length >= 1, { timeout: 3000, label: 'fuzzy rows' }).catch(() => {});
  t.eq((await rowPaths(page))[0], 'src/deep/gamma.ts', 'fuzzy "sdg" finds src/deep/gamma.ts first');
  await page.keyboard.press('Escape');
  await page.waitForSelector(PAL, { state: 'detached' });

  // ---- :5 goes to line 5 ----
  await openPalette(page, 'Control+p', 'lines');
  await page.keyboard.press('Enter');
  await waitFor(async () => (await ui.activeTitle(page)) === 'lines.txt', { label: 'lines.txt opened' });
  await openPalette(page, 'Control+p', ':5');
  await page.keyboard.press('Enter');
  await page.waitForSelector(PAL, { state: 'detached' });
  await waitFor(async () => (await ed.selection(page)).line === 5, { timeout: 3000, label: 'cursor on line 5' }).catch(() => {});
  t.eq((await ed.selection(page)).line, 5, ':5 goes to line 5');
  t.ok(/Ln 5, Col 1/.test(await ui.status(page)), 'status bar shows Ln 5, Col 1');
  await openPalette(page, 'Control+p', ':9:4');
  await page.keyboard.press('Enter');
  await waitFor(async () => (await ed.selection(page)).line === 9, { timeout: 3000, label: 'cursor on line 9' }).catch(() => {});
  const s = await ed.selection(page);
  t.eq([s.line, s.col], [9, 4], ':9:4 goes to line 9, column 4');
  await openPalette(page, 'Control+p', ':999');
  await page.keyboard.press('Enter');
  await waitFor(async () => (await ed.selection(page)).line === 12, { timeout: 3000, label: 'clamped to last line' }).catch(() => {});
  t.eq((await ed.selection(page)).line, 12, ':999 clamps to the last line');

  // ---- Ctrl+Shift+P runs a command ----
  t.eq(await page.locator('.cm-content.cm-lineWrapping').count(), 0, 'word wrap off at start');
  await page.keyboard.press('Control+Shift+p');
  await page.waitForSelector(`${PAL} input`);
  t.eq(await page.locator(`${PAL} input`).inputValue(), '>', 'command palette starts with ">"');
  await page.keyboard.type('toggle word');
  await waitFor(async () => (await rowPaths(page)).length >= 1, { timeout: 3000, label: 'command rows' }).catch(() => {});
  t.ok((await rowPaths(page))[0].toLowerCase().includes('toggleword'), `top command is "Toggle Word Wrap" (${(await rowPaths(page))[0]})`);
  await page.keyboard.press('Enter');
  await page.waitForSelector(PAL, { state: 'detached' });
  await waitFor(async () => (await page.locator('.cm-content.cm-lineWrapping').count()) === 1, { timeout: 3000, label: 'wrap on' }).catch(() => {});
  t.eq(await page.locator('.cm-content.cm-lineWrapping').count(), 1, 'running "Toggle Word Wrap" from the palette turned wrapping on');

  // commands also list shortcuts and Escape closes without side effects
  await page.keyboard.press('Control+Shift+p');
  await page.waitForSelector(`${PAL} input`);
  t.ok((await page.locator(`${PAL} kbd`).count()) > 5, 'commands show their shortcuts');
  await page.keyboard.press('Escape');
  await page.waitForSelector(PAL, { state: 'detached' });
  t.eq(app.consoleErrors, [], 'no console errors');
}
