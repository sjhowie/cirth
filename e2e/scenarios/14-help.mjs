import { readFileSync, join, ROOT, waitFor } from '../lib.mjs';

export const name = '14 help';

const about = (page) => page.locator('[role=dialog][aria-labelledby=about-title]');
const changelog = (page) => page.locator('[role=dialog][aria-labelledby=changelog-title]');

async function helpMenu(page, label) {
  await page.locator('nav.bar button.top', { hasText: 'Help' }).click();
  await page.locator('nav.bar [role=menuitem]', { hasText: label }).click();
}

export async function run(t) {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const app = await t.launch({ args: [], settings: null });
  const page = app.page;
  await page.waitForSelector('nav.bar', { timeout: 15000 });
  t.eq(await changelog(page).count(), 0, "What's New does not open by itself at startup");

  // ---- About Cirth ----
  await helpMenu(page, 'About Cirth');
  await about(page).waitFor({ timeout: 3000 });
  t.ok(/Cirth/.test(await about(page).locator('#about-title').innerText()), 'About shows the name Cirth');
  await waitFor(async () => (await about(page).locator('.about-version').innerText()) === version, { timeout: 4000, label: 'about version' }).catch(() => {});
  t.eq(await about(page).locator('.about-version').innerText(), version, 'About shows the version from package.json');
  await page.keyboard.press('Escape');
  await about(page).waitFor({ state: 'detached', timeout: 3000 });
  t.eq(await about(page).count(), 0, 'Esc closes About');

  // ---- What's New ----
  await helpMenu(page, "What's New");
  await changelog(page).waitFor({ timeout: 3000 });
  for (const v of ['0.2.1', '0.2.0']) {
    const rel = changelog(page).locator(`section.release[data-version="${v}"]`);
    t.eq(await rel.count(), 1, `What's New lists release ${v}`);
    t.eq((await rel.locator('.badge').innerText()).trim(), v, `release ${v} has its version badge`);
  }
  t.ok((await changelog(page).locator('.label', { hasText: /^FIXED$/ }).count()) > 0, "What's New shows a FIXED section label");
  await changelog(page).locator('button[aria-label=Close]').click();
  await changelog(page).waitFor({ state: 'detached', timeout: 3000 });
  t.eq(await changelog(page).count(), 0, "the X closes What's New");

  t.eq(app.consoleErrors, [], 'no console errors');
}
