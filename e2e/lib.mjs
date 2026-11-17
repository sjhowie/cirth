// Shared helpers for the real-app E2E suite (Tauri exe + WebView2, driven over CDP).
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, copyFileSync, statSync } from 'node:fs';
// RUN_DIR is created at import: lib.mjs is only imported by the runner and its scenarios.
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { chromium } from 'playwright-core';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** SE_EXE overrides the exe (e.g. an installed release build); the release build bundles the frontend, so no Vite then. */
export const USE_CUSTOM_EXE = !!process.env.SE_EXE;
export const EXE = process.env.SE_EXE ?? join(ROOT, 'src-tauri', 'target', 'debug', 'cirth.exe');
export const CDP_PORT = 9222;
export const VITE_PORT = 1420;
/**
 * Per-run scratch folder, created when the suite starts and deleted by cleanupRun(). It holds the app's settings
 * (CIRTH_CONFIG_DIR, so the tests never touch the real %APPDATA% settings) and the WebView2 profile.
 */
const RUN_DIR = mkdtempSync(join(tmpdir(), 'cirth-e2e-run-'));
export const CONFIG_DIR = join(RUN_DIR, 'config');
export const SETTINGS_FILE = join(CONFIG_DIR, 'settings.json');
const WEBVIEW2_DIR = join(RUN_DIR, 'webview2');

/** Environment every test launch gets: isolated settings, no GitHub update checks. */
export const isolatedEnv = (extra = {}) => ({ ...process.env, CIRTH_CONFIG_DIR: CONFIG_DIR, CIRTH_NO_UPDATE_CHECK: '1', ...extra });

/** Deletes the run folder. Call once at the end of the run, after every app is closed. */
export function cleanupRun() {
  try {
    rmSync(RUN_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (e) {
    console.error(`warn: could not delete ${RUN_DIR}: ${e.message}`);
  }
}

/**
 * The app runs on a hidden Windows desktop (`deskrun.cs`), so test windows never reach the user's screen or take focus.
 * CDP input needs no OS focus, and WebView2 renders normally there. SE_E2E_VISIBLE=1 shows the windows (for debugging).
 */
export const DESKRUN = process.platform === 'win32' && process.env.SE_E2E_VISIBLE !== '1' ? buildDeskrun() : null;
export const DESKTOP = 'CirthE2E';
/** Launcher pid -> app pid, when launched through DESKRUN. */
const appPids = new Map();
/** Spawns the app exe directly (on the hidden desktop under DESKRUN); for launches that don't need CDP. */
export const spawnExe = (args, opts) => spawn(DESKRUN ?? EXE, DESKRUN ? ['run', DESKTOP, EXE, ...args] : args, opts);

/** Compiles e2e/deskrun.cs into e2e/.bin/deskrun.exe with the C# compiler that ships with Windows, when missing or stale. */
function buildDeskrun() {
  const src = join(ROOT, 'e2e', 'deskrun.cs');
  const out = join(ROOT, 'e2e', '.bin', 'deskrun.exe');
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs) return out;
  const csc = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (!existsSync(csc)) throw new Error(`Missing ${csc} to build the hidden-desktop launcher; set SE_E2E_VISIBLE=1 to run with visible windows.`);
  mkdirSync(dirname(out), { recursive: true });
  const r = spawnSync(csc, ['/nologo', `/out:${out}`, src], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`Building deskrun.exe failed:\n${r.stdout}${r.stderr}`);
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 10000, interval = 50, label = 'condition' } = {}) {
  const start = Date.now();
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() - start > timeout) {
      throw new Error(`Timed out after ${timeout} ms waiting for ${label}${last ? ` (last error: ${last.message})` : ''}`);
    }
    await sleep(interval);
  }
}

function httpGet(url) {
  return new Promise((res, rej) => {
    const req = http.get(url, (r) => {
      let body = '';
      r.on('data', (c) => (body += c));
      r.on('end', () => res({ status: r.statusCode, body }));
    });
    req.on('error', rej);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
  });
}

function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

function pidAlive(pid) {
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8' });
  return r.stdout.includes(`"${pid}"`);
}

// ---------- Vite ----------

let viteProc = null;

export async function startVite() {
  try {
    await httpGet(`http://127.0.0.1:${VITE_PORT}/`);
    throw new Error(`Port ${VITE_PORT} is already in use; stop that dev server first (the suite starts and stops its own).`);
  } catch (e) {
    if (e.message.startsWith('Port ')) throw e;
  }
  viteProc = spawn(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'dev'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  viteProc.stdout.on('data', (d) => (log += d));
  viteProc.stderr.on('data', (d) => (log += d));
  try {
    await waitFor(async () => (await httpGet(`http://127.0.0.1:${VITE_PORT}/`)).status === 200, { timeout: 60000, interval: 300, label: 'vite dev server' });
  } catch (e) {
    killTree(viteProc.pid);
    throw new Error(`${e.message}\n${log}`);
  }
}

export function stopVite() {
  if (viteProc) killTree(viteProc.pid);
  viteProc = null;
  // Belt and braces: anything still listening on the port that we started is gone with the tree.
}

// ---------- Settings isolation ----------

/** Writes settings.json in the run's config dir (or removes it when `settings` is null) so a launch starts from known state. */
export function writeSettings(settings) {
  if (settings === null) {
    rmSync(SETTINGS_FILE, { force: true });
    return;
  }
  mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// ---------- Process memory ----------

/** Sum of working set (bytes) of the process tree under `pid`, by process name. */
export function processTreeMemory(pid) {
  const r = spawnSync(
    'pwsh',
    ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize | ConvertTo-Json -Compress'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const all = JSON.parse(r.stdout);
  const kids = new Map();
  for (const p of all) {
    if (!kids.has(p.ParentProcessId)) kids.set(p.ParentProcessId, []);
    kids.get(p.ParentProcessId).push(p);
  }
  const byName = {};
  const stack = [...all.filter((p) => p.ProcessId === pid), ...(kids.get(pid) ?? [])];
  const seen = new Set();
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p.ProcessId)) continue;
    seen.add(p.ProcessId);
    byName[p.Name] = (byName[p.Name] ?? 0) + Number(p.WorkingSetSize);
    stack.push(...(kids.get(p.ProcessId) ?? []));
  }
  return byName;
}

// ---------- App launch ----------

/**
 * Fails fast when something already answers on the CDP port: Playwright would attach to that process (another
 * suite run, or any WebView2 app started with a debugging port) and drive the wrong app. Retries briefly so a
 * just-killed previous launch has time to release the port.
 */
async function assertCdpPortFree() {
  const url = `http://127.0.0.1:${CDP_PORT}/json/version`;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await httpGet(url);
    } catch {
      return; // nothing listening: free
    }
    await sleep(500);
  }
  throw new Error(`Something already answers on CDP port ${CDP_PORT} (another E2E run, or an app started with --remote-debugging-port=${CDP_PORT}); stop it first. One E2E run at a time.`);
}

/**
 * Launches the debug exe with a CDP port, connects, waits for the editor shell.
 * Returns { page, pid, close(), exited(), logs() }.
 */
export async function launchApp({ args = [], multiInstance = true } = {}) {
  if (!existsSync(EXE)) throw new Error(`Missing ${EXE}; run cargo build in src-tauri first.`);
  await assertCdpPortFree();
  const proc = spawn(DESKRUN ?? EXE, DESKRUN ? ['run', DESKTOP, EXE, ...args] : args, {
    // MULTI_INSTANCE: the single-instance plugin would swallow this launch into any Cirth the user has open.
    // Only the single-instance scenario passes multiInstance: false.
    // USER_DATA_FOLDER: a running Cirth holds the default WebView2 profile, and WebView2 refuses a second
    // process on that profile with different browser arguments (0x8007139F). A fresh folder per run (deleted by cleanupRun).
    env: isolatedEnv({
      ...(multiInstance ? { CIRTH_MULTI_INSTANCE: '1' } : {}),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: WEBVIEW2_DIR,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  let log = '';
  proc.stdout.on('data', (d) => {
    log += d;
    const m = DESKRUN && /^PID (\d+)/m.exec(log);
    if (m) appPids.set(proc.pid, Number(m[1]));
  });
  proc.stderr.on('data', (d) => (log += d));
  let exitCode = null;
  proc.on('exit', (c) => (exitCode = c ?? -1));
  const app = {
    pid: proc.pid,
    proc,
    page: null,
    browser: null,
    consoleErrors: [],
    logs: () => log,
    exited: () => exitCode !== null,
    exitCode: () => exitCode,
    async close() {
      try {
        await app.browser?.close();
      } catch {
        /* disconnecting a dead browser may throw; nothing to clean up */
      }
      killTree(proc.pid);
      await waitFor(() => !pidAlive(proc.pid), { timeout: 10000, label: `exit of ${proc.pid}` }).catch((e) => console.error(`  warn: ${e.message}`));
    },
  };
  try {
    await waitFor(async () => (await httpGet(`http://127.0.0.1:${CDP_PORT}/json/version`)).status === 200, { timeout: 30000, interval: 200, label: 'CDP endpoint' });
    app.browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    app.page = await waitFor(() => app.browser.contexts()[0]?.pages().find((p) => (USE_CUSTOM_EXE ? /tauri\.localhost/.test(p.url()) : p.url().includes(`:${VITE_PORT}`))), { timeout: 20000, label: 'app page' });
    app.page.on('console', (m) => {
      if (m.type() === 'error') app.consoleErrors.push(m.text());
    });
    app.page.on('pageerror', (e) => app.consoleErrors.push(`pageerror: ${e.message}`));
    await app.page.waitForSelector('.cm-content', { timeout: 60000 });
    // Startup paths are opened after mount; give them a moment unless the caller waits for something specific.
    await app.page.waitForTimeout(300);
  } catch (e) {
    await app.close();
    throw new Error(`launch failed: ${e.message}\n--- app log ---\n${log.slice(-2000)}`);
  }
  return app;
}

// ---------- Page helpers ----------

export const ed = {
  /** Full document text via the CodeMirror view attached to .cm-content. */
  doc: (page) =>
    page.evaluate(() => {
      const v = (document.querySelector('.cm-content')?.cmTile ?? document.querySelector('.cm-content')?.cmView)?.view;
      if (!v) throw new Error('no CodeMirror view on .cm-content');
      return v.state.doc.toString();
    }),
  /** Metrics that do not copy the document (for big files). */
  docInfo: (page) =>
    page.evaluate(() => {
      const v = (document.querySelector('.cm-content')?.cmTile ?? document.querySelector('.cm-content')?.cmView)?.view;
      const sel = v.state.selection.main;
      return { length: v.state.doc.length, lines: v.state.doc.lines, head: sel.head, line: v.state.doc.lineAt(sel.head).number, col: sel.head - v.state.doc.lineAt(sel.head).from + 1 };
    }),
  /** Replaces the whole document with one transaction (test setup only). */
  setDoc: (page, text) =>
    page.evaluate((t) => {
      const v = (document.querySelector('.cm-content')?.cmTile ?? document.querySelector('.cm-content')?.cmView)?.view;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t } });
    }, text),
  focus: async (page) => {
    await page.click('.cm-content');
  },
  end: async (page) => {
    await page.click('.cm-content');
    await page.keyboard.press('Control+End');
  },
  /** Moves the cursor to doc end and types text (no auto-closing characters please). */
  typeAtEnd: async (page, text) => {
    await ed.end(page);
    await page.keyboard.type(text);
  },
  selection: (page) =>
    page.evaluate(() => {
      const v = (document.querySelector('.cm-content')?.cmTile ?? document.querySelector('.cm-content')?.cmView)?.view;
      const s = v.state.selection.main;
      return { from: s.from, to: s.to, text: v.state.sliceDoc(s.from, s.to), line: v.state.doc.lineAt(s.head).number, col: s.head - v.state.doc.lineAt(s.head).from + 1, fromCol: s.from - v.state.doc.lineAt(s.from).from + 1 };
    }),
  scrollTop: (page) => page.evaluate(() => document.querySelector('.cm-scroller').scrollTop),
};

export const ui = {
  tabs: (page) =>
    page.evaluate(() =>
      [...document.querySelectorAll('.strip .tab')].map((t) => ({
        id: t.getAttribute('data-tab'),
        title: t.querySelector('[role=tab]').textContent.trim().replace(/ \(deleted\)$/, ''),
        active: t.classList.contains('active'),
        dirty: !!t.querySelector('.dot'),
        deleted: t.classList.contains('deleted'),
      })),
    ),
  tab: (page, title) => page.locator(`.strip [role=tab]`, { hasText: title }).first(),
  clickTab: async (page, title) => {
    await page.locator('.strip [role=tab]', { hasText: title }).first().click();
    await page.waitForTimeout(100);
  },
  activeTitle: async (page) => (await ui.tabs(page)).find((t) => t.active)?.title ?? null,
  status: (page) => page.locator('footer.status').innerText(),
  eol: (page) => page.locator('footer.status button[title^="End of line"]').innerText(),
  encoding: (page) => page.locator('footer.status button[title^="Save with encoding"]').innerText(),
  language: (page) => page.locator('footer.status button[title="Language"]').innerText(),
  pickStatus: async (page, titlePrefix, item) => {
    await page.locator(`footer.status button[title^="${titlePrefix}"]`).click();
    await page.locator('.picker [role=option]', { hasText: new RegExp(`^\\s*${item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) }).click();
    await page.waitForTimeout(100);
  },
  toasts: (page) => page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => ({ kind: t.classList.contains('error') ? 'error' : 'info', text: t.querySelector('.msg').textContent.trim() }))),
  clearToasts: async (page) => {
    for (const b of await page.locator('.toast .close').all()) await b.click();
  },
  dialog: (page) => page.locator('[role=alertdialog]'),
  dialogButton: (page, label) => page.locator('[role=alertdialog] button', { hasText: label }),
  lightBadge: (page) => page.locator('footer.status .badge').count(),
  openSettings: async (page) => {
    await page.keyboard.press('Control+,');
    await page.waitForSelector('[role=dialog][aria-label=Settings]');
  },
  closeSettings: async (page) => {
    await page.locator('[role=dialog][aria-label=Settings] button', { hasText: 'Close' }).click();
    await page.waitForSelector('[role=dialog][aria-label=Settings]', { state: 'detached' });
  },
};

// ---------- Fixtures ----------

export function makeTmp(prefix = 'se-e2e-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function write(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  return path;
}

export { readFileSync, existsSync, join, mkdirSync, rmSync, copyFileSync, killTree };

/** Encode text as the editor would write it. */
export function encodeFor(text, { encoding, bom, eol }) {
  const t = eol === 'crlf' ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n');
  const withBom = bom ? '﻿' + t : t;
  switch (encoding) {
    case 'utf-8':
      return Buffer.from(withBom, 'utf8');
    case 'utf-16le':
      return Buffer.from(withBom, 'utf16le');
    case 'utf-16be':
      return Buffer.from(withBom, 'utf16le').swap16();
    case 'windows-1252':
      return Buffer.from(withBom, 'latin1');
    default:
      throw new Error(`encodeFor: unsupported ${encoding}`);
  }
}

/** Polls until the file's bytes equal `expected`; returns the final bytes either way (never throws on mismatch). */
export async function waitBytes(path, expected, timeout = 5000) {
  const start = Date.now();
  let got = readFileSync(path);
  while (!got.equals(expected) && Date.now() - start < timeout) {
    await sleep(50);
    got = readFileSync(path);
  }
  return got;
}

/** Ctrl+S then wait until the active tab shows no dirty dot (dirty check is throttled, so poll). */
export async function saveActive(page) {
  await page.keyboard.press('Control+s');
}

import { deflateSync } from 'node:zlib';

/** A valid w x h RGBA PNG (solid colour). */
export function makePng(w = 4, h = 3, rgba = [200, 30, 30, 255]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgba).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Sends WM_CLOSE to the app's main window (what the X button does). Returns true when a window accepted it. */
export function closeMainWindow(pid) {
  if (DESKRUN) {
    const r = spawnSync(DESKRUN, ['close', DESKTOP, String(appPids.get(pid) ?? pid)], { encoding: 'utf8' });
    return r.stdout.trim() === 'True';
  }
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).CloseMainWindow()`], { encoding: 'utf8' });
  return r.stdout.trim() === 'True';
}
