#!/usr/bin/env node
// Reproducible production release build.
//
// Produces a self-contained, versioned release directory from the exact source
// in this checkout. The same commit always yields the same artifact because:
//   - the working tree must be clean (unless --allow-dirty is passed),
//   - the commit SHA is recorded inside the artifact (COMMIT),
//   - dependencies are installed from the committed package-lock.json via
//     `npm ci` (never a floating `npm install`),
//   - the front-end is compiled by Vite into server/public (deterministic),
//   - only a whitelisted file set is copied into the artifact (no .env files,
//     no dev databases, no runtime uploads).
//
// The release directory IS the built `server` package: src/, scripts/ and the
// compiled public/ with a production-only node_modules at the root. That keeps
// the systemd unit's WorkingDirectory=/srv/flipblog/current + `node src/index.js`
// working unchanged.
//
// Usage:
//   node scripts/build-release.mjs [--tag v1.2.0] [--version 8ede71b5a6b7] [--out dir] [--allow-dirty]
//
// Default output: dist/releases/<version> where version is:
//   - the value passed to --version (highest precedence; unique-per-commit IDs),
//   - else the --tag value minus a leading 'v',
//   - else the root package.json's version.

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SERVER = join(ROOT, 'server');

const CLEAN_CHECKOUT_DOC = 'Build the release from a clean checkout of the exact ref/tag (e.g. `git worktree add /tmp/build v1.2.0` and run this script there), or pass --allow-dirty to accept a dirty tree.';

function run(cmd, args, opts = {}) {
  // Invoke through the shell so `npm` resolves correctly on win32 (npm.cmd)
  // and POSIX. Args are internal script constants, never user input.
  execSync([cmd, ...args].join(' '), { cwd: ROOT, stdio: 'inherit', ...opts });
}

function git(args) {
  return execSync(['git', ...args].join(' '), { cwd: ROOT, encoding: 'utf8' }).trim();
}

function fail(msg) {
  console.error(`release build: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { tag: null, version: null, out: null, allowDirty: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tag') out.tag = argv[++i];
    else if (argv[i] === '--version') out.version = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--allow-dirty') out.allowDirty = true;
    else fail(`unknown argument: ${argv[i]}`);
  }
  return out;
}

// Copy a directory with an explicit skip filter so runtime data and local-only
// files (uploads, dev SQLite files) can never leak into the artifact.
function copyDirFiltered(src, dst, skipNames) {
  if (!existsSync(src)) return;
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (skipNames.has(entry.name)) continue;
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) copyDirFiltered(from, to, skipNames);
    else cpSync(from, to);
  }
}

const args = parseArgs(process.argv.slice(2));

// --- 1. Pin the exact ref ----------------------------------------------------
if (!args.allowDirty) {
  const dirty = git(['status', '--porcelain']);
  if (dirty) {
    fail(`working tree is not clean (${dirty.split('\n').length} change(s)). ${CLEAN_CHECKOUT_DOC}`);
  }
}
const commit = git(['rev-parse', 'HEAD']);
const head = git(['rev-list', '-n', '1', 'HEAD']);
if (args.tag) {
  let tagged;
  try {
    tagged = git(['rev-list', '-n', '1', args.tag]);
  } catch {
    fail(`--tag ${args.tag} does not exist in this repository`);
  }
  if (tagged !== head) {
    fail(`HEAD (${head.slice(0, 12)}) is not the commit tagged ${args.tag} (${tagged.slice(0, 12)}). ${CLEAN_CHECKOUT_DOC}`);
  }
}
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
// --version takes precedence over --tag and package.json so the pipeline can
// pass an immutable, unique-per-commit identifier (e.g. the short SHA) and a
// re-deploy of the same SHA never lands in a different artifact directory.
const version = args.version || (args.tag ? args.tag.replace(/^v/, '') : rootPkg.version);
const outDir = resolve(args.out || join(ROOT, 'dist', 'releases', version));

console.log(`Release build for ${version} @ ${commit.slice(0, 12)} -> ${outDir}`);

// --- 2. Clean dependency install + production build --------------------------
if (existsSync(join(SERVER, 'node_modules'))) {
  console.log('Removing existing server node_modules for a clean install…');
  rmSync(join(SERVER, 'node_modules'), { recursive: true, force: true });
}
run('npm', ['ci']);
run('npm', ['run', 'build']);

// --- 3. Stage the release directory -----------------------------------------
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Server package.json: keep only what runtime needs (no devDependencies,
// no test/lint scripts) so the artifact is unambiguous about what it runs.
const serverPkg = JSON.parse(readFileSync(join(SERVER, 'package.json'), 'utf8'));
const releasePkg = {
  name: serverPkg.name,
  version,
  type: serverPkg.type,
  main: serverPkg.main,
  engines: serverPkg.engines,
  dependencies: serverPkg.dependencies,
};
writeFileSync(join(outDir, 'package.json'), `${JSON.stringify(releasePkg, null, 2)}\n`);

// Reproducibility pins: the exact lockfile and the exact commit/node used.
cpSync(join(ROOT, 'package-lock.json'), join(outDir, 'package-lock.json'));
copyDirFiltered(join(SERVER, 'src'), join(outDir, 'src'), new Set(['data']));
copyDirFiltered(join(SERVER, 'scripts'), join(outDir, 'scripts'), new Set());
// The web bundle is built into server/public. Skip runtime uploads and any
// local SQLite files so they never ship in the artifact.
copyDirFiltered(join(SERVER, 'public'), join(outDir, 'public'), new Set(['uploads', 'data']));
writeFileSync(join(outDir, 'VERSION'), `${version}\n`);
writeFileSync(join(outDir, 'COMMIT'), `${commit}\n`);
writeFileSync(join(outDir, 'BUILD_INFO'), `node=${process.version} platform=${process.platform}\n`);

// --- 4. Production-only dependencies inside the artifact ----------------------
// `npm ci --omit=dev` against the committed lockfile makes the node_modules
// tree reproducible too (no dev tools: vite, vitest, playwright, supertest).
run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: outDir });

// --- 5. Verify the artifact is self-contained ---------------------------------
for (const rel of ['src/index.js', 'public/index.html', 'package-lock.json', 'node_modules/express']) {
  if (!existsSync(join(outDir, rel))) {
    fail(`release artifact is missing expected path: ${rel}`);
  }
}
const size = (() => {
  let n = 0;
  const walk = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const fp = join(p, e.name);
      if (e.isDirectory()) walk(fp);
      else n += statSync(fp).size;
    }
  };
  walk(outDir);
  return n;
})();
console.log(`Release artifact ready: ${outDir}`);
console.log(`  commit : ${commit.slice(0, 12)}`);
console.log(`  files  : ${size} bytes (${Math.round(size / 1024)} KiB)`);
console.log(`  verify : node scripts/release-smoke.mjs --release ${outDir}`);
