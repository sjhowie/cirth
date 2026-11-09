import { ed, ui, write, join, makePng, waitFor, sleep } from '../lib.mjs';

export const name = '07 markdown preview';

const filler = Array.from({ length: 120 }, (_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1} with some words in it to take up space.\n`).join('\n');
const MD = `# Title\n\n![pic](./img/pic.png)\n\n\`\`\`ts\nconst answer: number = 42;\n\`\`\`\n\n[to top](#title)\n\n${filler}\nLAST-LINE\n`;

const previewScroll = (page) => page.evaluate(() => document.querySelector('#preview-slot .md-scroll')?.scrollTop ?? -1);

export async function run(t) {
  const dir = t.tmp();
  write(join(dir, 'img', 'pic.png'), makePng(4, 3));
  const md = write(join(dir, 'doc.md'), MD);
  const app = await t.launch({ args: [md] });
  const page = app.page;
  await page.waitForFunction(() => document.querySelectorAll('.strip .tab').length === 1, null, { timeout: 15000 });
  t.eq(await ui.language(page), 'Markdown', 'language detected as Markdown');
  t.eq(await page.locator('#preview-slot').count(), 0, 'no preview by default');

  // Ctrl+K V = preview to the side
  await ed.focus(page);
  await page.keyboard.press('Control+k');
  await page.keyboard.press('v');
  await page.waitForSelector('#preview-slot .md-preview h1');
  t.eq(await page.locator('#preview-slot.only').count(), 0, 'side preview is not preview-only');
  t.ok(await page.locator('.editor-pane:not(.hidden)').isVisible(), 'editor stays visible beside the preview');
  t.eq(await page.locator('#preview-slot .md-preview h1').innerText(), 'Title', 'heading rendered');

  // Image via the asset protocol
  const img = page.locator('#preview-slot .md-preview img');
  await img.waitFor();
  const src = await img.getAttribute('src');
  t.ok(/asset\.localhost|^asset:/.test(src ?? ''), `image src uses the asset protocol (${src})`);
  const ok = await page
    .waitForFunction(() => { const i = document.querySelector('#preview-slot .md-preview img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 8000 })
    .then(() => true, () => false);
  t.ok(ok, 'image loaded (naturalWidth > 0)');
  t.eq(await img.evaluate((i) => [i.naturalWidth, i.naturalHeight]), [4, 3], 'image has the generated 4x3 size');

  // Code highlighting
  const hl = await page
    .waitForFunction(() => document.querySelectorAll('#preview-slot .md-preview pre code span').length > 0, null, { timeout: 10000 })
    .then(() => true, () => false);
  t.ok(hl, 'ts code block is syntax highlighted (token spans)');
  t.eq((await page.locator('#preview-slot .md-preview pre code').first().innerText()).trim(), 'const answer: number = 42;', 'highlighted code keeps its text');
  t.ok(await page.evaluate(() => [...document.querySelectorAll('#preview-slot .md-preview pre code span')].some((s) => /tok-keyword/.test(s.className))), 'keyword token class present');

  // Live update
  await ed.typeAtEnd(page, 'typed-in-editor');
  await waitFor(async () => (await page.locator('#preview-slot .md-preview').innerText()).includes('typed-in-editor'), { timeout: 4000, label: 'preview updates after typing' }).catch(() => {});
  t.ok((await page.locator('#preview-slot .md-preview').innerText()).includes('typed-in-editor'), 'preview re-renders after typing');

  // Scroll sync: editor -> preview
  await page.evaluate(() => { document.querySelector('.cm-scroller').scrollTop = 0; });
  await sleep(300);
  const p0 = await previewScroll(page);
  await page.evaluate(() => { const s = document.querySelector('.cm-scroller'); s.scrollTop = (s.scrollHeight - s.clientHeight) / 2; });
  await waitFor(async () => (await previewScroll(page)) > p0 + 200, { timeout: 4000, label: 'preview follows editor' }).catch(() => {});
  const p1 = await previewScroll(page);
  t.ok(p1 > p0 + 200, `editor scroll moves the preview (${p0} -> ${p1})`);
  // preview -> editor
  const e0 = await ed.scrollTop(page);
  await sleep(500); // let the echo-suppression window pass
  await page.evaluate(() => { const s = document.querySelector('#preview-slot .md-scroll'); s.scrollTop = s.scrollHeight - s.clientHeight; });
  await waitFor(async () => (await ed.scrollTop(page)) > e0 + 200, { timeout: 4000, label: 'editor follows preview' }).catch(() => {});
  const e1 = await ed.scrollTop(page);
  t.ok(e1 > e0 + 200, `preview scroll moves the editor (${e0} -> ${e1})`);

  // Ctrl+Shift+V: side -> preview only; again -> closed
  await page.keyboard.press('Control+Shift+v');
  await page.waitForSelector('#preview-slot.only');
  t.eq(await page.locator('.editor-pane.hidden').count(), 1, 'preview-only hides the editor pane');
  t.eq(await page.locator('.cm-content').count(), 1, 'editor view stays mounted while hidden');
  await page.keyboard.press('Control+Shift+v');
  await page.waitForSelector('#preview-slot', { state: 'detached' });
  t.eq(await page.locator('.editor-pane.hidden').count(), 0, 'closing the preview shows the editor again');

  // Fresh toggle from off straight to preview-only
  await page.keyboard.press('Control+Shift+v');
  await page.waitForSelector('#preview-slot.only');
  t.ok((await page.locator('#preview-slot .md-preview h1').count()) === 1, 'preview-only renders the document');
  await page.keyboard.press('Control+Shift+v');
  await page.waitForSelector('#preview-slot', { state: 'detached' });
  t.eq(app.consoleErrors, [], 'no console errors');
}
