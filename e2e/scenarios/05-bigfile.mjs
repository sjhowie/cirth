import { openSync, writeSync, closeSync, statSync } from 'node:fs';
import { ed, ui, join, waitFor, sleep, processTreeMemory, readFileSync } from '../lib.mjs';

export const name = '05 big file (150 MB open/type, 90 MB format+save)';

const MB = 1024 * 1024;
const mb = (n) => (n / MB).toFixed(0);

/** Streams a pretty (indent 2) JSON array to disk; returns exact facts about it and its minified form. */
function generate(path, target) {
  const fd = openSync(path, 'w');
  let size = 0;
  let lines = 0;
  let minLen = 0;
  let minHead = '[';
  let minTail = '';
  const emit = (s) => {
    const b = Buffer.from(s, 'utf8');
    writeSync(fd, b);
    size += b.length;
    lines += s.split('\n').length - 1;
  };
  emit('[\n');
  minLen = 1;
  let i = 0;
  while (size < target) {
    const rec = { id: i, name: `item-${i}`, active: i % 2 === 0, tags: ['alpha', 'beta', `t${i % 97}`], nested: { k: i * 3, label: `café ${i}`, deep: { a: [i, i + 1, i + 2] } }, note: 'x'.repeat(i % 40) };
    const pretty = JSON.stringify(rec, null, 2).split('\n').map((l) => '  ' + l).join('\n');
    const min = JSON.stringify(rec);
    const minSep = i === 0 ? '' : ',';
    emit((i === 0 ? '' : ',\n') + pretty);
    minLen += Buffer.byteLength(minSep + min, 'utf8');
    if (i < 3) minHead += minSep + min;
    minTail = min;
    i++;
  }
  emit('\n]');
  minLen += 1;
  closeSync(fd);
  // One 2-byte char (e-acute) per record: document chars = bytes - records.
  return { size, chars: size - i, lines: lines + 1, minChars: minLen - i, minLen, records: i, minHead: minHead.slice(0, 80), minTail: minTail.slice(-60) };
}

async function timed(fn) {
  const t0 = performance.now();
  const r = await fn();
  return { ms: Math.round(performance.now() - t0), r };
}

const docSlice = (page, from, to) => page.evaluate(([f, t]) => document.querySelector('.cm-content').cmTile.view.state.sliceDoc(f, t), [from, to]);

export async function run(t) {
  const dir = t.tmp();
  const bigPath = join(dir, 'big150.json');
  const midPath = join(dir, 'mid90.json');
  const big = generate(bigPath, 150 * MB);
  const mid = generate(midPath, 90 * MB);
  t.info(`fixtures: big150 ${mb(big.size)} MB / ${big.lines.toLocaleString()} lines; mid90 ${mb(mid.size)} MB / ${mid.lines.toLocaleString()} lines`);

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

  // ---------- 150 MB: open, badge, type; format/save refused cleanly (WebView2 request-body limit) ----------
  const open = await timed(async () => {
    await page.locator('.tree button.row', { hasText: 'big150.json' }).click();
    await waitFor(async () => (await ed.docInfo(page)).length > 0 && (await ui.activeTitle(page)) === 'big150.json', { timeout: 120000, interval: 25, label: 'big150.json loaded' });
  });
  timings.open150 = open.ms;
  t.eq(await ui.lightBadge(page), 1, '150 MB: Light mode badge shown');
  t.eq((await ed.docInfo(page)).length, big.chars, '150 MB: document length equals file size in chars');
  snap('after open 150MB');

  await ed.focus(page);
  await page.keyboard.press('Control+Home');
  const typeT = await timed(async () => {
    await page.keyboard.type(' ');
    await waitFor(async () => (await ed.docInfo(page)).length === big.chars + 1, { timeout: 15000, interval: 5, label: 'typed char in doc' });
  });
  timings.type150 = typeT.ms;
  t.eq((await ed.docInfo(page)).length, big.chars + 1, '150 MB: typing works in light mode');

  await ui.clearToasts(page);
  await page.keyboard.press('Control+Alt+M');
  await page.waitForSelector('.toast.error', { timeout: 30000 });
  const msg = (await ui.toasts(page)).find((x) => x.kind === 'error')?.text ?? '';
  t.ok(/limit/.test(msg) && /format_json/.test(msg), `150 MB: minify is refused with an explanatory error toast (${msg})`);
  t.eq((await ed.docInfo(page)).length, big.chars + 1, '150 MB: document untouched by the refused minify');
  await ui.clearToasts(page);
  await page.keyboard.press('Control+s');
  await page.waitForSelector('.toast.error', { timeout: 30000 });
  const msg2 = (await ui.toasts(page)).find((x) => x.kind === 'error')?.text ?? '';
  t.ok(/write_file/.test(msg2) && /limit/.test(msg2), `150 MB: save is refused with an explanatory error toast (${msg2})`);
  t.eq(statSync(bigPath).size, big.size, '150 MB: file on disk untouched by the refused save');
  t.ok(page.url().includes('1420') && !app.exited(), '150 MB: app and page survived');

  // Close it (Don't Save) and move on to the 90 MB file.
  await page.keyboard.press('Control+w');
  await ui.dialog(page).waitFor();
  await ui.dialogButton(page, "Don't Save").click();
  await ui.dialog(page).waitFor({ state: 'detached' });

  // ---------- 90 MB: full open / type / minify / save / pretty / save ----------
  const open90 = await timed(async () => {
    await page.locator('.tree button.row', { hasText: 'mid90.json' }).click();
    await waitFor(async () => (await ed.docInfo(page)).length > 0 && (await ui.activeTitle(page)) === 'mid90.json', { timeout: 120000, interval: 25, label: 'mid90.json loaded' });
  });
  timings.open90 = open90.ms;
  t.eq(await ui.lightBadge(page), 1, '90 MB: Light mode badge shown');
  t.eq((await ed.docInfo(page)).length, mid.chars, '90 MB: document length equals file size in chars');
  snap('after open 90MB');

  await ed.focus(page);
  await page.keyboard.press('Control+Home');
  await page.keyboard.type(' ');
  await waitFor(async () => (await ed.docInfo(page)).length === mid.chars + 1, { timeout: 15000, interval: 5, label: 'typed char (90)' });

  const minT = await timed(async () => {
    await page.keyboard.press('Control+Alt+M');
    await waitFor(async () => (await ed.docInfo(page)).lines === 1, { timeout: 300000, interval: 50, label: 'minified doc' });
  });
  timings.minify90 = minT.ms;
  t.eq((await ed.docInfo(page)).length, mid.minChars, '90 MB: minified length matches the expected minified JSON');
  t.eq(await docSlice(page, 0, 80), mid.minHead, '90 MB: minified head matches');
  const len = (await ed.docInfo(page)).length;
  t.eq(await docSlice(page, len - 61, len - 1), mid.minTail, '90 MB: minified tail matches');
  snap('after minify 90MB');

  const saveMinT = await timed(async () => {
    await page.keyboard.press('Control+s');
    await waitFor(() => statSync(midPath).size === mid.minLen, { timeout: 120000, interval: 25, label: 'minified file on disk' });
  });
  timings.saveMinified90 = saveMinT.ms;
  await sleep(1500);
  t.eq(readFileSync(midPath).subarray(0, 80).toString('utf8'), mid.minHead, '90 MB: file on disk starts with the minified JSON');
  t.eq(statSync(midPath).size, mid.minLen, '90 MB: minified size on disk');
  t.eq(await page.locator('[role=alert]', { hasText: 'Changed on disk' }).count(), 0, '90 MB: own save raises no "changed on disk" banner');
  snap('after save minified 90MB');

  const prettyT = await timed(async () => {
    await page.keyboard.press('Shift+Alt+F');
    await waitFor(async () => (await ed.docInfo(page)).lines > 1000, { timeout: 300000, interval: 50, label: 'pretty-printed doc' });
  });
  timings.pretty90 = prettyT.ms;
  const info = await ed.docInfo(page);
  t.eq(info.lines, mid.lines, '90 MB: pretty line count equals the original');
  t.eq(info.length, mid.chars, '90 MB: pretty length equals the original');
  snap('after pretty 90MB');
  const saveT = await timed(async () => {
    await page.keyboard.press('Control+s');
    await waitFor(() => statSync(midPath).size === mid.size, { timeout: 120000, interval: 25, label: 'pretty file on disk' });
  });
  timings.savePretty90 = saveT.ms;
  await sleep(1500);
  const buf = readFileSync(midPath);
  t.eq(buf.length, mid.size, '90 MB: final file size equals the original');
  t.eq(buf.subarray(0, 19).toString('utf8'), '[\n  {\n    "id": 0,\n', '90 MB: final file head is the original pretty JSON');
  t.eq(await page.locator('[role=alert]', { hasText: 'Changed on disk' }).count(), 0, '90 MB: no banner after second save');
  snap('final');

  console.log(`    TIMINGS ms: ${JSON.stringify(timings)}`);
  console.log(`    MEMORY MB: ${JSON.stringify(mem)}`);
  t.eq(app.consoleErrors.filter((x) => !/write_file failed|Format JSON|limit for one request/.test(x)), [], 'no unexpected console errors');
}
