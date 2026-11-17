// Cuts a release: bumps the version, commits "Release vX.Y.Z" on dev and tags it.
//   npm run release -- patch|minor|major|X.Y.Z [--push]
// package.json is the one source of the version (tauri.conf.json reads it); this keeps Cargo.toml and Cargo.lock in step.
// --push also fast-forwards main to the release and pushes dev, main and the tag; the tag starts the GitHub release build.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const push = args.includes('--push');
const bump = args.find((a) => !a.startsWith('--'));

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
const run = (cmd, a) => execFileSync(cmd, a, { cwd: ROOT, stdio: 'inherit' });
/** npm through node itself: npm.cmd can't be spawned without a shell on Windows. `npm run` sets npm_execpath. */
function npm(a) {
  const cli = process.env.npm_execpath;
  if (!cli) fail('run it through npm: npm run release -- <bump>');
  run(process.execPath, [cli, ...a]);
}

export function nextVersion(current, bump) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!m) throw new Error(`current version ${current} is not X.Y.Z`);
  const [major, minor, patch] = m.slice(1).map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (!/^\d+\.\d+\.\d+$/.test(bump ?? '')) throw new Error('give patch, minor, major or an X.Y.Z version');
  const cmp = bump.split('.').map(Number).reduce((acc, n, i) => acc || n - [major, minor, patch][i], 0);
  if (cmp <= 0) throw new Error(`${bump} is not above the current ${current}`);
  return bump;
}

/** Replaces the first match of `re` in a file, failing loudly when there is none (so a format change can't skip a file). */
function replaceIn(file, re, replacement) {
  const path = join(ROOT, file);
  const text = readFileSync(path, 'utf8');
  if (!re.test(text)) fail(`no version found in ${file}`);
  writeFileSync(path, text.replace(re, replacement));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'dev') fail('run it on dev');
  if (git('status', '--porcelain')) fail('commit or stash your changes first');
  const current = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  let version;
  try {
    version = nextVersion(current, bump);
  } catch (e) {
    fail(e.message);
  }
  const tag = `v${version}`;
  if (git('tag', '--list', tag)) fail(`tag ${tag} already exists`);

  npm(['version', version, '--no-git-tag-version']); // package.json + package-lock.json
  replaceIn('src-tauri/Cargo.toml', /^(\[package\][\s\S]*?^version = ")[^"]+(")/m, `$1${version}$2`);
  replaceIn('src-tauri/Cargo.lock', /(name = "cirth"\r?\nversion = ")[^"]+(")/, `$1${version}$2`);
  git('add', 'package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock');
  git('commit', '-m', `Release ${tag}`);
  git('tag', '-a', tag, '-m', `Cirth ${version}`);
  console.log(`release: committed and tagged ${tag} on dev (${current} -> ${version})`);

  if (push) {
    git('fetch', '.', 'dev:main'); // fast-forward only; fails if main has diverged
    run('git', ['push', 'origin', 'dev', 'main']);
    // The tag goes in its own push: pushed together with the branches (v0.2.0), GitHub started no workflow run.
    run('git', ['push', 'origin', tag]);
    console.log(`release: pushed. GitHub Actions builds ${tag}: https://github.com/sjhowie/cirth/actions`);
  } else {
    console.log('release: to publish, run:\n  git fetch . dev:main\n  git push origin dev main\n  git push origin ' + tag);
  }
}
