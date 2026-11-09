import { ed, ui, write, join, readFileSync, encodeFor, waitFor } from '../lib.mjs';

export const name = '09 folder search / replace';

const summary = (page) => page.locator('.summary').first().innerText().then((s) => s.replace(/\s+/g, ' ').trim()).catch(() => '');
const groups = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.results .group')]
      .map((g) => ({ rel: g.querySelector('.rel').textContent, count: Number(g.querySelector('.count').textContent), lines: [...g.querySelectorAll('.match .ln')].map((l) => Number(l.textContent)) }))
      .sort((a, b) => a.rel.localeCompare(b.rel)),
  );

async function waitSummary(page, re, label) {
  await waitFor(async () => re.test(await summary(page)) && !(await page.locator('.summary .spin').count()), { timeout: 8000, label }).catch(() => {});
  return summary(page);
}

async function setQuery(page, text) {
  const q = page.locator('input[aria-label="Search query"]');
  await q.fill(text);
  await q.press('Enter');
}

const toggle = (page, title) => page.locator(`.field button[title="${title}"]`).click();

export async function run(t) {
  const root = t.tmp();
  const A = 'foo bar\nFoo baz\nfoobar\nZ';
  const CRLF = 'foo one\nbar foo\n';
  const U16 = 'foo in utf16\nsecond foo line\n';
  write(join(root, '.gitignore'), 'ignored.log\n');
  write(join(root, 'ignored.log'), 'foo foo foo\n');
  const a = write(join(root, 'a.txt'), encodeFor(A.slice(0, -1), { encoding: 'utf-8', bom: false, eol: 'lf' }));
  const crlf = write(join(root, 'crlf.txt'), encodeFor(CRLF, { encoding: 'utf-8', bom: false, eol: 'crlf' }));
  const u16 = write(join(root, 'u16.txt'), encodeFor(U16, { encoding: 'utf-16le', bom: true, eol: 'crlf' }));
  write(join(root, 'sub', 'b.js'), 'foo();\n');
  write(join(root, 'sub', 'c.md'), 'nothing here\n');
  const binBytes = Buffer.from([0x66, 0x6f, 0x6f, 0, 1, 2, 0, 0x66, 0x6f, 0x6f]);
  write(join(root, 'bin.dat'), binBytes);

  const app = await t.launch({ args: [root] });
  const page = app.page;
  await page.waitForSelector('.tree .row');
  await page.locator('.cm-content').click();

  // ---- search box sits under the Explorer header; results replace the tree; Esc / x restore it ----
  t.ok(
    await page.evaluate(() => {
      const kids = [...document.querySelector('.explorer').children];
      return kids[0].classList.contains('head') && kids[1].classList.contains('form') && !!kids[1].querySelector('input[aria-label="Search query"]');
    }),
    'search box is directly under the Explorer header',
  );
  t.eq(await page.locator('.explorer .form .mag').count(), 1, 'search box has a magnifier icon');
  t.eq(await page.locator('.explorer .form .clear').count(), 0, 'no clear button while the box is empty');
  t.eq(await page.locator('.explorer .form input[aria-label="Replacement"]').count(), 0, 'replace row hidden by default');
  await page.locator('.explorer .form input[placeholder^="e.g. *.ts"]').count().then((n) => t.eq(n, 0, 'file filters hidden by default'));
  await page.locator('input[aria-label="Search query"]').fill('foo');
  await waitSummary(page, /results? in/, 'tree-replacing results');
  t.eq(await page.locator('.explorer .tree').count(), 0, 'typing replaces the tree with results');
  await page.locator('.explorer .form .clear').click();
  await page.waitForSelector('.explorer .tree .row');
  t.eq([await page.locator('.explorer .results').count(), await page.locator('input[aria-label="Search query"]').inputValue()], [0, ''], 'x clear button restores the tree and empties the box');
  await page.locator('input[aria-label="Search query"]').fill('foo');
  await waitSummary(page, /results? in/, 'results again');
  await page.locator('input[aria-label="Search query"]').press('Escape');
  await page.waitForSelector('.explorer .tree .row');
  t.eq([await page.locator('.explorer .results').count(), await page.locator('input[aria-label="Search query"]').inputValue()], [0, ''], 'Esc restores the tree and empties the box');

  // ---- Ctrl+Shift+F focuses the box, search "foo" ----
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Shift+f');
  await page.waitForSelector('input[aria-label="Search query"]');
  t.ok(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Search query'), 'Ctrl+Shift+F focuses the search box');
  await setQuery(page, 'foo');
  t.eq(await waitSummary(page, /results? in/, 'summary'), '8 results in 4 files', 'foo: 8 results in 4 files (gitignored + binary files skipped)');
  t.eq(
    await groups(page),
    [
      { rel: 'a.txt', count: 3, lines: [1, 2, 3] },
      { rel: 'crlf.txt', count: 2, lines: [1, 2] },
      { rel: 'sub/b.js', count: 1, lines: [1] },
      { rel: 'u16.txt', count: 2, lines: [1, 2] },
    ],
    'per-file groups and line numbers (CRLF and UTF-16 files counted correctly)',
  );

  // ---- toggles ----
  await toggle(page, 'Match Case');
  t.eq(await waitSummary(page, /^7 results/, 'case'), '7 results in 4 files', 'Match Case: 7 results');
  await toggle(page, 'Match Case');
  await toggle(page, 'Match Whole Word');
  t.eq(await waitSummary(page, /^7 results/, 'word'), '7 results in 4 files', 'Whole Word: 7 results (foobar excluded)');
  const aWord = (await groups(page)).find((g) => g.rel === 'a.txt');
  t.eq(aWord?.lines, [1, 2], 'whole word: a.txt lines 1 and 2 only');
  await toggle(page, 'Match Whole Word');
  await setQuery(page, 'ba[rz]');
  t.eq(await waitSummary(page, /^(No results|\d+ results?)/, 'literal'), 'No results', 'literal "ba[rz]" finds nothing');
  await toggle(page, 'Use Regular Expression');
  t.eq(await waitSummary(page, /^4 results/, 'regex'), '4 results in 2 files', 'regex ba[rz]: 4 results in 2 files');
  await setQuery(page, '(');
  await page.waitForSelector('.error[role=alert]', { timeout: 5000 }).catch(() => {});
  t.eq(await page.locator('.error[role=alert]').count(), 1, 'bad regex shows an inline error');
  await toggle(page, 'Use Regular Expression');
  await page.locator('.error[role=alert]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});

  // ---- include / exclude globs ----
  await setQuery(page, 'foo');
  await waitSummary(page, /^8 results/, 'back to 8');
  await page.locator('button[aria-label="Toggle search options"]').click();
  await page.locator('input[placeholder^="e.g. *.ts"]').fill('*.js');
  t.eq(await waitSummary(page, /^1 result in 1 file/, 'include'), '1 result in 1 file', 'include *.js: only b.js');
  await page.locator('input[placeholder^="e.g. *.ts"]').fill('');
  await page.locator('input[placeholder^="e.g. **"]').fill('*.txt');
  t.eq(await waitSummary(page, /^1 result in 1 file/, 'exclude'), '1 result in 1 file', 'exclude *.txt: only b.js left');
  await page.locator('input[placeholder^="e.g. **"]').fill('');
  t.eq(await waitSummary(page, /^8 results/, 'cleared'), '8 results in 4 files', 'clearing globs restores 8 results');

  // ---- click a result: opens and selects the match ----
  const u16Group = page.locator('.results .group', { has: page.locator('.rel', { hasText: 'u16.txt' }) });
  await u16Group.locator('.match').nth(1).click();
  await waitFor(async () => (await ui.activeTitle(page)) === 'u16.txt', { label: 'u16.txt opened' });
  let sel = await ed.selection(page);
  t.eq([sel.text, sel.line], ['foo', 2], 'UTF-16 result: opens file and selects "foo" on line 2');
  t.eq(await ui.encoding(page), 'UTF-16 LE', 'UTF-16 file keeps its encoding when opened from search');
  const aGroup = page.locator('.results .group', { has: page.locator('.rel', { hasText: /^a\.txt$/ }) });
  await aGroup.locator('.match').nth(1).click();
  await waitFor(async () => (await ui.activeTitle(page)) === 'a.txt', { label: 'a.txt opened' });
  sel = await ed.selection(page);
  t.eq([sel.text, sel.line, sel.fromCol], ['Foo', 2, 1], 'a.txt result: selects "Foo" at 2:1');
  const crlfGroup = page.locator('.results .group', { has: page.locator('.rel', { hasText: 'crlf.txt' }) });
  await crlfGroup.locator('.match').nth(1).click();
  await waitFor(async () => (await ui.activeTitle(page)) === 'crlf.txt', { label: 'crlf.txt opened' });
  sel = await ed.selection(page);
  t.eq([sel.text, sel.line, sel.fromCol], ['foo', 2, 5], 'CRLF result: selects "foo" at 2:5');

  // ---- Replace All: dirty open file skipped, encoding/EOL preserved ----
  await ui.clickTab(page, 'a.txt');
  await ed.typeAtEnd(page, 'Z');
  await waitFor(async () => (await ui.tabs(page)).find((x) => x.title === 'a.txt').dirty, { timeout: 3000, label: 'a.txt dirty' }).catch(() => {});
  // (search options stay open from the glob section above)
  await page.locator('input[aria-label="Replacement"]').fill('QUX');
  await setQuery(page, 'foo');
  await waitSummary(page, /^8 results/, 'results before replace');
  await page.locator('button[title^="Replace All"]').click();
  await ui.dialog(page).waitFor();
  const dlg = await ui.dialog(page).innerText();
  t.ok(/Replace 5 occurrences in 3 files\?/.test(dlg), `dialog counts only non-dirty files (${dlg.split('\n')[0]})`);
  t.ok(/1 file with unsaved changes skipped/.test(dlg), 'dialog says the dirty file is skipped');
  await ui.dialogButton(page, 'Cancel').click();
  t.ok(readFileSync(crlf).equals(encodeFor(CRLF, { encoding: 'utf-8', bom: false, eol: 'crlf' })), 'Cancel changes nothing');
  await page.locator('button[title^="Replace All"]').click();
  await ui.dialog(page).waitFor();
  await ui.dialogButton(page, 'Replace All').click();
  await ui.dialog(page).waitFor({ state: 'detached' });
  const wantCrlf = encodeFor('QUX one\nbar QUX\n', { encoding: 'utf-8', bom: false, eol: 'crlf' });
  const wantU16 = encodeFor('QUX in utf16\nsecond QUX line\n', { encoding: 'utf-16le', bom: true, eol: 'crlf' });
  await waitFor(() => readFileSync(crlf).equals(wantCrlf), { timeout: 5000, label: 'crlf replaced' }).catch(() => {});
  t.ok(readFileSync(crlf).equals(wantCrlf), 'CRLF file: replaced, still UTF-8 + CRLF');
  t.ok(readFileSync(u16).equals(wantU16), `UTF-16LE file: replaced, BOM and CRLF kept (${readFileSync(u16).subarray(0, 8).toString('hex')})`);
  t.eq(readFileSync(join(root, 'sub', 'b.js'), 'utf8'), 'QUX();\n', 'b.js replaced');
  t.ok(readFileSync(a).equals(encodeFor(A.slice(0, -1), { encoding: 'utf-8', bom: false, eol: 'lf' })), 'dirty open file a.txt skipped on disk');
  t.eq(await ed.doc(page), A, 'dirty a.txt editor content untouched (my Z kept)');
  t.eq(readFileSync(join(root, 'ignored.log'), 'utf8'), 'foo foo foo\n', 'gitignored file untouched');
  t.ok(readFileSync(join(root, 'bin.dat')).equals(binBytes), 'binary file untouched');
  // The clean open tab (crlf.txt) reloads through the watcher.
  await ui.clickTab(page, 'crlf.txt');
  await waitFor(async () => (await ed.doc(page)) === 'QUX one\nbar QUX\n', { timeout: 5000, label: 'open clean tab reloaded' }).catch(() => {});
  t.eq(await ed.doc(page), 'QUX one\nbar QUX\n', 'open clean tab shows the replaced text');
  t.eq(await ui.eol(page), 'CRLF', 'reloaded tab still CRLF');
  // After replace the search re-runs: only a.txt (skipped) still matches foo.
  const after = await waitSummary(page, /^3 results in 1 file/, 'post-replace summary');
  t.eq(after, '3 results in 1 file', 'post-replace search re-run: only the skipped a.txt still has matches');
  t.eq(app.consoleErrors.filter((x) => !/search_folder/.test(x)), [], 'no unexpected console errors');
}
