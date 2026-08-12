#!/usr/bin/env node
// Runtime smoke test for a release artifact produced by build-release.mjs.
//
// Boots the built release directory on a throwaway database exactly as the
// systemd unit would (WorkingDirectory=<release>, `node src/index.js`,
// NODE_ENV=production), then verifies:
//   - liveness returns 200 (process up, no DB dependency),
//   - readiness returns 200 (migrations applied + integrity passes),
//   - the built SPA index.html is served at /,
//   - SIGTERM triggers the bounded graceful shutdown and the process exits 0.
//
// Usage:
//   node scripts/release-smoke.mjs --release <release-dir>

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i === -1 || !process.argv[i + 1]) {
    console.error(`usage: node scripts/release-smoke.mjs --release <release-dir>`);
    process.exit(2);
  }
  return resolve(process.argv[i + 1]);
}

const releaseDir = arg('--release');
const appSecret = 'smoke-secret-0123456789abcdef0123456789abcdef';

async function freePort() {
  return new Promise((resolvePort) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolvePort(port));
    });
  });
}

async function waitFor(fn, timeoutMs = 20_000, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('timeout waiting for condition');
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`SMOKE FAIL: ${msg}`);
    process.exit(1);
  }
}

// Sanity: the argument is a built release dir, not the repo root.
for (const rel of ['src/index.js', 'package.json', 'node_modules']) {
  if (!existsSync(join(releaseDir, rel))) {
    console.error(`not a release dir (missing ${rel}): ${releaseDir}`);
    process.exit(2);
  }
}

const runtime = mkdtempSync(join(tmpdir(), 'flipblog-smoke-'));
const port = await freePort();
console.log(`Booting release ${releaseDir} on 127.0.0.1:${port}`);

const child = spawn(
  process.execPath,
  ['--no-warnings', 'src/index.js'],
  {
    cwd: releaseDir,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      HOST: '127.0.0.1',
      APP_SECRET: appSecret,
      TRUST_PROXY: 'loopback',
      DB_PATH: join(runtime, 'smoke.db'),
      UPLOADS_DIR: join(runtime, 'uploads'),
      DB_BACKUP_ENABLED: 'false',
      BACKUP_OFFSITE_ENABLED: 'false',
      SHUTDOWN_GRACE_MS: '2000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
);

let logs = '';
child.stdout.on('data', (d) => (logs += d));
child.stderr.on('data', (d) => (logs += d));

let exitCode = null;
child.on('exit', (code) => {
  exitCode = code;
});

try {
  const base = `http://127.0.0.1:${port}`;

  await waitFor(async () => {
    const res = await fetch(`${base}/api/health/live`);
    return res.status === 200;
  });
  console.log('  liveness 200 ✓');

  await waitFor(async () => {
    const res = await fetch(`${base}/api/health/ready`);
    return res.status === 200;
  });
  console.log('  readiness 200 ✓');

  const spa = await fetch(`${base}/`);
  assert(spa.status === 200, `GET / returned ${spa.status}`);
  const html = await spa.text();
  assert(html.includes('<div id="app"') || html.includes('index-'), 'index.html does not look like the built SPA');
  console.log('  SPA served ✓');

  if (process.platform === 'win32') {
    // win32 has no POSIX signals: subprocess.kill('SIGTERM') force-kills, so the
    // graceful drain cannot be observed locally. The Linux CI job runs this same
    // script and asserts the full graceful-shutdown path there.
    console.log('  graceful shutdown check skipped on win32 (covered on Linux CI)');
  } else {
    child.kill('SIGTERM');
    const deadline = Date.now() + 10_000;
    while (exitCode === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(exitCode !== null, `process did not exit after SIGTERM (drain hang?)\n${logs}`);
    assert(exitCode === 0, `expected exit 0 after graceful shutdown, got ${exitCode}\n${logs}`);
    // 'exit' can fire before the final stdout chunk reaches the pipe; settle a
    // moment so the drain log line is captured before asserting on it.
    await new Promise((r) => setTimeout(r, 500));
    assert(logs.includes('shutdown_drained'), 'did not log a completed drain');
    console.log('  graceful shutdown exit 0 ✓');
  }

  console.log('SMOKE PASS');
} catch (err) {
  console.error(`SMOKE FAIL: ${err.message}\n${logs}`);
  process.exit(1);
} finally {
  // On win32 the graceful check is skipped, so the child is still running;
  // on POSIX it already exited. Either way, ensure it is gone before removing
  // the runtime dir (Windows can hold the DB/uploads dir open briefly).
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 3000);
      child.on('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(runtime, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}
