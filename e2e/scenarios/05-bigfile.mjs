import { openSync, writeSync, closeSync, statSync } from 'node:fs';
import { ed, ui, join, waitFor, sleep, processTreeMemory, readFileSync } from '../lib.mjs';

export const name = '05 big file (150 MB UTF-8 + 120 MB UTF-16LE CRLF)';

const MB = 1024 * 1024;
const mb = (n) => (n / MB).toFixed(0);

/**
 * Streams a pretty (indent 2) JSON array to disk until `target` bytes; returns exact facts about it
 * (document chars/lines, minified chars and head/tail). `utf16` writes UTF-16LE + BOM with CRLF.
 */
function generate(path, target, { utf16 = false } = {}) {
  const fd = openSync(path, 'w');
  let bytes = 0;
  let chars = 0;
  let lines = 1;
  let minChars = 0;
  let minHead = '[';
  let minTail = '';
  const emit = (s) => {
    const b = utf16 ? Buffer.from(s.replace(/\n/g, '\r\n'), 'utf16le') : Buffer.from(s, 'utf8');
    writeSync(fd, b);
    bytes += b.length;
    chars += s.length;
    lines += s.split('\n').length - 1;
  };
  if (utf16) {
    writeSync(fd, Buffer.from([0xff, 0xfe]));
    bytes += 2;
  }
  emit('[\n');
  minChars = 1;
  let i = 0;
  while (bytes < target) {
    const rec = { id: i, name: `item-${i}`, active: i % 2 === 0, tags: ['alpha', 'beta', `t${i % 97}`], nested: { k: i * 3, label: `café ${i}`, deep: { a: [i, i + 1, i + 2] } }, note: 'x'.repeat(i % 40) };
    const pretty = JSON.stringify(rec, null, 2).split('\n').map((l) => '  ' + l).join('\n');
    const min = JSON.stringify(rec);
    const minSep = i === 0 ? '' : ',';
    emit((i === 0 ? '' : ',\n') + pretty);
    minChars += (minSep + min).length;
    if (i < 3) minHead += minSep + min;
    minTail = min;
    i++;
  }
  emit('\n]');
  minChars += 1;
  closeSync(fd);
  return { bytes, chars, lines, minChars, records: i, minHead: minHead.slice(0, 80), minTail: minTail.slice(-60) };
}

async function timed(fn) {
  const t0 = performance.now();
  const r = await fn();
  return { ms: Math.round(performance.now() - t0), r };
}

const docSlice = (page, from, to) => page.evaluate(([f, t]) => document.querySelector('.cm-content').cmTile.view.state.sliceDoc(f, t), [from, to]);
const docInfo = (page) => ed.docInfo(page);

/** Utf-8 expectation for a minified body: BMP-only text, so utf8 bytes = chars + one extra byte per e-acute. */
async function openFile(page, label, file, timings, key) {
  const open = await timed(async () => {
    await page.locator('.tree button.row', { hasText: file }).click();
    await waitFor(async () => (await docInfo(page)).length > 0 && (await ui.activeTitle(page)) === file, { timeout: 120000, interval: 25, label: `${file} loaded` });
  });
  timings[key] = open.ms;
}

export async function run(t) {
  const dir = t.tmp();
  const p8 = join(dir, 'big150.json');
  const p16 = join(dir, 'big120-utf16.json');
  const f8 = generate(p8, 150 * MB);
  const f16 = generate(p16, 120 * MB, { utf16: true });
  t.info(`fixtures: UTF-8 ${mb(f8.bytes)} MB / ${f8.lines.toLocaleString()} lines; UTF-16LE+BOM+CRLF ${mb(f16.bytes)} MB / ${f16.lines.toLocaleString()} lines`);
  t.ok(f8.bytes >= 150 * MB && f16.bytes >= 120 * MB, 'fixtures have the target sizes');

  const app = await t.launch({ args: [dir], settings: { theme: 'light', fontFamily: 'Consolas', fontSize: 14, indent: '2', largeFileThresholdMb: 10, wordWrap: false } });
  const page = app.page;
  await page.waitForSelector('.tree .row .name:text-is("big150.json")');
  const timings = {};
  const mem = {};
  const snap = (label) => {
    const m = processTreeMemory(app.pid);
    const web = m['msedgewebview2.exe'] ?? 0;
    mem[label] = { webview2MB: +mb(web), appMB: +mb(m['simple-editor.exe'] ?? 0) };
    t.info(`memory ${label}: WebView2 children ${mb(web)} MB, simple-editor.exe ${mem[label].appMB} MB`);
  };
  snap('baseline');

  // ================= 150 MB UTF-8 =================
  await openFile(page, '150', 'big150.json', timings, 'open150');
  t.eq(await ui.lightBadge(page), 1, '150 MB: Light mode badge shown');
  t.eq((await docInfo(page)).length, f8.chars, '150 MB: document length equals expected chars');
  t.eq((await docInfo(page)).lines, f8.lines, '150 MB: line count equals expected');
  snap('after open 150MB');

  await ed.focus(page);
  await page.keyboard.press('Control+Home');
  const typeT = await timed(async () => {
    await page.keyboard.type(' ');
    await waitFor(async () => (await docInfo(page)).length === f8.chars + 1, { timeout: 15000, interval: 5, label: 'typed char in doc' });
  });
  timings.type150 = typeT.ms;
  t.eq((await docInfo(page)).length, f8.chars + 1, '150 MB: typing works in light mode');

  const minT = await timed(async () => {
    await page.keyboard.press('Control+Alt+M');
    await waitFor(async () => (await docInfo(page)).lines === 1, { timeout: 300000, interval: 50, label: 'minified doc' });
  });
  timings.minify150 = minT.ms;
  t.eq((await ui.toasts(page)).filter((x) => x.kind === 'error'), [], '150 MB: minify raised no error toast');
  t.eq((await docInfo(page)).length, f8.minChars, '150 MB: minified length matches the expected minified JSON');
  t.eq(await docSlice(page, 0, 80), f8.minHead, '150 MB: minified head matches');
  let len = (await docInfo(page)).length;
  t.eq(await docSlice(page, len - 61, len - 1), f8.minTail, '150 MB: minified tail matches');
  snap('after minify 150MB');

  const prettyT = await timed(async () => {
    await page.keyboard.press('Shift+Alt+F');
    await waitFor(async () => (await docInfo(page)).lines > 1000, { timeout: 300000, interval: 50, label: 'pretty-printed doc' });
  });
  timings.pretty150 = prettyT.ms;
  const info = await docInfo(page);
  t.eq(info.lines, f8.lines, '150 MB: pretty line count equals the original');
  t.eq(info.length, f8.chars, '150 MB: pretty length equals the original (leading space gone)');
  snap('after pretty 150MB');

  // Add one marker char so the save visibly changes the bytes, then save.
  await page.keyboard.press('Control+Home');
  await page.keyboard.type(' ');
  await waitFor(async () => (await docInfo(page)).length === f8.chars + 1, { timeout: 15000, interval: 5, label: 'marker typed' });
  const saveT = await timed(async () => {
    await page.keyboard.press('Control+s');
    await waitFor(() => statSync(p8).size === f8.bytes + 1, { timeout: 180000, interval: 25, label: '150 MB file saved' });
  });
  timings.save150 = saveT.ms;
  await sleep(2500);
  const buf = readFileSync(p8);
  t.eq(buf.length, f8.bytes + 1, '150 MB: saved size = original + 1 byte');
  t.eq(buf.subarray(0, 20).toString('utf8'), ' [\n  {\n    "id": 0,\n', '150 MB: saved head');
  t.eq(buf.subarray(buf.length - 3).toString('utf8'), '}\n]', '150 MB: saved tail ends with the closing bracket');
  t.eq(buf.indexOf(Buffer.from('\r')), -1, '150 MB: LF endings preserved');
  t.eq(await page.locator('[role=alert]', { hasText: 'Changed on disk' }).count(), 0, '150 MB: own save raises no "changed on disk" banner');
  t.eq((await ui.toasts(page)).filter((x) => x.kind === 'error'), [], '150 MB: no error toast after save');
  t.eq((await ui.tabs(page)).find((x) => x.title === 'big150.json')?.dirty, false, '150 MB: tab clean after save');
  snap('after save 150MB');

  // Close it before the next file.
  await page.keyboard.press('Control+w');
  await page.waitForTimeout(500);

  // ================= 120 MB UTF-16LE + BOM + CRLF =================
  await openFile(page, '120', 'big120-utf16.json', timings, 'open120utf16');
  t.eq(await ui.encoding(page), 'UTF-16 LE', '120 MB UTF-16: encoding detected');
  t.eq(await ui.eol(page), 'CRLF', '120 MB UTF-16: EOL detected');
  t.eq((await docInfo(page)).length, f16.chars, '120 MB UTF-16: document length equals expected chars');
  snap('after open 120MB UTF-16');
  await ed.focus(page);
  await page.keyboard.press('Control+Home');
  await page.keyboard.type(' ');
  await waitFor(async () => (await docInfo(page)).length === f16.chars + 1, { timeout: 15000, interval: 5, label: 'typed char (utf16)' });
  const orig16 = readFileSync(p16);
  const save16 = await timed(async () => {
    await page.keyboard.press('Control+s');
    await waitFor(() => statSync(p16).size === f16.bytes + 2, { timeout: 180000, interval: 25, label: 'UTF-16 file saved' });
  });
  timings.save120utf16 = save16.ms;
  await sleep(2500);
  const got16 = readFileSync(p16);
  const want16Head = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(' ', 'utf16le')]);
  t.eq(got16.length, f16.bytes + 2, '120 MB UTF-16: saved size = original + one UTF-16 unit');
  t.ok(got16.subarray(0, 4).equals(want16Head), 'UTF-16: BOM kept, typed space follows');
  t.ok(got16.subarray(4).equals(orig16.subarray(2)), '120 MB UTF-16: every other byte identical (encoding, CRLF and content preserved)');
  t.eq(await page.locator('[role=alert]', { hasText: 'Changed on disk' }).count(), 0, '120 MB UTF-16: no banner after own save');
  snap('final');

  console.log(`    TIMINGS ms: ${JSON.stringify(timings)}`);
  console.log(`    MEMORY MB: ${JSON.stringify(mem)}`);
  t.eq(app.consoleErrors, [], 'no console errors');
}
