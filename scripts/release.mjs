// Cuts a release: bumps the version, renames CHANGELOG.md's "## Unreleased" to the version and date, commits
// "Release vX.Y.Z" on dev and tags it.
//   npm run release -- patch|minor|major|X.Y.Z [--push]
// package.json is the one source of the version (tauri.conf.json reads it); this keeps Cargo.toml and Cargo.lock in step.
// Preflight (before any file changes): on dev, clean tree, dev not behind origin/dev, origin/main an ancestor of dev,
// tag unused, CHANGELOG.md has Unreleased items.
// --push also pushes dev and main (fast-forward) in one atomic push, then the tag on its own; the tag starts the GitHub release build.
// If a step fails once the commit exists, the exact recovery commands are printed.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notesFor, stampUnreleased, unreleasedItemCount, localDate } from './changelog-notes.mjs';

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
  if (!cli) throw new Error('run it through npm: npm run release -- <bump>');
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
  if (!re.test(text)) throw new Error(`no version found in ${file}`);
  writeFileSync(path, text.replace(re, replacement));
}

/** True when `ancestor` is reachable from `descendant`. Exit 1 means "no"; anything else is a real git failure. */
function isAncestor(ancestor, descendant) {
  const r = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: ROOT, encoding: 'utf8' });
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  fail(`git merge-base ${ancestor} ${descendant} failed: ${r.stderr.trim()}`);
}

/** Everything that can be checked without touching a file. Fails with the first problem. */
function preflight(version, tag) {
  if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'dev') fail('run it on dev');
  if (git('status', '--porcelain')) fail('commit or stash your changes first');
  try {
    git('fetch', 'origin');
  } catch (e) {
    fail(`git fetch origin failed (offline?): ${e.message.split('\n')[0]}`);
  }
  if (!isAncestor('origin/dev', 'HEAD')) fail('dev is behind or has diverged from origin/dev; pull or rebase first');
  if (!isAncestor('origin/main', 'HEAD')) fail('origin/main is not an ancestor of dev, so main cannot fast-forward; merge main into dev first');
  if (git('tag', '--list', tag)) fail(`tag ${tag} already exists locally`);
  if (git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`)) fail(`tag ${tag} already exists on origin`);
  let changelog;
  try {
    changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  } catch (e) {
    fail(`cannot read CHANGELOG.md: ${e.message}`);
  }
  if (unreleasedItemCount(changelog) === 0) fail('CHANGELOG.md needs a "## Unreleased" section with at least one item; write the release notes first');
  if (notesFor(changelog, version) !== null) fail(`CHANGELOG.md already has an entry for ${version}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const current = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  let version;
  try {
    version = nextVersion(current, bump);
  } catch (e) {
    fail(e.message);
  }
  const tag = `v${version}`;
  preflight(version, tag);

  const files = ['package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'CHANGELOG.md'];
  /** What the user must run if the release stops half way; set as the steps advance. */
  let recovery = `git restore ${files.join(' ')}`;
  try {
    npm(['version', version, '--no-git-tag-version']); // package.json + package-lock.json
    replaceIn('src-tauri/Cargo.toml', /^(\[package\][\s\S]*?^version = ")[^"]+(")/m, `$1${version}$2`);
    replaceIn('src-tauri/Cargo.lock', /(name = "cirth"\r?\nversion = ")[^"]+(")/, `$1${version}$2`);
    const changelogPath = join(ROOT, 'CHANGELOG.md');
    writeFileSync(changelogPath, stampUnreleased(readFileSync(changelogPath, 'utf8'), version, localDate()));
    git('add', ...files);
    git('commit', '-m', `Release ${tag}`);
    git('tag', '-a', tag, '-m', `Cirth ${version}`);
    const publish = `git push --atomic origin dev dev:main\n  git push origin ${tag}`;
    recovery = `to retry the publish:\n  ${publish}\nor to abandon the release:\n  git tag -d ${tag}\n  git reset --hard HEAD~1`;
    console.log(`release: committed and tagged ${tag} on dev (${current} -> ${version})`);

    if (push) {
      // One atomic push: dev and main both move, or neither does. main is a fast-forward (preflight checked it).
      run('git', ['push', '--atomic', 'origin', 'dev', 'dev:main']);
      recovery = `the branches are pushed; push the tag to start the build:\n  git push origin ${tag}`;
      // The tag goes in its own push: pushed together with the branches (v0.2.0), GitHub started no workflow run.
      run('git', ['push', 'origin', tag]);
      try {
        git('fetch', '.', 'dev:main'); // keep local main level; refused when main is checked out elsewhere
      } catch {
        console.warn('release: local main was not updated (checked out in another worktree?); run git fetch . dev:main when free');
      }
      console.log(`release: pushed. GitHub Actions builds ${tag}: https://github.com/sjhowie/cirth/actions`);
    } else {
      console.log(`release: to publish, run:\n  ${publish}\n  git fetch . dev:main   # optional: local main level with dev`);
    }
  } catch (e) {
    console.error(`release: stopped part way: ${e.message}`);
    console.error(`release: recovery: ${recovery}`);
    process.exit(1);
  }
}
