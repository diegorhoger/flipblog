import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import express from 'express';
import request from 'supertest';
import { createGracefulShutdown, isShuttingDown } from '../src/shutdown.js';
import { createHealthRouter } from '../src/routes/health.js';

const TMP = tmpdir();
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(HERE, '..');

function newDir(prefix) {
  return mkdtempSync(join(TMP, prefix));
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// A fake http.Server whose close() reports a completed drain synchronously so
// unit tests can drive shutdown deterministically.
function fakeServer({ onClose = () => {} } = {}) {
  return {
    closed: 0,
    idleClosed: 0,
    close(cb) {
      this.closed++;
      // Simulate the drain completing on the next tick, like a real server.
      setImmediate(() => {
        onClose();
        cb();
      });
    },
    closeIdleConnections() {
      this.idleClosed++;
    },
  };
}

// ------------------------------------------------------------------ shutdown unit

test('graceful shutdown drains, closes the db, and exits 0', async () => {
  const server = fakeServer();
  let dbClosed = 0;
  let exitCode = null;
  let events = [];
  const fakeLog = {
    info: (e) => events.push(['info', e.event]),
    warn: (e) => events.push(['warn', e.event]),
    error: (e) => events.push(['error', e.event]),
  };

  const ctl = createGracefulShutdown({
    server,
    closeDb: () => dbClosed++,
    graceMs: 5000,
    signals: [], // do not attach process handlers in tests
    log: fakeLog,
    exitFn: (code) => {
      exitCode = code;
    },
  });

  const result = await ctl.shutdown('SIGTERM');
  assert.equal(result, 0, 'resolves with the clean exit code');
  assert.equal(exitCode, 0, 'clean exit code 0');
  assert.equal(server.closed, 1, 'server.close called exactly once');
  assert.equal(server.idleClosed, 1, 'idle keep-alive sockets closed');
  assert.equal(dbClosed, 1, 'database closed after drain');
  assert.equal(isShuttingDown(), false, 'shutdown flag cleared after completion');
  cleanup(server);
});

test('shutdown is idempotent across duplicate signals', async () => {
  const server = fakeServer();
  let dbClosed = 0;

  const ctl = createGracefulShutdown({
    server,
    closeDb: () => dbClosed++,
    signals: [],
    graceMs: 5000,
    exitFn: () => {},
  });

  const first = ctl.shutdown('SIGTERM');
  await ctl.shutdown('SIGINT'); // duplicate while already draining
  const second = await Promise.resolve();
  void second;

  await first;
  assert.equal(server.closed, 1, 'only one server.close() despite two signals');
  assert.equal(dbClosed, 1, 'only one closeDb()');
});

test('shutdown is idempotent: concurrent calls return the same in-flight promise', async () => {
  const server = fakeServer();
  const ctl = createGracefulShutdown({
    server,
    closeDb: () => {},
    signals: [],
    graceMs: 5000,
    exitFn: () => {},
  });
  const p1 = ctl.shutdown('SIGTERM');
  const p2 = ctl.shutdown('SIGINT');
  assert.equal(p1, p2, 'duplicate signals return the same promise (no second drain)');
  await p1;
});

test('shutdown force-exits with code 1 when the drain exceeds the grace period', async () => {
  // A server whose close() never completes -> drain hangs past the deadline.
  const hanging = {
    closed: 0,
    close(cb) {
      this.closed++;
      // never call cb: the request is stuck forever
      void cb;
    },
    closeIdleConnections() {},
  };
  let exitCode = null;
  let timedOut = false;
  const fakeLog = {
    log: () => {},
    warn: (e) => {
      if (e.event === 'shutdown_forced') timedOut = true;
    },
    error: () => {},
  };

  const ctl = createGracefulShutdown({
    server: hanging,
    closeDb: () => {},
    graceMs: 60,
    signals: [],
    log: fakeLog,
    exitFn: (code) => {
      exitCode = code;
    },
  });

  const result = await ctl.shutdown('SIGTERM');
  assert.equal(result, 1, 'resolves with the forced exit code');
  assert.equal(exitCode, 1, 'force-exit code 1');
  assert.ok(timedOut, 'logged a forced-timeout warning');
  assert.equal(hanging.closed, 1, 'close() was still called once');
});

test('shutdown calls closeDb only after close succeeds', async () => {
  let closed = false;
  const server = {
    close(cb) {
      assert.equal(closed, false, 'closeDb must not run before server.close callback');
      setImmediate(cb);
    },
    closeIdleConnections() {},
  };
  const ctl = createGracefulShutdown({
    server,
    closeDb: () => {
      closed = true;
    },
    signals: [],
    graceMs: 5000,
    exitFn: () => {},
  });
  await ctl.shutdown('SIGTERM');
  assert.equal(closed, true, 'closeDb ran after server closed');
});

// -------------------------------------------------------- readiness during drain

test('readiness reports 503 shutting_down while the service is draining', async () => {
  const app = express();
  app.use(
    '/api/health',
    createHealthRouter({
      getDb: () => {
        throw new Error('must not be called while draining');
      },
      // Force the draining flag on so the router short-circuits to 503.
      isShuttingDown: () => true,
    })
  );

  const res = await request(app).get('/api/health/ready');
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, { status: 'unavailable', reason: 'shutting_down' });
});

test('readiness delegates to the database check when not draining', async () => {
  let dbCheckCalled = false;
  const app = express();
  app.use(
    '/api/health',
    createHealthRouter({
      getDb: () => {
        dbCheckCalled = true;
        throw new Error('db unavailable');
      },
      isShuttingDown: () => false,
    })
  );

  const res = await request(app).get('/api/health/ready');
  assert.equal(res.status, 503);
  assert.equal(dbCheckCalled, true);
  assert.equal(res.body.reason, 'database_unavailable');
});

// The router's default wiring reads the module-level flag, and
// createGracefulShutdown sets that same flag. Prove the two are connected
// deterministically (no network race): shutdown() must flip isShuttingDown()
// synchronously, and reset it once the drain completes.
test('createGracefulShutdown drives the module-level flag that readiness reads', async () => {
  const server = fakeServer();
  const ctl = createGracefulShutdown({
    server,
    closeDb: () => {},
    signals: [],
    graceMs: 5000,
    exitFn: () => {},
  });

  assert.equal(isShuttingDown(), false, 'flag false while running');
  const p = ctl.shutdown('SIGTERM');
  assert.equal(isShuttingDown(), true, 'flag set synchronously when drain starts');
  await p;
  assert.equal(isShuttingDown(), false, 'flag cleared after drain completes');
});

// ---------------------------------------------------------------- integration

function waitForReady(port) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    const loop = () => {
      if (Date.now() > deadline) return reject(new Error('server never became ready'));
      fetch(`http://127.0.0.1:${port}/api/health/live`)
        .then((r) => (r.ok ? resolve() : loop()))
        .catch(() => loop());
    };
    loop();
  });
}

function waitForExit(child, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('TIMEOUT'), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// Boots the real production server on a temp DB; resolves once it is live.
async function spawnServer() {
  const dir = newDir('fb-shutdown-srv-');
  const port = await freePort();
  const child = spawn(
    process.execPath,
    ['--no-warnings', join(SERVER_ROOT, 'src', 'index.js')],
    {
      cwd: SERVER_ROOT,
      env: {
        ...process.env,
        DB_PATH: join(dir, 'app.db'),
        PORT: String(port),
        HOST: '127.0.0.1',
        NODE_ENV: 'production',
        APP_SECRET: 'shutdown-test-secret-0123456789abcdef0123456789abcdef',
        TRUST_PROXY: 'loopback',
        SHUTDOWN_GRACE_MS: '5000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stdout += d));
  await waitForReady(port);
  return { child, stdout: () => stdout, port, dir };
}

test('real server exits 0 on SIGTERM with a clean drain (integration)', { skip: process.platform === 'win32' }, async () => {
  const { child, stdout, port, dir } = await spawnServer();
  try {
    // Liveness is reachable and the readiness gate passes while running.
    const live = await fetch(`http://127.0.0.1:${port}/api/health/live`);
    assert.equal(live.status, 200);
    const ready = await fetch(`http://127.0.0.1:${port}/api/health/ready`);
    assert.equal(ready.status, 200);

    // Send SIGTERM, then wait for a clean, prompt exit.
    child.kill('SIGTERM');
    const code = await waitForExit(child, 10_000);

    assert.equal(code, 0, `expected clean exit 0, got ${code}\n${stdout()}`);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    cleanup(dir);
  }
});