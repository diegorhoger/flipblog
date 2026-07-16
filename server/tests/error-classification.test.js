import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { app, request, authedAgent } from './helpers.js';
import { getDb } from '../src/db.js';
import { config } from '../src/config.js';
import { createUser } from '../src/services/admin.js';

// A 1x1 PNG accepted by the upload fileFilter; the exact bytes are irrelevant.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAQDJ/PWeAAAAAElFTkSuQmCC',
  'base64'
);

// Serialize a response body and assert it never leaks internal implementation
// detail: SQL/exception text, stack frames, filesystem paths, or filenames.
function assertNoInternalLeak(res) {
  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes('boom'), 'must not leak the raw SQL/exception message');
  assert.ok(!/SQLITE|RAISE|ABORT/i.test(serialized), 'must not leak SQL internals');
  assert.ok(!serialized.includes(config.uploadsDir), 'must not leak the absolute uploads dir');
  assert.ok(!/[A-Za-z]:\\/.test(serialized), 'must not leak a Windows filesystem path');
  assert.ok(!serialized.includes('/src/'), 'must not leak a source path');
  assert.ok(!/\bat \w+/.test(serialized), 'must not leak a stack trace frame');
}

// --- Unexpected server/database failures → generic 500 ---

test('avatar DB failure returns a generic 500, not a 400, and leaks nothing', async () => {
  const agent = await authedAgent();
  const db = getDb();
  // Force the avatar UPDATE to fail while SELECTs still work. A raw handler error
  // like this used to fall through uploadErrorHandler and become a misleading 400
  // carrying the DB message; it must now be a generic 500.
  db.exec("CREATE TEMP TRIGGER fail_avatar_update BEFORE UPDATE ON admin BEGIN SELECT RAISE(ABORT, 'boom'); END;");
  try {
    const res = await agent.post('/api/auth/avatar').attach('file', PNG_1X1, 'pic.png');
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'internal_error');
    assertNoInternalLeak(res);
  } finally {
    db.exec('DROP TRIGGER fail_avatar_update');
  }
});

test('an unexpected route error surfaces as a generic 500 without leaking internals', async () => {
  // change-password does not use the upload pipeline, so this exercises the
  // central error handler directly (not uploadErrorHandler). A DB failure during
  // the password UPDATE must become a clean 500.
  const created = await createUser({
    username: `err_${randomUUID().slice(0, 8)}`,
    password: 'initialpw1',
    role: 'author',
  });
  const agent = request.agent(app);
  const login = await agent.post('/api/auth/login').send({ username: created.username, password: 'initialpw1' });
  assert.equal(login.status, 200);

  const db = getDb();
  db.exec("CREATE TEMP TRIGGER fail_pw_update BEFORE UPDATE ON admin BEGIN SELECT RAISE(ABORT, 'boom'); END;");
  try {
    const res = await agent
      .post('/api/auth/change-password')
      .send({ currentPassword: 'initialpw1', newPassword: 'brandnew99' });
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'internal_error');
    assertNoInternalLeak(res);
  } finally {
    db.exec('DROP TRIGGER fail_pw_update');
  }
});

// --- Request body-parsing failures are client errors, not 500s ---

test('malformed JSON is a 400 with a stable safe code and no leaked body/message', async () => {
  const badBody = '{"username": "abc", "oops"';
  const res = await request(app)
    .post('/api/auth/login')
    .set('Content-Type', 'application/json')
    .send(badBody);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_json');
  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes('oops'), 'must not echo the malformed request body');
  assert.ok(!/Unexpected|position|in JSON at/i.test(serialized), 'must not leak the parser message');
  assert.ok(!/\bat \w+/.test(serialized), 'must not leak a stack trace frame');
});

test('an oversized JSON body is a 413 with a stable safe code and no leaked content', async () => {
  const marker = 'OVERSIZE_MARKER';
  // express.json is capped at 2mb; exceed it with valid JSON to trip the limit.
  const huge = marker + 'x'.repeat(2 * 1024 * 1024 + 1024);
  const res = await request(app)
    .post('/api/auth/login')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify({ username: huge, password: 'x' }));
  assert.equal(res.status, 413);
  assert.equal(res.body.error, 'payload_too_large');
  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes(marker), 'must not echo the oversized request body');
  assert.ok(!/limit|entity|too large/i.test(serialized), 'must not leak the parser message');
});

// --- Upload validation failures keep their precise 4xx status ---

test('an unsupported file type is rejected with 415 (multer file rejection)', async () => {
  const agent = await authedAgent();
  const res = await agent.post('/api/auth/avatar').attach('file', Buffer.from('not an image'), 'doc.txt');
  assert.equal(res.status, 415);
  assert.equal(res.body.error, 'unsupported_file_type');
});

test('the generic upload route also rejects unsupported types with 415', async () => {
  const agent = await authedAgent();
  const res = await agent.post('/api/uploads').attach('file', Buffer.from('not an image'), 'doc.txt');
  assert.equal(res.status, 415);
  assert.equal(res.body.error, 'unsupported_file_type');
});

test('an oversized upload is rejected with 413', async () => {
  const agent = await authedAgent();
  // Exceed the configured limit; the type is valid so the size limit is what trips.
  const tooBig = Buffer.alloc(config.maxUploadBytes + 1024, 0x61);
  const res = await agent.post('/api/auth/avatar').attach('file', tooBig, 'big.png');
  assert.equal(res.status, 413);
  assert.equal(res.body.error, 'file_too_large');
});

test('a missing file is a 400 bad request, not a server error', async () => {
  const agent = await authedAgent();
  const res = await agent.post('/api/auth/avatar');
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'no_file');
});

// --- Authorization / authentication failures keep their precise status ---

test('unauthenticated avatar upload is rejected with 401', async () => {
  const res = await request(app).post('/api/auth/avatar').attach('file', PNG_1X1, 'pic.png');
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'unauthorized');
});

test('a non-admin author is forbidden from admin-only registration with 403', async () => {
  const author = await createUser({
    username: `authz_${randomUUID().slice(0, 8)}`,
    password: 'sup3rsecret',
    role: 'author',
  });
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ username: author.username, password: 'sup3rsecret' });
  const res = await agent
    .post('/api/auth/register')
    .send({ username: `x_${randomUUID().slice(0, 8)}`, password: 'sup3rsecret' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden');
});

test('a missing resource returns 404 with a stable code', async () => {
  const agent = await authedAgent();
  const res = await agent.put('/api/posts/99999999').send({ title: 'nope' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});
