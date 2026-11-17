// Real-app E2E runner: starts Vite, runs each scenario against the debug exe over CDP, always cleans up.
// Usage: npm run e2e [-- <scenario-number-or-name-substring> ...]
// Settings live in a per-run temp folder (CIRTH_CONFIG_DIR), so the user's real settings are never read or changed.
// A scenario can end with t.skip(reason): reported as SKIP, not counted as passed, exit code stays 0.
// SE_EXE=<path to exe>: test that exe instead of the debug exe, and do not start Vite (release builds bundle the frontend).
//   e.g. $env:SE_EXE = "$env:LOCALAPPDATA\Cirth\cirth.exe"; npm run e2e
import { readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import {
  cleanupRun, startVite, stopVite, launchApp, makeTmp, rmSync, writeSettings, EXE, USE_CUSTOM_EXE, existsSync,
} from './lib.mjs';

/** Thrown by t.skip(reason): ends the scenario as skipped (not passed, not failed). */
class SkipSignal extends Error {}

const here = dirname(fileURLToPath(import.meta.url));
const filters = process.argv.slice(2);
const shotDir = join(tmpdir(), `se-e2e-shots-${Date.now()}`);

const apps = new Set();

/** Per-scenario context: soft checks, launching, temp dirs, logging. */
function makeContext(name) {
  const checks = { pass: 0, fail: [] };
  const tmps = [];
  const t = {
    name,
    ok(cond, label) {
      if (cond) checks.pass++;
      else {
        checks.fail.push(label);
        console.log(`    not ok - ${label}`);
      }
      return !!cond;
    },
    eq(actual, expected, label) {
      const same = JSON.stringify(actual) === JSON.stringify(expected);
      if (!same) return t.ok(false, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      return t.ok(true, label);
    },
    info: (msg) => console.log(`    ${msg}`),
    /** Ends the scenario as skipped (reported as SKIP with the reason, exit code unaffected). Throws; code after it never runs. */
    skip(reason) {
      throw new SkipSignal(reason);
    },
    tmp() {
      const d = makeTmp();
      tmps.push(d);
      return d;
    },
    async launch(opts = {}) {
      // Known starting state: given settings, or none (defaults). relaunch() keeps whatever the last run left.
      if (!opts.keepSettings) writeSettings('settings' in opts ? opts.settings : null);
      const app = await launchApp(opts);
      apps.add(app);
      app.shot = async (label) => {
        mkdirSync(shotDir, { recursive: true });
        const p = join(shotDir, `${name.replace(/\W+/g, '_')}-${label}.png`);
        await app.page.screenshot({ path: p }).catch(() => {});
        return p;
      };
      return app;
    },
    async relaunch(app, opts = {}) {
      await app.close();
      apps.delete(app);
      return t.launch({ keepSettings: !('settings' in opts), ...opts });
    },
  };
  return {
    t,
    checks,
    async cleanup() {
      for (const a of [...apps]) {
        await a.close().catch((e) => console.error(`  cleanup: ${e.message}`));
        apps.delete(a);
      }
      for (const d of tmps) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

async function main() {
  if (!existsSync(EXE)) throw new Error(`Missing ${EXE}; run "cargo build" in src-tauri first.`);
  const files = readdirSync(join(here, 'scenarios')).filter((f) => f.endsWith('.mjs')).sort();
  const selected = files.filter((f) => filters.length === 0 || filters.some((x) => f.toLowerCase().includes(x.toLowerCase()) || f.startsWith(x.padStart(2, '0'))));
  if (selected.length === 0) throw new Error(`No scenario matches ${filters.join(', ')}`);

  if (!USE_CUSTOM_EXE) await startVite();
  const results = [];
  for (const file of selected) {
    const mod = await import(pathToFileURL(join(here, 'scenarios', file)).href);
    const name = mod.name ?? file;
    console.log(`RUN  ${name}`);
    const { t, checks, cleanup } = makeContext(name);
    const started = Date.now();
    let error = null;
    let skipped = null;
    try {
      await mod.run(t);
    } catch (e) {
      if (e instanceof SkipSignal) {
        skipped = e.message;
      } else {
        error = e;
        console.log(`    error - ${e.stack ?? e.message}`);
        for (const a of apps) {
          await a.shot?.('error');
          console.log(`    app exited: ${a.exited()} (code ${a.exitCode()}); app log tail:
${a.logs().slice(-1500)}`);
        }
      }
    } finally {
      await cleanup();
    }
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (skipped !== null && error === null && checks.fail.length === 0) {
      console.log(`SKIP ${name} (${skipped})`);
      results.push({ name, ok: true, skipped: true });
      continue;
    }
    const ok = error === null && checks.fail.length === 0;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (${checks.pass} checks passed, ${checks.fail.length} failed${error ? ', threw' : ''}, ${secs}s)`);
    results.push({ name, ok });
  }
  const failed = results.filter((r) => !r.ok);
  const skippedCount = results.filter((r) => r.skipped).length;
  const passed = results.length - failed.length - skippedCount;
  console.log(`\n${passed}/${results.length} passed${skippedCount ? `, ${skippedCount} skipped` : ''}${failed.length ? `, ${failed.length} failed` : ''}`);
  for (const f of failed) console.log(`  FAILED: ${f.name}`);
  console.log(`(screenshots on error: ${shotDir})`);
  return failed.length === 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error(`runner error: ${e.stack ?? e.message}`);
} finally {
  for (const a of apps) await a.close().catch(() => {});
  stopVite();
  cleanupRun(); // after the apps are closed: deletes the run's config dir and WebView2 profile
}
process.exit(code);
