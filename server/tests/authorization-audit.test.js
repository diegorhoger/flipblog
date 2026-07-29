import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app, ADMIN } from './helpers.js';
import { seedUserIfMissing, createUser } from '../src/services/users.js';
import { createPost } from '../src/services/posts.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAQDJ/PWeAAAAAElFTkSuQmCC',
  'base64'
);

function tag(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

async function loginAgent(username, password) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`login failed for ${username}: ${res.status}`);
  return agent;
}

async function adminAgent() {
  return loginAgent(ADMIN.username, ADMIN.password);
}

let admin;
let author;
let authorActor;
let otherAuthorActor;
let subscriber;
let publishedByAuthor;
let publishedByOther;
let draftByAuthor;

before(async () => {
  await seedUserIfMissing();
  admin = await adminAgent();

  const u1 = await createUser({ username: tag('aa_author'), password: 'testpass1', role: 'author' });
  author = await loginAgent(u1.username, 'testpass1');
  authorActor = { sub: u1.id, role: 'author', username: u1.username };

  const u2 = await createUser({ username: tag('aa_other'), password: 'testpass1', role: 'author' });
  otherAuthorActor = { sub: u2.id, role: 'author', username: u2.username };

  const u3 = await createUser({ username: tag('aa_sub'), password: 'testpass1', role: 'subscriber' });
  subscriber = await loginAgent(u3.username, 'testpass1');

  publishedByAuthor = createPost({ title: 'AA Published', content: '<p>pub</p>', status: 'published' }, authorActor);
  publishedByOther = createPost({ title: 'AA Other Pub', content: '<p>other pub</p>', status: 'published' }, otherAuthorActor);
  draftByAuthor = createPost({ title: 'AA Draft', content: '<p>draft</p>', status: 'draft' }, authorActor);
});

// ===========================================================================
// GET /api/health — public
// ===========================================================================

describe('GET /api/health', () => {
  test('anonymous can access health endpoint', async () => {
    const res = await request(app).get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });

  test('health live endpoint is public', async () => {
    const res = await request(app).get('/api/health/live');
    assert.equal(res.status, 200);
  });

  test('health ready endpoint is public', async () => {
    const res = await request(app).get('/api/health/ready');
    assert.equal(res.status, 200);
  });
});

// ===========================================================================
// POST /api/auth/login — public
// ===========================================================================

describe('POST /api/auth/login', () => {
  test('wrong credentials return 401', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'nobody', password: 'wrong' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_credentials');
  });

  test('correct credentials return 200 with user', async () => {
    const res = await request(app).post('/api/auth/login').send(ADMIN);
    assert.equal(res.status, 200);
    assert.ok(res.body.user);
  });
});

// ===========================================================================
// POST /api/auth/logout — public
// ===========================================================================

describe('POST /api/auth/logout', () => {
  test('anonymous can logout', async () => {
    const res = await request(app).post('/api/auth/logout');
    assert.equal(res.status, 200);
  });
});

// ===========================================================================
// GET /api/auth/me — requires auth (any role)
// ===========================================================================

describe('GET /api/auth/me', () => {
  test('anonymous gets 401', async () => {
    const res = await request(app).get('/api/auth/me');
    assert.equal(res.status, 401);
  });

  test('admin can read own profile', async () => {
    const res = await admin.get('/api/auth/me');
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, 'admin');
  });

  test('author can read own profile', async () => {
    const res = await author.get('/api/auth/me');
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, 'author');
  });

  test('subscriber can read own profile', async () => {
    const res = await subscriber.get('/api/auth/me');
    assert.equal(res.status, 200);
  });

  test('response exposes only safe fields, never internal identifiers', async () => {
    const res = await admin.get('/api/auth/me');
    assert.equal(res.status, 200);
    const keys = Object.keys(res.body.user);
    assert.ok(keys.includes('username'));
    assert.ok(keys.includes('role'));
    assert.ok(keys.includes('created_at'));
    assert.ok(!keys.includes('id'));
    assert.ok(!keys.includes('password'));
    assert.ok(!keys.includes('password_hash'));
  });
});

// ===========================================================================
// POST /api/auth/avatar — requires auth (any role)
// ===========================================================================

describe('POST /api/auth/avatar', () => {
  test('anonymous gets 401', async () => {
    const res = await request(app).post('/api/auth/avatar').attach('file', PNG_1X1, 'pic.png');
    assert.equal(res.status, 401);
  });

  test('admin can upload avatar', async () => {
    const res = await admin.post('/api/auth/avatar').attach('file', PNG_1X1, 'pic.png');
    assert.equal(res.status, 200);
  });

  test('author can upload avatar', async () => {
    const res = await author.post('/api/auth/avatar').attach('file', PNG_1X1, 'pic.png');
    assert.equal(res.status, 200);
  });

  test('subscriber can upload avatar', async () => {
    const res = await subscriber.post('/api/auth/avatar').attach('file', PNG_1X1, 'pic.png');
    assert.equal(res.status, 200);
  });

  test('avatar response exposes only public URL, no filesystem paths', async () => {
    const res = await admin.post('/api/auth/avatar').attach('file', PNG_1X1, 'pic.png');
    assert.equal(res.status, 200);
    assert.match(res.body.avatar, /^\/uploads\//);
    assert.ok(!res.body.avatar.includes(':'));
    assert.ok(!res.body.avatar.includes('..'));
  });
});

// ===========================================================================
// POST /api/auth/change-password — requires auth (any role)
// ===========================================================================

describe('POST /api/auth/change-password', () => {
  test('anonymous gets 401', async () => {
    const res = await request(app).post('/api/auth/change-password').send({ currentPassword: 'x', newPassword: 'newpass123' });
    assert.equal(res.status, 401);
  });

  test('authenticated user can change own password', async () => {
    const u = await createUser({ username: tag('cp'), password: 'initialpw1', role: 'author' });
    const agent = await loginAgent(u.username, 'initialpw1');
    const res = await agent.post('/api/auth/change-password').send({ currentPassword: 'initialpw1', newPassword: 'brandnew99' });
    assert.equal(res.status, 200);
  });

  test('wrong current password returns 401', async () => {
    const u = await createUser({ username: tag('cp2'), password: 'initialpw1', role: 'author' });
    const agent = await loginAgent(u.username, 'initialpw1');
    const res = await agent.post('/api/auth/change-password').send({ currentPassword: 'wrongpw', newPassword: 'brandnew99' });
    assert.equal(res.status, 401);
  });
});

// ===========================================================================
// POST /api/auth/register — admin only
// ===========================================================================

describe('POST /api/auth/register', () => {
  test('anonymous gets 401', async () => {
    const res = await request(app).post('/api/auth/register').send({ username: 'ghost', password: 'testpass1' });
    assert.equal(res.status, 401);
  });

  test('author gets 403', async () => {
    const res = await author.post('/api/auth/register').send({ username: tag('blocked'), password: 'testpass1' });
    assert.equal(res.status, 403);
  });

  test('subscriber gets 403', async () => {
    const res = await subscriber.post('/api/auth/register').send({ username: tag('blocked'), password: 'testpass1' });
    assert.equal(res.status, 403);
  });

  test('admin can create new author', async () => {
    const res = await admin.post('/api/auth/register').send({ username: tag('new'), password: 'testpass1', role: 'author' });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.role, 'author');
  });

  test('admin can create new admin', async () => {
    const res = await admin.post('/api/auth/register').send({ username: tag('newadmin'), password: 'testpass1', role: 'admin' });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.role, 'admin');
  });

  test('registration response exposes no password fields', async () => {
    const res = await admin.post('/api/auth/register').send({ username: tag('safe'), password: 'testpass1', role: 'author' });
    assert.equal(res.status, 201);
    const keys = Object.keys(res.body.user);
    assert.ok(!keys.includes('password'));
    assert.ok(!keys.includes('password_hash'));
  });
});

// ===========================================================================
// GET /api/posts — public (optionalAuth)
// ===========================================================================

describe('GET /api/posts', () => {
  test('anonymous can list published posts', async () => {
    const res = await request(app).get('/api/posts');
    assert.equal(res.status, 200);
    assert.equal(Array.isArray(res.body.items), true);
  });

  test('author can list posts', async () => {
    const res = await author.get('/api/posts');
    assert.equal(res.status, 200);
  });

  test('admin can list posts', async () => {
    const res = await admin.get('/api/posts');
    assert.equal(res.status, 200);
  });

  test('public response never exposes owner_user_id or author_id', async () => {
    const res = await request(app).get('/api/posts');
    assert.equal(res.status, 200);
    for (const item of res.body.items) {
      assert.ok(!('owner_user_id' in item), 'public post list must not expose owner_user_id');
      assert.ok(!('author_id' in item), 'public post list must not expose author_id');
    }
  });
});

// ===========================================================================
// GET /api/posts/id/:id — requires auth; published readable by any auth user,
// drafts require ownership or admin
// ===========================================================================

describe('GET /api/posts/id/:id', () => {
  test('anonymous gets 401', async () => {
    const res = await request(app).get(`/api/posts/id/${publishedByAuthor.id}`);
    assert.equal(res.status, 401);
  });

  test('any authenticated user can read published post by id', async () => {
    const res = await subscriber.get(`/api/posts/id/${publishedByAuthor.id}`);
    assert.equal(res.status, 200);
  });

  test('owner can read own draft by id', async () => {
    const res = await author.get(`/api/posts/id/${draftByAuthor.id}`);
    assert.equal(res.status, 200);
  });

  test('non-owner cannot read draft by id', async () => {
    // subscriber is authenticated but not the owner or admin
    const res = await subscriber.get(`/api/posts/id/${draftByAuthor.id}`);
    assert.equal(res.status, 403);
  });

  test('other author cannot read draft by id', async () => {
    // We don't have a direct login for otherAuthorActor; use author to prove
    // that a different author gets 403
    const other = await loginAgent(
      (await createUser({ username: tag('other_rd'), password: 'testpass1', role: 'author' })).username,
      'testpass1'
    );
    const res = await other.get(`/api/posts/id/${draftByAuthor.id}`);
    assert.equal(res.status, 403);
  });

  test('admin can read draft by id', async () => {
    const res = await admin.get(`/api/posts/id/${draftByAuthor.id}`);
    assert.equal(res.status, 200);
  });

  test('response never exposes owner_user_id', async () => {
    const res = await admin.get(`/api/posts/id/${publishedByAuthor.id}`);
    assert.equal(res.status, 200);
    assert.ok(!('owner_user_id' in res.body));
    assert.ok(!('author_id' in res.body));
  });
});

// ===========================================================================
// GET /api/posts/:slug — public (optionalAuth)
// ===========================================================================

describe('GET /api/posts/:slug', () => {
  test('anonymous can read published post by slug', async () => {
    const res = await request(app).get(`/api/posts/${publishedByAuthor.slug}`);
    assert.equal(res.status, 200);
  });

  test('published slug returns 200 for authenticated users', async () => {
    const res = await author.get(`/api/posts/${publishedByAuthor.slug}`);
    assert.equal(res.status, 200);
  });

  test('anonymous gets 404 for draft slug', async () => {
    const res = await request(app).get(`/api/posts/${draftByAuthor.slug}`);
    assert.equal(res.status, 404);
  });

  test('non-owner gets 404 for draft slug', async () => {
    const res = await subscriber.get(`/api/posts/${draftByAuthor.slug}`);
    assert.equal(res.status, 404);
  });

  test('owner can read own draft by slug', async () => {
    const res = await author.get(`/api/posts/${draftByAuthor.slug}`);
    assert.equal(res.status, 200);
  });

  test('admin can read draft by slug', async () => {
    const res = await admin.get(`/api/posts/${draftByAuthor.slug}`);
    assert.equal(res.status, 200);
  });

  test('non-existent slug returns 404', async () => {
    const res = await request(app).get('/api/posts/non-existent-slug-xyz');
    assert.equal(res.status, 404);
  });

  test('public slug response never exposes owner_user_id', async () => {
    const res = await request(app).get(`/api/posts/${publishedByAuthor.slug}`);
    assert.equal(res.status, 200);
    assert.ok(!('owner_user_id' in res.body));
    assert.ok(!('author_id' in res.body));
  });
});

// ===========================================================================
// POST /api/posts — requires auth (any role)
// ===========================================================================

describe('POST /api/posts', () => {
  test('anonymous gets 401', async () => {
    const res = await request(app).post('/api/posts').send({ title: 'hack', content: '<p>evil</p>' });
    assert.equal(res.status, 401);
  });

  test('author can create post', async () => {
    const res = await author.post('/api/posts').send({ title: tag('post'), content: '<p>test</p>' });
    assert.equal(res.status, 201);
  });

  test('admin can create post', async () => {
    const res = await admin.post('/api/posts').send({ title: tag('post'), content: '<p>test</p>' });
    assert.equal(res.status, 201);
  });

  test('subscriber can create post', async () => {
    const res = await subscriber.post('/api/posts').send({ title: tag('post'), content: '<p>test</p>' });
    assert.equal(res.status, 201);
  });
});

// ===========================================================================
// PUT /api/posts/:id — requires auth + ownership/admin
// ===========================================================================

describe('PUT /api/posts/:id', () => {
  test('anonymous gets 401', async () => {
    const res = await request(app).put(`/api/posts/${publishedByAuthor.id}`).send({ title: 'hack' });
    assert.equal(res.status, 401);
  });

  test('owner can update own post', async () => {
    const res = await author.put(`/api/posts/${publishedByAuthor.id}`).send({ title: 'Updated By Owner' });
    assert.equal(res.status, 200);
    assert.equal(res.body.title, 'Updated By Owner');
  });

  test('other authenticated user gets 403', async () => {
    const res = await subscriber.put(`/api/posts/${publishedByAuthor.id}`).send({ title: 'hack' });
    assert.equal(res.status, 403);
  });

  test('admin can update any post', async () => {
    const res = await admin.put(`/api/posts/${publishedByAuthor.id}`).send({ title: 'Updated By Admin' });
    assert.equal(res.status, 200);
    assert.equal(res.body.title, 'Updated By Admin');
  });

  test('missing post returns 404', async () => {
    const res = await admin.put('/api/posts/99999999').send({ title: 'ghost' });
    assert.equal(res.status, 404);
  });
});

// ===========================================================================
// DELETE /api/posts/:id — requires auth + ownership/admin
// ===========================================================================

describe('DELETE /api/posts/:id', () => {
  let ownedByAuthor;
  let ownedByOther;

  before(() => {
    ownedByAuthor = createPost({ title: 'AA Del Owned', content: '<p>del</p>', status: 'published' }, authorActor);
    ownedByOther = createPost({ title: 'AA Del Other', content: '<p>del other</p>', status: 'published' }, otherAuthorActor);
  });

  test('anonymous gets 401', async () => {
    const res = await request(app).delete(`/api/posts/${ownedByAuthor.id}`);
    assert.equal(res.status, 401);
  });

  test('owner can delete own post', async () => {
    const p = createPost({ title: 'AA Self Del', content: '<p>self del</p>', status: 'published' }, authorActor);
    const res = await author.delete(`/api/posts/${p.id}`);
    assert.equal(res.status, 204);
  });

  test('other authenticated user gets 403', async () => {
    const res = await subscriber.delete(`/api/posts/${ownedByAuthor.id}`);
    assert.equal(res.status, 403);
  });

  test('other author gets 403', async () => {
    const other = await loginAgent(
      (await createUser({ username: tag('other_del'), password: 'testpass1', role: 'author' })).username,
      'testpass1'
    );
    const res = await other.delete(`/api/posts/${ownedByAuthor.id}`);
    assert.equal(res.status, 403);
  });

  test('admin can delete any post', async () => {
    const res = await admin.delete(`/api/posts/${ownedByOther.id}`);
    assert.equal(res.status, 204);
  });

  test('missing post returns 404', async () => {
    const res = await admin.delete('/api/posts/99999999');
    assert.equal(res.status, 404);
  });
});

// ===========================================================================
// POST /api/uploads — requires auth (any role)
// ===========================================================================

describe('POST /api/uploads', () => {
  test('anonymous gets 401', async () => {
    const res = await request(app).post('/api/uploads').attach('file', PNG_1X1, 'pic.png');
    assert.equal(res.status, 401);
  });

  test('admin can upload', async () => {
    const res = await admin.post('/api/uploads').attach('file', PNG_1X1, 'pic.png');
    assert.equal(res.status, 201);
    assert.ok(res.body.url);
  });

  test('author can upload', async () => {
    const res = await author.post('/api/uploads').attach('file', PNG_1X1, 'pic.png');
    assert.equal(res.status, 201);
  });

  test('subscriber can upload', async () => {
    const res = await subscriber.post('/api/uploads').attach('file', PNG_1X1, 'pic.png');
    assert.equal(res.status, 201);
  });
});

// ===========================================================================
// GET /api/audit/alt-text — requires auth + admin/author role
// ===========================================================================

describe('GET /api/audit/alt-text', () => {
  test('anonymous gets 401', async () => {
    const res = await request(app).get('/api/audit/alt-text');
    assert.equal(res.status, 401);
  });

  test('admin can run audit', async () => {
    const res = await admin.get('/api/audit/alt-text');
    assert.equal(res.status, 200);
  });

  test('author can run audit', async () => {
    const res = await author.get('/api/audit/alt-text');
    assert.equal(res.status, 200);
  });

  test('subscriber gets 403', async () => {
    const res = await subscriber.get('/api/audit/alt-text');
    assert.equal(res.status, 403);
  });
});

// ===========================================================================
// IDOR — cross-user resource access
// ===========================================================================

describe('IDOR protection', () => {
  test('author cannot update another author published post', async () => {
    const res = await author.put(`/api/posts/${publishedByOther.id}`).send({ title: 'Hacked' });
    assert.equal(res.status, 403);
  });

  test('author cannot delete another author published post', async () => {
    const res = await author.delete(`/api/posts/${publishedByOther.id}`);
    assert.equal(res.status, 403);
  });

  test('author cannot read another author draft by id', async () => {
    const other = await loginAgent(
      (await createUser({ username: tag('idor_draft'), password: 'testpass1', role: 'author' })).username,
      'testpass1'
    );
    const res = await other.get(`/api/posts/id/${draftByAuthor.id}`);
    assert.equal(res.status, 403);
  });
});
