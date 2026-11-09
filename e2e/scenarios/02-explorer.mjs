import { spawnSync } from 'node:child_process';
import { ui, write, join, existsSync, readFileSync, mkdirSync, waitFor, sleep } from '../lib.mjs';

export const name = '02 explorer';

const rows = (page) => page.evaluate(() => [...document.querySelectorAll('.tree .row')].map((r) => r.querySelector('.name')?.textContent ?? `<input:${r.querySelector('input')?.getAttribute('aria-label')}>`));
const row = (page, text) => page.locator('.tree button.row', { has: page.locator('.name', { hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });

async function ctx(page, rowName, item) {
  await row(page, rowName).click({ button: 'right' });
  await page.locator('.ctx [role=menuitem]', { hasText: item }).click();
}

function recycleBinNames() {
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', "(New-Object -ComObject Shell.Application).NameSpace(10).Items() | ForEach-Object { $_.Name }"], { encoding: 'utf8' });
  return r.stdout.split(/\r?\n/);
}

export async function run(t) {
  const root = t.tmp();
  write(join(root, '.gitignore'), 'ignored.log\n');
  write(join(root, 'ignored.log'), 'x');
  write(join(root, 'top.txt'), 'top');
  write(join(root, 'src', 'a.txt'), 'alpha');
  write(join(root, 'src', 'deep', 'b.txt'), 'beta');
  write(join(root, 'docs', 'readme.md'), '# hi');

  const app = await t.launch({ args: [root] });
  const page = app.page;
  await page.waitForSelector('.tree .row');
  t.eq(await page.locator('aside.sidebar').count(), 1, 'sidebar visible when launched with a folder');
  t.eq(await page.locator('[role=tab][aria-selected]', { hasText: /^(Explorer|Search)$/ }).count(), 0, 'no Explorer/Search tab switch in the sidebar');

  t.eq(await rows(page), ['docs', 'src', '.gitignore', 'ignored.log', 'top.txt'], 'top level: folders first, then files (gitignored file still listed in tree)');
  t.ok((await page.locator('.explorer .head .title').innerText()).length > 0, 'header shows the folder name');

  // Expand / collapse
  await row(page, 'src').click();
  await page.waitForSelector('.tree .row .name:text-is("a.txt")');
  t.eq(await rows(page), ['docs', 'src', 'deep', 'a.txt', '.gitignore', 'ignored.log', 'top.txt'], 'expanded src');
  await row(page, 'src').click();
  await sleep(150);
  t.eq(await rows(page), ['docs', 'src', '.gitignore', 'ignored.log', 'top.txt'], 'collapsed src');
  await row(page, 'src').click();
  await row(page, 'deep').click();
  await page.waitForSelector('.tree .row .name:text-is("b.txt")');

  // Click opens
  await row(page, 'a.txt').click();
  await waitFor(async () => (await ui.activeTitle(page)) === 'a.txt', { label: 'a.txt tab' });
  t.eq(await page.evaluate(() => document.querySelector('.cm-content').innerText.trim()), 'alpha', 'click opens file with its content');

  // New File (on folder = child)
  await ctx(page, 'src', 'New File');
  await page.waitForSelector('.tree input[aria-label="New name"]');
  await page.keyboard.type('new1.txt');
  await page.keyboard.press('Enter');
  await waitFor(() => existsSync(join(root, 'src', 'new1.txt')), { label: 'new1.txt on disk' });
  t.ok(true, 'New File created on disk');
  await waitFor(async () => (await ui.activeTitle(page)) === 'new1.txt', { label: 'new1.txt opened' });
  t.ok(await row(page, 'new1.txt').count(), 'new file appears in the tree');

  // New Folder
  await ctx(page, 'src', 'New Folder');
  await page.waitForSelector('.tree input[aria-label="New name"]');
  await page.keyboard.type('newdir');
  await page.keyboard.press('Enter');
  await waitFor(() => existsSync(join(root, 'src', 'newdir')), { label: 'newdir on disk' });
  // The release build creates the dir before the tree re-lists, so wait for the row (fails if it never shows).
  t.ok(await waitFor(async () => (await row(page, 'newdir').count()) > 0, { label: 'newdir row' }).then(() => true, () => false), 'new folder appears in the tree');

  // New File on a file row = sibling
  await ctx(page, 'b.txt', 'New File');
  await page.waitForSelector('.tree input[aria-label="New name"]');
  await page.keyboard.type('sibling.txt');
  await page.keyboard.press('Enter');
  await waitFor(() => existsSync(join(root, 'src', 'deep', 'sibling.txt')), { label: 'sibling.txt on disk' });
  t.ok(true, 'New File on a file row creates a sibling');

  // Rename
  await ctx(page, 'new1.txt', 'Rename');
  const input = page.locator('.tree input[aria-label="Rename"]');
  await input.waitFor();
  t.eq(await input.inputValue(), 'new1.txt', 'rename input is prefilled');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('renamed.txt');
  await page.keyboard.press('Enter');
  await waitFor(() => existsSync(join(root, 'src', 'renamed.txt')), { label: 'renamed on disk' });
  t.ok(!existsSync(join(root, 'src', 'new1.txt')), 'old name gone after rename');
  await waitFor(async () => (await ui.tabs(page)).some((x) => x.title === 'renamed.txt'), { label: 'open tab follows the rename' });
  t.ok(true, 'open tab retitled after rename');

  // Delete -> recycle bin
  const victim = join(root, 'src', 'renamed.txt');
  write(victim, 'bye');
  const unique = `e2e-trash-${Date.now()}.txt`;
  write(join(root, 'src', unique), 'bye');
  await waitFor(async () => (await row(page, unique).count()) > 0, { label: 'victim visible (watcher or refresh)', timeout: 5000 }).catch(() => {});
  if (!(await row(page, unique).count())) {
    // The tree refreshes via the watcher; fall back to collapse/expand if the event is slow.
    t.ok(false, 'externally created file shows up in the tree without a manual refresh');
  } else {
    await ctx(page, unique, 'Delete');
    await ui.dialog(page).waitFor();
    t.ok(/recycle bin/i.test(await ui.dialog(page).innerText()), 'delete dialog says recycle bin');
    await ui.dialogButton(page, 'Cancel').click();
    t.ok(existsSync(join(root, 'src', unique)), 'Cancel keeps the file');
    await ctx(page, unique, 'Delete');
    const t0 = Date.now();
    await ui.dialogButton(page, 'Delete').click();
    await waitFor(() => !existsSync(join(root, 'src', unique)), { label: 'file removed from disk', timeout: 30000 });
    t.info(`Delete to recycle bin took ${Date.now() - t0} ms (bin holds many items)`);
    t.ok(true, 'Delete removed the file from disk');
    await waitFor(async () => (await row(page, unique).count()) === 0, { label: 'row removed' });
    t.ok(recycleBinNames().some((n) => n.startsWith(unique.replace(/\.txt$/, ''))), 'file is in the recycle bin');
  }
  t.eq(app.consoleErrors, [], 'no console errors');
}
