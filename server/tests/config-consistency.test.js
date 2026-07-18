import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(HERE, '..');
const FIXTURE = join(SERVER_ROOT, 'tests', 'fixtures', 'config-probe.js');

// Resolve config in an isolated child process (fresh module graph, no import
// cache tricks) and report dbPath + isMemoryDb so we can assert they agree for
// a given DB_PATH without mutating this process's environment or modules.
function probe(dbPath) {
  const result = spawnSync(
    process.execPath,
    [FIXTURE],
    {
      cwd: SERVER_ROOT,
      env: { ...process.env, DB_PATH: dbPath, NODE_NO_WARNINGS: '1' },
      encoding: 'utf8',
    }
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('config.dbPath and isMemoryDb agree for an in-memory database', () => {
  const cfg = probe(':memory:');
  assert.equal(cfg.dbPath, ':memory:');
  assert.equal(cfg.isMemoryDb, true);
});

test('config.dbPath and isMemoryDb agree for a file database', () => {
  const dbPath = join(SERVER_ROOT, 'data', 'probe.db');
  const cfg = probe(dbPath);
  // resolveConfig anchors relative DB_PATH at serverRoot, so it is absolute.
  assert.equal(cfg.isMemoryDb, false);
  assert.ok(cfg.dbPath.endsWith('data/probe.db') || cfg.dbPath.endsWith('data\\probe.db'));
  assert.equal(cfg.dbPath === ':memory:', cfg.isMemoryDb);
});
