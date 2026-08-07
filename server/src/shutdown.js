import { logger } from './logging.js';

// Module-level "shutting down" flag. The health readiness endpoint reads it so
// an orchestrator/proxy stops routing traffic while the process drains. A single
// flag is accurate because production runs exactly one server per process.
let shuttingDown = false;

export function isShuttingDown() {
  return shuttingDown;
}

export const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;

// Bounded, idempotent graceful shutdown for a running HTTP server.
//
// On the first signal it:
//   1. stops accepting new connections (server.close),
//   2. drops idle keep-alive sockets so close() completes promptly,
//   3. waits for in-flight requests up to `graceMs`,
//   4. closes the database once the server has drained,
//   5. force-exits (code 1) if the drain exceeds `graceMs` — a hanging request
//      must never stop an orchestrator from recycling the process.
//
// Duplicate signals are ignored while a shutdown is already in progress: they
// return the same in-flight promise instead of starting a second drain.
export function createGracefulShutdown({
  server,
  closeDb,
  graceMs = DEFAULT_SHUTDOWN_GRACE_MS,
  signals = ['SIGTERM', 'SIGINT'],
  log = logger,
  exitFn = process.exit,
} = {}) {
  if (!server || typeof server.close !== 'function') {
    throw new Error('createGracefulShutdown requires an HTTP server with close()');
  }
  if (typeof closeDb !== 'function') {
    throw new Error('createGracefulShutdown requires a closeDb function');
  }

  let active = null;

  function shutdown(signal) {
    if (active) return active; // idempotent: a second signal joins the drain
    shuttingDown = true;
    active = new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (code) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        shuttingDown = false;
        resolve(code);
      };

      // Bound the drain. If a request never completes, the deadline force-exits
      // so the process cannot hang forever.
      timer = setTimeout(() => {
        log.warn({ event: 'shutdown_forced', signal, graceMs }, 'shutdown grace period elapsed; forcing exit');
        exitFn(1);
        finish(1);
      }, graceMs);
      if (typeof timer.unref === 'function') timer.unref();

      server.close(() => {
        log.info({ event: 'shutdown_drained', signal }, 'in-flight requests drained');
        try {
          closeDb();
        } catch (err) {
          log.error({ event: 'shutdown_close_db_error' }, err);
        }
        exitFn(0);
        finish(0);
      });

      // Idle keep-alive sockets are not active requests; drop them so close()
      // completes instead of waiting on sockets whose client is gone.
      if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
      }
    });
    return active;
  }

  for (const sig of signals) {
    process.on(sig, () => {
      void shutdown(sig);
    });
  }

  return {
    shutdown,
    isShuttingDown: () => shuttingDown,
  };
}
