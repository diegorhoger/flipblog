import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { config } from '../src/config.js';
import { authedAgent } from './helpers.js';
import { getDb } from '../src/db.js';
import {
  seedAdminIfMissing,
  setAvatar,
  getUserById,
  createUser,
} from '../src/services/admin.js';
import { createPost } from '../src/services/posts.js';
import { deleteUnreferencedUploads } from '../src/services/uploadRefs.js';

// A 1x1 PNG accepted by the upload fileFilter; the exact bytes are irrelevant.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAQDJ/PWeAAAAAElFTkSuQmCC',
  'base64'
);

mkdirSync(config.uploadsDir, { recursive: true });

// Track every file/dir we create (directly or via the route) so a stray failure
// never leaves artifacts behind in the real uploads directory.
const artifacts = [];
after(() => {
  for (const p of artifacts) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// Create a real file in the uploads directory, exactly as the upload endpoint
// would (`/uploads/<uuid>.<ext>`), and return its on-disk path and public URL.
function makeUpload(ext = '.png') {
  const name = `${randomUUID()}${ext}`;
  const filePath = path.join(config.uploadsDir, name);
  writeFileSync(filePath, 'fake-image-bytes');
  artifacts.push(filePath);
  return { name, filePath, url: `${config.uploadsUrl}/${name}` };
}

// Register the file behind a returned public avatar URL for cleanup.
function trackUrl(url) {
  if (typeof url === 'string' && url.startsWith(`${config.uploadsUrl}/`)) {
    artifacts.push(path.join(config.uploadsDir, url.slice(config.uploadsUrl.length + 1)));
  }
  return url;
}

function listUploads() {
  return new Set(readdirSync(config.uploadsDir));
}

function img(url, alt = 'x') {
  return `<p><img src="${url}" alt="${alt}"></p>`;
}

async function adminId() {
  const seeded = await seedAdminIfMissing();
  return seeded.id;
}

test('replacing an avatar deletes the unreferenced old file', async () => {
  const agent = await authedAgent();
  const id = await adminId();
  const old = makeUpload();
  setAvatar(id, old.url);
  assert.ok(existsSync(old.filePath));

  const res = await agent.post('/api/auth/avatar').attach('file', PNG_1X1, 'new.png');
  assert.equal(res.status, 200);
  trackUrl(res.body.avatar);
  assert.notEqual(res.body.avatar, old.url);

  assert.equal(existsSync(old.filePath), false, 'unreferenced old avatar should be deleted');
  // The newly assigned avatar file must survive the cleanup.
  const newPath = path.join(config.uploadsDir, res.body.avatar.slice(config.uploadsUrl.length + 1));
  assert.ok(existsSync(newPath), 'the new avatar must never be deleted');
});

test('replacing an avatar retains the old file when a post references it', async () => {
  const agent = await authedAgent();
  const id = await adminId();
  const old = makeUpload();
  setAvatar(id, old.url);
  createPost({ title: 'Avatar shared with post', content: img(old.url) }, { sub: id, role: 'admin' });

  const res = await agent.post('/api/auth/avatar').attach('file', PNG_1X1, 'new.png');
  assert.equal(res.status, 200);
  trackUrl(res.body.avatar);

  assert.ok(existsSync(old.filePath), 'a file still referenced by a post must be retained');
});

test('replacing an avatar retains the old file when another user uses it', async () => {
  const agent = await authedAgent();
  const id = await adminId();
  const shared = makeUpload();
  setAvatar(id, shared.url);
  const other = await createUser({
    username: `avataruser_${randomUUID().slice(0, 8)}`,
    password: 'sup3rsecret',
    role: 'author',
  });
  setAvatar(other.id, shared.url);

  const res = await agent.post('/api/auth/avatar').attach('file', PNG_1X1, 'new.png');
  assert.equal(res.status, 200);
  trackUrl(res.body.avatar);

  assert.ok(existsSync(shared.filePath), "a file used by another user's avatar must be retained");
});

test('replacing with the same URL never deletes the active avatar', async () => {
  const id = await adminId();
  const active = makeUpload();
  setAvatar(id, active.url);

  // Simulate the guarded path where the "previous" URL equals the live avatar.
  // Even without the `previousUrl !== url` guard, the committed avatar makes the
  // file referenced, so the shared reference check protects it either way.
  deleteUnreferencedUploads([active.url]);
  assert.ok(existsSync(active.filePath), 'the active avatar must never be deleted');
});

test('a missing old avatar file does not fail replacement', async () => {
  const agent = await authedAgent();
  const id = await adminId();
  const missingUrl = `${config.uploadsUrl}/${randomUUID()}.png`; // never written to disk
  setAvatar(id, missingUrl);

  const res = await agent.post('/api/auth/avatar').attach('file', PNG_1X1, 'new.png');
  assert.equal(res.status, 200, 'a missing old file counts as already cleaned');
  trackUrl(res.body.avatar);
});

test('a filesystem cleanup failure does not fail replacement', async () => {
  const agent = await authedAgent();
  const id = await adminId();
  // Point the old avatar URL at a path that is actually a directory. rmSync
  // without `recursive` throws on a directory, exercising the swallow-and-log
  // path while proving the replacement still succeeds.
  const name = `${randomUUID()}.png`;
  const dirAtFilePath = path.join(config.uploadsDir, name);
  mkdirSync(dirAtFilePath, { recursive: true });
  artifacts.push(dirAtFilePath);
  setAvatar(id, `${config.uploadsUrl}/${name}`);

  const res = await agent.post('/api/auth/avatar').attach('file', PNG_1X1, 'new.png');
  assert.equal(res.status, 200, 'replacement succeeds despite a cleanup failure');
  trackUrl(res.body.avatar);
  assert.ok(existsSync(dirAtFilePath), 'the failing target is left untouched');
});

test('external, malformed, query/fragment and traversal old-avatar URLs are ignored', async () => {
  const agent = await authedAgent();
  const id = await adminId();

  // A real file that a crafted traversal URL might try to reach; it must survive.
  const protectedFile = makeUpload();

  const oldUrls = [
    'https://cdn.example.com/remote.png', // external
    '//cdn.example.com/remote.png', // protocol-relative
    'data:image/png;base64,AAAA', // data URI
    `${config.uploadsUrl}/a.png?v=2`, // query string
    `${config.uploadsUrl}/a.png#frag`, // fragment
    `${config.uploadsUrl}/../../${protectedFile.name}`, // traversal toward a real file
    `${config.uploadsUrl}/`, // empty filename
  ];

  for (const oldUrl of oldUrls) {
    setAvatar(id, oldUrl);
    const res = await agent.post('/api/auth/avatar').attach('file', PNG_1X1, 'new.png');
    assert.equal(res.status, 200, `replacement should succeed for old avatar ${oldUrl}`);
    trackUrl(res.body.avatar);
  }

  assert.ok(existsSync(protectedFile.filePath), 'traversal must never reach a managed file');
});

test('a failed database update cleans the newly uploaded file best-effort', async () => {
  const agent = await authedAgent();
  const id = await adminId();
  setAvatar(id, null); // no previous avatar in play

  const db = getDb();
  // Force the avatar UPDATE to fail without corrupting the schema. A BEFORE
  // UPDATE trigger raising ABORT makes setAvatar throw while SELECTs still work.
  db.exec("CREATE TEMP TRIGGER fail_avatar_update BEFORE UPDATE ON admin BEGIN SELECT RAISE(ABORT, 'boom'); END;");
  const before = listUploads();
  try {
    const res = await agent.post('/api/auth/avatar').attach('file', PNG_1X1, 'new.png');
    // The route preserves its original error behavior: a thrown handler error is
    // forwarded to uploadErrorHandler, which surfaces a 400 (not a success).
    assert.equal(res.status, 400, 'a failed update preserves the original error behavior');
  } finally {
    db.exec('DROP TRIGGER fail_avatar_update');
  }

  const after = listUploads();
  const leftovers = [...after].filter((name) => !before.has(name));
  assert.deepEqual(leftovers, [], 'the orphaned new upload must be cleaned up');
});

test('a failed database update leaves the previous avatar untouched', async () => {
  const agent = await authedAgent();
  const id = await adminId();
  const prev = makeUpload();
  setAvatar(id, prev.url);

  const db = getDb();
  db.exec("CREATE TEMP TRIGGER fail_avatar_update BEFORE UPDATE ON admin BEGIN SELECT RAISE(ABORT, 'boom'); END;");
  try {
    const res = await agent.post('/api/auth/avatar').attach('file', PNG_1X1, 'new.png');
    assert.equal(res.status, 400);
  } finally {
    db.exec('DROP TRIGGER fail_avatar_update');
  }

  assert.ok(existsSync(prev.filePath), 'the previous avatar must not be deleted on a failed update');
  // The database value is likewise unchanged.
  assert.equal(getUserById(id).avatar, prev.url);
});

test('the avatar response exposes only the new public URL and no filesystem path', async () => {
  const agent = await authedAgent();
  const id = await adminId();
  setAvatar(id, null);

  const res = await agent.post('/api/auth/avatar').attach('file', PNG_1X1, 'new.png');
  assert.equal(res.status, 200);
  trackUrl(res.body.avatar);

  assert.deepEqual(Object.keys(res.body), ['avatar']);
  assert.match(res.body.avatar, /^\/uploads\/[^/]+$/);
  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes(config.uploadsDir), 'must not leak the absolute uploads dir');
  assert.ok(!/[A-Za-z]:\\/.test(serialized), 'must not leak a Windows filesystem path');
});
