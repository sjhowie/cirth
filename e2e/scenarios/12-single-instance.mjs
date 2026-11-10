import { spawnSync } from 'node:child_process';
import { EXE, spawnExe, ui, write, join, waitFor, sleep } from '../lib.mjs';

export const name = '12 single instance';

const exeName = EXE.split(/[\\/]/).pop();

function runningCount() {
  const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${exeName}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8' });
  return r.stdout.split('\n').filter((l) => l.toLowerCase().includes(`"${exeName.toLowerCase()}"`)).length;
}

export async function run(t) {
  if (runningCount() > 0) {
    t.info(`skipped: a ${exeName} process is already running (a test launch would join it instead of starting)`);
    return;
  }
  const dir = t.tmp();
  const f1 = write(join(dir, 'first.txt'), 'first\n');
  const f2 = write(join(dir, 'second.txt'), 'second\n');
  write(join(dir, 'third.txt'), 'third\n');
  const f4 = write(join(dir, 'early.txt'), 'early\n');
  const env = { ...process.env };
  delete env.SIMPLEEDITOR_MULTI_INSTANCE;

  // First instance WITHOUT the opt-out env var, so the single-instance plugin is active.
  // A second launch fired right after it (window still loading) must be queued, not lost.
  const launching = t.launch({ args: [f1], multiInstance: false });
  await sleep(300);
  const early = spawnExe([f4], { cwd: dir, env, stdio: 'ignore', windowsHide: false });
  let earlyCode = null;
  early.on('exit', (c) => (earlyCode = c ?? -1));
  const app = await launching;
  const page = app.page;
  await waitFor(() => earlyCode !== null, { timeout: 15000, label: 'early second process to exit' }).catch(() => early.kill());
  await page.waitForFunction(() => document.querySelectorAll('.strip .tab').length === 2, null, { timeout: 15000 }).catch(() => {});
  t.eq((await ui.tabs(page)).map((x) => x.title).sort(), ['early.txt', 'first.txt'], 'early second launch (before the page was ready) still opened');

  // Second launch: an absolute path, then a relative one resolved against the second process's cwd.
  const started = Date.now();
  const second = spawnExe([f2, 'third.txt'], { cwd: dir, env, stdio: 'ignore', windowsHide: false });
  let code = null;
  second.on('exit', (c) => (code = c ?? -1));
  await waitFor(() => code !== null, { timeout: 10000, label: 'second process to exit' }).catch(() => {});
  const secs = (Date.now() - started) / 1000;
  if (code === null) second.kill();
  t.ok(code !== null, `second process exited on its own (${secs.toFixed(1)} s)`);
  t.ok(secs < 5, `second process exited quickly (${secs.toFixed(1)} s)`);

  await page.waitForFunction(() => document.querySelectorAll('.strip .tab').length === 4, null, { timeout: 10000 }).catch(() => {});
  const titles = (await ui.tabs(page)).map((x) => x.title).sort();
  t.eq(titles, ['early.txt', 'first.txt', 'second.txt', 'third.txt'], 'running window has all four tabs (relative path resolved against the second cwd)');
  t.ok(!app.exited(), 'first instance is still running');
  await sleep(300);
  t.eq(app.consoleErrors, [], 'no console errors in the first window');
}
