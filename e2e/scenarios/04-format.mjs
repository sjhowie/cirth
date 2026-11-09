import { ed, ui, write, join, waitFor, sleep } from '../lib.mjs';

export const name = '04 format';

const OBJ = { name: 'x', list: [1, 2, { deep: 'y', n: null }], flag: true, empty: {}, arr: [] };
const COMPACT = JSON.stringify(OBJ);
const XML = '<root><!-- note --><a x="1">text</a><p>mixed <b>bold</b> tail</p><e/><list><i>1</i><i>2</i></list></root>';

async function format(page, kind) {
  await ed.focus(page);
  await page.keyboard.press(kind === 'pretty' ? 'Shift+Alt+F' : 'Control+Alt+M');
}

async function waitDoc(page, pred, label) {
  await waitFor(async () => pred(await ed.doc(page)), { timeout: 5000, label }).catch(() => {});
  return ed.doc(page);
}

export async function run(t) {
  const dir = t.tmp();
  const json = write(join(dir, 'data.json'), COMPACT);
  const bad = write(join(dir, 'bad.json'), '{\n  "a": 1,\n  "b": [1, 2\n}\n');
  const xml = write(join(dir, 'data.xml'), XML);
  const app = await t.launch({ args: [json, bad, xml], settings: { theme: 'light', fontFamily: 'Consolas', fontSize: 14, indent: '2', largeFileThresholdMb: 10, wordWrap: false } });
  const page = app.page;
  await page.waitForFunction(() => document.querySelectorAll('.strip .tab').length === 3, null, { timeout: 15000 });

  // ---- JSON pretty/minify with indent 2 / 4 / tab (changed live through the Settings panel) ----
  await ui.clickTab(page, 'data.json');
  t.eq(await ui.language(page), 'JSON', 'language detected as JSON');
  const indents = [['2', JSON.stringify(OBJ, null, 2)], ['4', JSON.stringify(OBJ, null, 4)], ['tab', JSON.stringify(OBJ, null, '\t')]];
  for (const [ind, expected] of indents) {
    await ui.openSettings(page);
    await page.locator('[role=dialog][aria-label=Settings] select').nth(1).selectOption(ind);
    await ui.closeSettings(page);
    await format(page, 'pretty');
    const pretty = await waitDoc(page, (d) => d !== COMPACT, `pretty (${ind})`);
    t.eq(pretty, expected, `JSON pretty with indent ${ind}`);
    await format(page, 'minify');
    const min = await waitDoc(page, (d) => d === COMPACT, `minify (${ind})`);
    t.eq(min, COMPACT, `JSON minify after indent ${ind}`);
  }

  // Undo restores in one step.
  await format(page, 'pretty');
  await waitDoc(page, (d) => d !== COMPACT, 'pretty before undo');
  await page.keyboard.press('Control+z');
  t.eq(await ed.doc(page), COMPACT, 'one Ctrl+Z undoes a whole pretty-print');
  await page.keyboard.press('Control+y');
  t.eq(await ed.doc(page), JSON.stringify(OBJ, null, '\t'), 'Ctrl+Y redoes it in one step');

  // ---- Invalid JSON ----
  await ui.clickTab(page, 'bad.json');
  const original = await ed.doc(page);
  await ui.clearToasts(page);
  await format(page, 'pretty');
  await page.waitForSelector('.toast.error', { timeout: 5000 });
  const msg = (await ui.toasts(page)).find((x) => x.kind === 'error')?.text ?? '';
  const m = /line (\d+), col (\d+)/.exec(msg);
  t.ok(!!m, `error toast carries line/col (${msg})`);
  t.eq(await ed.doc(page), original, 'invalid JSON: document unchanged');
  if (m) {
    const sel = await ed.selection(page);
    t.eq([sel.line, sel.col], [Number(m[1]), Number(m[2])], 'cursor moved to the reported line:col');
    t.ok(new RegExp(`Ln ${m[1]}, Col ${m[2]}`).test(await ui.status(page)), 'status bar shows the same position');
    t.ok(Number(m[1]) >= 3, `reported line is at/after the problem (line ${m[1]})`);
  }
  t.ok(!(await ui.tabs(page)).find((x) => x.title === 'bad.json').dirty, 'invalid JSON: tab not dirty');
  await format(page, 'minify');
  await page.waitForFunction(() => document.querySelectorAll('.toast.error').length >= 2, null, { timeout: 3000 }).catch(() => {});
  t.eq(await ed.doc(page), original, 'invalid JSON: minify leaves document unchanged too');

  // ---- XML ----
  await ui.clickTab(page, 'data.xml');
  t.eq(await ui.language(page), 'XML', 'language detected as XML');
  await ui.openSettings(page);
  await page.locator('[role=dialog][aria-label=Settings] select').nth(1).selectOption('2');
  await ui.closeSettings(page);
  await format(page, 'pretty');
  const pretty = await waitDoc(page, (d) => d !== XML, 'xml pretty');
  const pl = pretty.split('\n');
  t.ok(pl.length >= 8, `XML pretty is multi-line (${pl.length} lines)`);
  t.ok(pl.includes('  <!-- note -->'), `comment on its own indented line (${JSON.stringify(pl.slice(0, 3))})`);
  t.ok(pl.some((l) => l === '  <p>mixed <b>bold</b> tail</p>'), 'mixed content kept inline');
  t.ok(pl.includes('    <i>1</i>') && pl.includes('  <list>'), 'nested elements indented by 2');
  t.eq(pl[0], '<root>', 'first line is the root start tag');
  await page.keyboard.press('Control+z');
  t.eq(await ed.doc(page), XML, 'XML: one Ctrl+Z restores the original');
  await page.keyboard.press('Control+y');
  await format(page, 'minify');
  const min = await waitDoc(page, (d) => !d.includes('\n'), 'xml minify');
  t.eq(min, XML, 'XML minify round-trips to the compact form (comment and mixed content intact)');

  // 4 spaces for XML as well
  await ui.openSettings(page);
  await page.locator('[role=dialog][aria-label=Settings] select').nth(1).selectOption('4');
  await ui.closeSettings(page);
  await format(page, 'pretty');
  const p4 = await waitDoc(page, (d) => d.includes('\n'), 'xml pretty 4');
  t.ok(p4.split('\n').includes('    <!-- note -->'), 'XML pretty honours indent 4');
  t.eq(app.consoleErrors.filter((x) => !/format parse error/.test(x)), [], 'no unexpected console errors');
}
