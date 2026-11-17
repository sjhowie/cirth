import { ui, write, join, readFileSync, existsSync, writeSettings, SETTINGS_FILE, ROOT, waitFor, sleep } from '../lib.mjs';
import { writeFileSync } from 'node:fs';

export const name = '11 settings';

const read = () => JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
const dlg = (page) => page.locator('[role=dialog][aria-label=Settings]');
const theme = (page) => page.evaluate(() => document.documentElement.dataset.theme);
const cmFont = (page) => page.evaluate(() => getComputedStyle(document.querySelector('.cm-content')).fontSize);
const cmFamily = (page) => page.evaluate(() => getComputedStyle(document.querySelector('.cm-content')).fontFamily);
const bg = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

export async function run(t) {
  const dir = t.tmp();
  const f = write(join(dir, 'a.txt'), 'hello\n');

  // ---- defaults, then change theme / font / indent / wrap live ----
  let app = await t.launch({ args: [f], settings: null });
  let page = app.page;
  await page.waitForFunction(() => document.querySelectorAll('.strip .tab').length === 1, null, { timeout: 15000 });
  t.eq(await cmFont(page), '14px', 'default font size is 14px');
  t.ok(['light', 'dark'].includes(await theme(page)), 'default theme resolves from the system');
  const lightBg = await (async () => { await ui.openSettings(page); await dlg(page).locator('select').nth(0).selectOption('light'); return bg(page); })();
  t.eq(await theme(page), 'light', 'Light theme applied live');
  await dlg(page).locator('select').nth(0).selectOption('dark');
  t.eq(await theme(page), 'dark', 'Dark theme applied live');
  const darkBg = await bg(page);
  t.ok(darkBg !== lightBg, `page background changes with the theme (${lightBg} -> ${darkBg})`);

  const size = dlg(page).locator('input[type=number]').nth(0);
  await size.fill('20');
  await size.blur();
  await waitFor(async () => (await cmFont(page)) === '20px', { timeout: 3000, label: 'font 20px' }).catch(() => {});
  t.eq(await cmFont(page), '20px', 'font size applied live to the editor');
  const fam = dlg(page).locator('input[type=text]').first();
  await fam.fill('Consolas, monospace');
  await fam.blur();
  await waitFor(async () => /Consolas/.test(await cmFamily(page)), { timeout: 3000, label: 'font family' }).catch(() => {});
  t.ok(/Consolas/.test(await cmFamily(page)), `font family applied live (${await cmFamily(page)})`);
  await dlg(page).locator('select').nth(1).selectOption('4');
  await dlg(page).locator('input[type=checkbox]').check();
  await waitFor(async () => (await page.locator('.cm-content.cm-lineWrapping').count()) === 1, { timeout: 3000, label: 'wrap' }).catch(() => {});
  t.eq(await page.locator('.cm-content.cm-lineWrapping').count(), 1, 'word wrap applied live');
  const thr = dlg(page).locator('input[type=number]').nth(1);
  await thr.fill('25');
  await thr.blur();

  await waitFor(() => existsSync(SETTINGS_FILE) && read().largeFileThresholdMb === 25, { timeout: 4000, label: 'settings.json written' }).catch(() => {});
  t.ok(existsSync(SETTINGS_FILE), 'settings.json exists in %APPDATA%\io.github.sjhowie.cirth');
  t.eq(read(), { theme: 'dark', fontFamily: 'Consolas, monospace', fontSize: 20, indent: '4', largeFileThresholdMb: 25, wordWrap: true }, 'settings.json holds exactly the chosen values');
  t.eq(readFileSync(SETTINGS_FILE).subarray(0, 1).toString(), '{', 'settings.json is plain JSON (no BOM)');
  await ui.closeSettings(page);

  // ---- relaunch: persisted ----
  app = await t.relaunch(app, { args: [f] });
  page = app.page;
  await page.waitForFunction(() => document.querySelectorAll('.strip .tab').length === 1, null, { timeout: 15000 });
  await waitFor(async () => (await theme(page)) === 'dark', { timeout: 4000, label: 'dark after relaunch' }).catch(() => {});
  t.eq(await theme(page), 'dark', 'theme persisted across relaunch');
  // The window opens on the theme's background and the page's first paint uses it (no white flash).
  t.eq(await page.evaluate(() => window.__CIRTH_THEME__), 'dark', 'Rust injected the saved theme into the page before it loaded');
  t.eq(await cmFont(page), '20px', 'font size persisted across relaunch');
  t.ok(/Consolas/.test(await cmFamily(page)), 'font family persisted across relaunch');
  t.eq(await page.locator('.cm-content.cm-lineWrapping').count(), 1, 'word wrap persisted across relaunch');
  t.ok(/Spaces: 4/.test(await ui.status(page)), 'indent 4 persisted (status bar)');
  await ui.openSettings(page);
  t.eq(await dlg(page).locator('input[type=number]').nth(1).inputValue(), '25', 'large-file threshold persisted in the panel');
  t.eq(await dlg(page).locator('select').nth(0).inputValue(), 'dark', 'panel shows the saved theme');
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  t.eq(await dlg(page).locator('.version').innerText(), `Cirth ${version}`, 'settings panel shows the app version from package.json');
  t.eq(await page.evaluate(() => window.__CIRTH_UPDATE_CHECK__), false, 'CIRTH_NO_UPDATE_CHECK=1 turns off background update checks');

  // ---- out-of-range font size is clamped before it is stored ----
  const size2 = dlg(page).locator('input[type=number]').nth(0);
  await size2.fill('999');
  await size2.blur();
  await waitFor(() => read().fontSize === 48, { timeout: 4000, label: 'clamped font size stored' }).catch(() => {});
  t.eq(read().fontSize, 48, 'font size 999 is clamped to 48 in settings.json');
  t.eq(await cmFont(page), '48px', 'editor shows the clamped size');
  await ui.closeSettings(page);

  // ---- an unreadable settings.json: defaults, file left untouched ----
  app = await t.relaunch(app, { args: [f], settings: null });
  await app.close();
  writeFileSync(SETTINGS_FILE, '{ this is not json');
  app = await t.launch({ args: [f], keepSettings: true });
  page = app.page;
  await page.waitForFunction(() => document.querySelectorAll('.strip .tab').length === 1, null, { timeout: 15000 });
  await sleep(500);
  t.eq(await cmFont(page), '14px', 'invalid settings.json: defaults used');
  t.eq(readFileSync(SETTINGS_FILE, 'utf8'), '{ this is not json', 'invalid settings.json is not overwritten at startup');
  t.ok(/invalid/.test(app.logs()), 'backend logged the invalid settings file');
  t.eq(app.consoleErrors, [], 'no console errors');
}
