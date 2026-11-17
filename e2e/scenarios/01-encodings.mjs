import { statSync, utimesSync } from 'node:fs';
import { ed, ui, write, join, readFileSync, encodeFor, waitBytes, waitFor, sleep } from '../lib.mjs';

export const name = '01 encodings';

const BASE = 'café line one\nsecond line\nthird line end';
const ENCODINGS = [
  { key: 'utf8', encoding: 'utf-8', bom: false, label: 'UTF-8' },
  { key: 'utf8bom', encoding: 'utf-8', bom: true, label: 'UTF-8 with BOM' },
  { key: 'u16le', encoding: 'utf-16le', bom: true, label: 'UTF-16 LE' },
  { key: 'u16be', encoding: 'utf-16be', bom: true, label: 'UTF-16 BE' },
  { key: 'w1252', encoding: 'windows-1252', bom: false, label: 'Windows-1252' },
];

export async function run(t) {
  const dir = t.tmp();
  const cases = [];
  for (const e of ENCODINGS) {
    for (const eol of ['lf', 'crlf']) {
      const file = join(dir, `${e.key}-${eol}.txt`);
      write(file, encodeFor(BASE, { ...e, eol }));
      cases.push({ ...e, eol, file, fname: `${e.key}-${eol}.txt` });
    }
  }
  // Extra files for the picker + unmappable-character cases.
  const pick = write(join(dir, 'pick.txt'), encodeFor(BASE, { encoding: 'utf-16le', bom: true, eol: 'crlf' }));
  const w = write(join(dir, 'unmappable.txt'), encodeFor(BASE, { encoding: 'windows-1252', bom: false, eol: 'lf' }));
  // CR-only line endings (classic Mac); encodeFor knows LF/CRLF only, so build the bytes here.
  const crBytes = Buffer.from(BASE.replace(/\n/g, '\r'), 'utf8');
  const cr = write(join(dir, 'cr-only.txt'), crBytes);
  utimesSync(cr, new Date('2020-01-01'), new Date('2020-01-01'));
  // UTF-8 with BOM plus one byte (0xFF) that is never valid UTF-8: opens lossy.
  const lossyBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ab'), Buffer.from([0xff]), Buffer.from('cd\n')]);
  const lossy = write(join(dir, 'lossy.txt'), lossyBytes);

  const app = await t.launch({ args: [...cases.map((c) => c.file), pick, w, cr, lossy] });
  const page = app.page;
  await page.waitForFunction((n) => document.querySelectorAll('.strip .tab').length >= n, cases.length + 4, { timeout: 20000 });

  for (const c of cases) {
    await ui.clickTab(page, c.fname);
    t.eq(await ui.encoding(page), c.label, `${c.fname}: status encoding`);
    t.eq(await ui.eol(page), c.eol.toUpperCase(), `${c.fname}: status EOL`);
    t.eq(await ed.doc(page), BASE, `${c.fname}: decoded document`);
    await ed.typeAtEnd(page, 'Z');
    await page.keyboard.press('Control+s');
    const expected = encodeFor(BASE + 'Z', c);
    const got = await waitBytes(c.file, expected);
    const ok = await page.waitForFunction(() => !document.querySelector('.strip .tab.active .dot'), null, { timeout: 5000 }).then(() => true, () => false);
    t.ok(ok, `${c.fname}: dirty dot cleared after save`);
    t.ok(got.equals(expected), `${c.fname}: bytes keep encoding/BOM/EOL (got ${got.subarray(0, 8).toString('hex')}... len ${got.length}, want len ${expected.length})`);
  }

  // Change EOL to LF and encoding to UTF-8 via the pickers on a UTF-16LE+BOM CRLF file.
  await ui.clickTab(page, 'pick.txt');
  await ui.pickStatus(page, 'End of line', 'LF');
  await ui.pickStatus(page, 'Save with encoding', 'UTF-8');
  t.eq(await ui.eol(page), 'LF', 'picker: EOL shows LF');
  t.eq(await ui.encoding(page), 'UTF-8', 'picker: encoding shows UTF-8');
  t.ok((await ui.tabs(page)).find((x) => x.title === 'pick.txt')?.dirty, 'picker: meta change marks tab dirty');
  await page.keyboard.press('Control+s');
  t.ok((await waitBytes(pick, Buffer.from(BASE, 'utf8'))).equals(Buffer.from(BASE, 'utf8')), 'picker: file is now UTF-8, no BOM, LF');

  // And back to UTF-8 with BOM + CRLF.
  await ui.pickStatus(page, 'End of line', 'CRLF');
  await ui.pickStatus(page, 'Save with encoding', 'UTF-8 with BOM');
  await page.keyboard.press('Control+s');
  const want2 = encodeFor(BASE, { encoding: 'utf-8', bom: true, eol: 'crlf' });
  t.ok((await waitBytes(pick, want2)).equals(want2), 'picker: UTF-8 BOM + CRLF bytes');

  // Unmappable char saved as windows-1252: error toast, file untouched.
  await ui.clickTab(page, 'unmappable.txt');
  t.eq(await ui.encoding(page), 'Windows-1252', 'unmappable: encoding');
  const before = readFileSync(w);
  await ui.clearToasts(page);
  await ed.typeAtEnd(page, '日');
  await page.keyboard.press('Control+s');
  const toast = await page.waitForSelector('.toast.error', { timeout: 5000 }).then(() => true, () => false);
  t.ok(toast, 'unmappable: error toast shown');
  const msgs = (await ui.toasts(page)).map((x) => x.text).join(' | ');
  t.ok(/cannot save as windows-1252/i.test(msgs), `unmappable: toast message mentions encoding (${msgs})`);
  t.ok(readFileSync(w).equals(before), 'unmappable: file bytes untouched');
  t.ok((await ui.tabs(page)).find((x) => x.title === 'unmappable.txt')?.dirty, 'unmappable: tab still dirty');

  // CR-only file: detected as CR, saved unchanged it is byte-identical, an edit keeps CR breaks.
  await ui.clickTab(page, 'cr-only.txt');
  t.eq(await ui.eol(page), 'CR', 'cr: status EOL shows CR');
  t.eq(await ed.doc(page), BASE, 'cr: decoded document has three lines');
  await ed.focus(page);
  await page.keyboard.press('Control+s');
  const crSaved = await waitFor(() => statSync(cr).mtimeMs > new Date('2020-01-02').getTime(), { timeout: 5000, label: 'cr-only.txt rewritten' }).then(() => true, () => false);
  t.ok(crSaved, 'cr: Ctrl+S rewrote the file');
  t.ok(readFileSync(cr).equals(crBytes), 'cr: unchanged save is byte-identical');
  await ed.typeAtEnd(page, 'Z');
  await page.keyboard.press('Control+s');
  const crWant = Buffer.from((BASE + 'Z').replace(/\n/g, '\r'), 'utf8');
  t.ok((await waitBytes(cr, crWant)).equals(crWant), 'cr: edited save keeps CR line breaks');
  await ui.pickStatus(page, 'End of line', 'LF');
  t.eq(await ui.eol(page), 'LF', 'cr: picker offers CR -> LF');
  await ui.pickStatus(page, 'End of line', 'CR');
  t.eq(await ui.eol(page), 'CR', 'cr: picker offers LF -> CR');

  // Lossy file: persistent notice, and saving asks first (Cancel writes nothing, Save anyway writes U+FFFD).
  await ui.clickTab(page, 'lossy.txt');
  t.eq(await ed.doc(page), 'ab�cd\n', 'lossy: invalid byte decoded as U+FFFD');
  const notice = page.locator('.banner.lossy');
  t.ok(await notice.isVisible(), 'lossy: notice shown for the tab');
  const noticeText = await notice.innerText();
  t.ok(/UTF-8 with BOM/.test(noticeText) && noticeText.includes('�'), `lossy: notice names the encoding and the replacement character (${noticeText})`);
  await ui.clickTab(page, 'cr-only.txt');
  t.eq(await page.locator('.banner.lossy').count(), 0, 'lossy: notice is per tab (absent on a clean tab)');
  await ui.clickTab(page, 'lossy.txt');
  await ed.focus(page);
  await page.keyboard.press('Control+s');
  await ui.dialog(page).waitFor({ timeout: 5000 });
  t.ok(/replacement characters/.test(await ui.dialog(page).innerText()), 'lossy: save asks before writing replacement characters');
  await ui.dialogButton(page, 'Cancel').click();
  await ui.dialog(page).waitFor({ state: 'detached' });
  await sleep(300);
  t.ok(readFileSync(lossy).equals(lossyBytes), 'lossy: Cancel leaves the file untouched');
  await page.keyboard.press('Control+s');
  await ui.dialog(page).waitFor({ timeout: 5000 });
  await ui.dialogButton(page, 'Save anyway').click();
  const lossyWant = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ab�cd\n', 'utf8')]);
  t.ok((await waitBytes(lossy, lossyWant)).equals(lossyWant), 'lossy: Save anyway writes U+FFFD as UTF-8, keeping the BOM');
  await waitFor(async () => (await page.locator('.banner.lossy').count()) === 0, { timeout: 3000, label: 'lossy notice gone' }).catch(() => {});
  t.eq(await page.locator('.banner.lossy').count(), 0, 'lossy: notice gone after the replacement characters are saved');
  await page.keyboard.press('Control+s');
  const askedAgain = await ui.dialog(page).waitFor({ timeout: 1000 }).then(() => true, () => false);
  t.ok(!askedAgain, 'lossy: asks once per tab');

  t.eq(app.consoleErrors.filter((x) => !/write_file failed/.test(x)), [], 'no unexpected console errors');
}
