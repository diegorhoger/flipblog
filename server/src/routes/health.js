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

// Readiness: the service can actually do its job. Confirms the database is open,
// fully migrated to the version this build expects, and passes integrity /
// foreign-key checks. No filesystem paths or SQL are ever returned — only a
// coarse status and the migration counts needed by an operator to diagnose.
function readyHandler(_req, res) {
  try {
    const db = getDb();
    const health = checkDatabaseHealth(db);
    if (!health.ok) {
      return res.status(503).json({
        status: 'unavailable',
        reason: 'database_health_check_failed',
      });
    }
    const { expected, applied } = health.checks.migrationVersion;
    return res.json({
      status: 'ok',
      checks: {
        integrity: health.checks.integrity,
        foreignKeys: health.checks.foreignKeys,
        migrationVersion: {
          expected,
          applied: applied.length,
          current: applied.length === expected,
        },
      },
    });
  } catch {
    return res.status(503).json({ status: 'unavailable', reason: 'database_unavailable' });
  }
}

export function createHealthRouter() {
  const router = Router();
  router.get('/', liveHandler);
  router.get('/live', liveHandler);
  router.get('/ready', readyHandler);
  return router;
}

export const healthRouter = createHealthRouter();
