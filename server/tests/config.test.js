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
  // Use a path that is absolute on the current platform (the resolver relies on
  // path.isAbsolute, which is OS-specific). A hardcoded Windows drive letter is
  // not absolute on POSIX runners, so the path would be wrongly joined to the
  // server root there.
  const absUploads = process.platform === 'win32' ? 'C:\\absolute\\uploads' : '/absolute/uploads';
  const absDb = process.platform === 'win32' ? 'C:\\absolute\\db.sqlite' : '/absolute/db.sqlite';
  const env = { UPLOADS_DIR: absUploads, DB_PATH: absDb };
  const original = process.cwd();
  let resolved;
  try {
    process.chdir('..');
    resolved = resolveConfig(env);
  } finally {
    process.chdir(original);
  }
  assert.equal(resolved.uploadsDir, absUploads);
  assert.equal(resolved.dbPath, absDb);
});
