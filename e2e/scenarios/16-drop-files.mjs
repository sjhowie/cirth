import { ui, write, join, waitFor } from '../lib.mjs';

export const name = '16 drop files';

// Drops real files through CDP's Input.dispatchDragEvent, which gives the page File objects backed by these paths.
// The page posts them to WebView2, and Rust (file_drop.rs) reads their paths and opens them.
async function dropFiles(page, cdp, files, at) {
  const data = { items: [], files, dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await cdp.send('Input.dispatchDragEvent', { type, x: at.x, y: at.y, data });
  }
}

export async function run(t) {
  const dir = t.tmp();
  const a = write(join(dir, 'a.txt'), 'first\n');
  const b = write(join(dir, 'b.txt'), 'second\n');
  const c = write(join(dir, 'c.txt'), 'third\n');
  const app = await t.launch({ args: [a] });
  const page = app.page;
  await page.waitForFunction(() => document.querySelectorAll('.strip .tab').length === 1, null, { timeout: 15000 });
  const url = page.url();
  const cdp = await page.context().newCDPSession(page);

  // Onto the editor: both files open as tabs, and the dropped text isn't pasted into a.txt.
  const box = await page.locator('.cm-content').boundingBox();
  await dropFiles(page, cdp, [b, c], { x: box.x + 40, y: box.y + 10 });
  await waitFor(async () => (await ui.tabs(page)).length === 3, { label: 'dropped files open as tabs', timeout: 5000 }).catch(() => {});
  t.eq((await ui.tabs(page)).map((x) => x.title), ['a.txt', 'b.txt', 'c.txt'], 'dropping two files on the editor opens both');
  await ui.clickTab(page, 'a.txt');
  t.eq(await page.evaluate(() => (document.querySelector('.cm-content')?.cmTile ?? document.querySelector('.cm-content')?.cmView)?.view.state.doc.toString()), 'first\n', 'nothing is pasted into the document under the drop');

  // Onto the tab bar: an already-open file is not opened twice, and the page never navigates to the file.
  const tab = await page.locator('.strip').boundingBox();
  await dropFiles(page, cdp, [b], { x: tab.x + tab.width - 20, y: tab.y + tab.height / 2 });
  await waitFor(async () => (await ui.activeTitle(page)) === 'b.txt', { label: 'b.txt shown', timeout: 5000 }).catch(() => {});
  t.eq(await ui.activeTitle(page), 'b.txt', 'dropping an open file shows its tab');
  t.eq((await ui.tabs(page)).length, 3, 'and does not open it twice');
  t.eq(page.url(), url, 'the page did not navigate to the dropped file');

  // A folder opens in the sidebar, as when Cirth is launched on it.
  const folder = join(dir, 'proj');
  write(join(folder, 'inside.txt'), 'x\n');
  await dropFiles(page, cdp, [folder], { x: box.x + 40, y: box.y + 10 });
  await page.locator('aside.sidebar').getByText('inside.txt').waitFor({ timeout: 5000 }).catch(() => {});
  t.eq(await page.locator('aside.sidebar').getByText('inside.txt').count(), 1, 'dropping a folder opens it in the sidebar');
  t.eq(app.consoleErrors, [], 'no console errors');
}
