import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, sep, isAbsolute } from 'node:path';
import { resolveConfig } from '../src/config.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(testDir, '..');
const repoRoot = resolve(serverDir, '..');
const externalDir = tmpdir();

test('storage paths are independent of the launch working directory', () => {
  const env = { UPLOADS_DIR: 'uploads', DB_PATH: 'data/app.db' };
  const original = process.cwd();

  let fromServerDir;
  let fromRepoRoot;
  try {
    process.chdir(repoRoot);
    fromRepoRoot = resolveConfig(env);

    process.chdir(serverDir);
    fromServerDir = resolveConfig(env);
  } finally {
    process.chdir(original);
  }

  // Same configured relative paths + any cwd => identical resolved locations.
  assert.equal(fromServerDir.uploadsDir, fromRepoRoot.uploadsDir);
  assert.equal(fromServerDir.dbPath, fromRepoRoot.dbPath);
  // Resolved locations are absolute and anchored at the server root, not cwd.
  assert.ok(fromRepoRoot.uploadsDir.includes(`${sep}server${sep}uploads`));
  assert.ok(isAbsolute(fromRepoRoot.uploadsDir));
});

test('absolute env paths are used as-is regardless of cwd', () => {
  // resolver relies on path.isAbsolute, which is OS-specific.
  const absUploads = sep === '\\' ? 'C:\\absolute\\uploads' : '/absolute/uploads';
  const absDb = sep === '\\' ? 'C:\\absolute\\db.sqlite' : '/absolute/db.sqlite';
  const env = { UPLOADS_DIR: absUploads, DB_PATH: absDb };
  const original = process.cwd();
  let resolved;
  try {
    process.chdir(externalDir);
    resolved = resolveConfig(env);
  } finally {
    process.chdir(original);
  }
  assert.equal(resolved.uploadsDir, absUploads);
  assert.equal(resolved.dbPath, absDb);
});
