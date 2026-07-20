import { Router } from 'express';
import { getDb } from '../db.js';
import { checkDatabaseHealth } from '../db-health.js';

// Liveness: the process is up and able to handle requests. Deliberately does
// NOT touch the database — a wedged DB should not flip the liveness bit that
// tells an orchestrator to restart the container (that would restart a healthy
// process and lose the in-flight request that could be served).
function liveHandler(_req, res) {
  res.json({ status: 'ok', time: new Date().toISOString() });
}

// Pure readiness decision, separated from the HTTP layer so it can be tested
// directly. Returns the response body object (never throws). `current` is true
// only when every expected migration is applied AND no unknown migration is
// present; when `current` is false the result is `unavailable`, so readiness can
// never report `ok` while `migrationVersion.current` is false.
export function evaluateReadiness(db) {
  const health = checkDatabaseHealth(db);
  const mv = health.checks.migrationVersion;
  const current = mv.missing.length === 0 && mv.unexpected.length === 0;
  if (!health.ok) {
    return { status: 'unavailable', reason: 'database_health_check_failed' };
  }
  return {
    status: 'ok',
    checks: {
      integrity: health.checks.integrity,
      foreignKeys: health.checks.foreignKeys,
      migrationVersion: {
        expected: mv.expected,
        applied: mv.applied.length,
        current,
      },
    },
  };
}

// Readiness: the service can actually do its job. Confirms the database is open,
// fully migrated to the version this build expects, and passes integrity /
// foreign-key checks. No filesystem paths or SQL are ever returned — only a
// coarse status and the migration counts needed by an operator to diagnose.
function readyHandler(getDbFn) {
  return (_req, res) => {
    try {
      const result = evaluateReadiness(getDbFn());
      if (result.status !== 'ok') {
        return res.status(503).json(result);
      }
      return res.json(result);
    } catch {
      return res.status(503).json({ status: 'unavailable', reason: 'database_unavailable' });
    }
  };
}

export function createHealthRouter({ getDb: getDbFn = getDb } = {}) {
  const router = Router();
  router.get('/', liveHandler);
  router.get('/live', liveHandler);
  router.get('/ready', readyHandler(getDbFn));
  return router;
}

export const healthRouter = createHealthRouter();
