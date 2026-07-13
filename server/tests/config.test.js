import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveConfig } from '../src/config.js';

test('storage paths are independent of the launch working directory', () => {
  const env = { UPLOADS_DIR: 'uploads', DB_PATH: 'data/app.db' };
  const original = process.cwd();

  let fromServerDir;
  let fromRepoRoot;
  try {
    process.chdir('..');
    fromRepoRoot = resolveConfig(env);

    process.chdir('server');
    fromServerDir = resolveConfig(env);
  } finally {
    process.chdir(original);
  }

  // Same configured relative paths + any cwd => identical resolved locations.
  assert.equal(fromServerDir.uploadsDir, fromRepoRoot.uploadsDir);
  assert.equal(fromServerDir.dbPath, fromRepoRoot.dbPath);
  // Resolved locations are absolute and anchored at the server root, not cwd.
  assert.ok(fromRepoRoot.uploadsDir.includes(`${path.sep}server${path.sep}uploads`));
  assert.ok(path.isAbsolute(fromRepoRoot.uploadsDir));
});

test('absolute env paths are used as-is regardless of cwd', () => {
  const env = { UPLOADS_DIR: 'C:\\absolute\\uploads', DB_PATH: 'C:\\absolute\\db.sqlite' };
  const original = process.cwd();
  let resolved;
  try {
    process.chdir('..');
    resolved = resolveConfig(env);
  } finally {
    process.chdir(original);
  }
  assert.equal(resolved.uploadsDir, 'C:\\absolute\\uploads');
  assert.equal(resolved.dbPath, 'C:\\absolute\\db.sqlite');
});
