import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app, ADMIN } from './helpers.js';
import { seedUserIfMissing, createUser } from '../src/services/users.js';
import { createPost } from '../src/services/posts.js';
import { signJwt } from '../src/auth/jwt.js';
import { config } from '../src/config.js';

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

function cookieFor(payload) {
  const token = signJwt(payload, config.appSecret, 3600);
  return `fb_session=${token}`;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let admin;
let author;
let authorActor;
let otherAuthor;
let otherAuthorActor;
let unsupportedRole;
let unsupportedRoleActor;
let publishedByAuthor;
let publishedByOther;
let draftByAuthor;

before(async () => {
  await seedUserIfMissing();
  admin = await loginAgent(ADMIN.username, ADMIN.password);

  const u1 = await createUser({ username: tag('aa_author'), password: 'testpass1', role: 'author' });
  author = await loginAgent(u1.username, 'testpass1');
  authorActor = { sub: u1.id, role: 'author', username: u1.username };

  const u2 = await createUser({ username: tag('aa_other'), password: 'testpass1', role: 'author' });
  otherAuthor = await loginAgent(u2.username, 'testpass1');
  otherAuthorActor = { sub: u2.id, role: 'author', username: u2.username };

  const u3 = await createUser({ username: tag('aa_unsup'), password: 'testpass1', role: 'subscriber' });
  unsupportedRole = await loginAgent(u3.username, 'testpass1');
  unsupportedRoleActor = { sub: u3.id, role: 'subscriber', username: u3.username };

  publishedByAuthor = createPost({ title: 'AA Published Author', content: '<p>pub</p>', status: 'published' }, authorActor);
  publishedByOther = createPost({ title: 'AA Published Other', content: '<p>other pub</p>', status: 'published' }, otherAuthorActor);
  draftByAuthor = createPost({ title: 'AA Draft Author', content: '<p>draft</p>', status: 'draft' }, authorActor);
});

// ===========================================================================
// Supported roles: admin, author. Any other role (e.g. subscriber) is
// unsupported/adversarial. Unsupported roles may authenticate (login, /me,
// avatar, change-password, logout) but are denied all authoring operations
// (create/edit/delete posts, uploads, audit) with 403.
// ===========================================================================

// ===========================================================================
// GET /api/health, /api/health/live, /api/health/ready — public
// ===========================================================================

describe('GET /api/health', () => {
  test('anonymous can access health', async () => {
    const res = await request(app).get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });

  test('anonymous can access health/live', async () => {
    const res = await request(app).get('/api/health/live');
    assert.equal(res.status, 200);
  });

  test('anonymous can access health/ready', async () => {
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

  test('correct credentials return 200', async () => {
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
// GET /api/auth/me — requires auth (any role, including unsupported)
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

  test('unsupported role can read own profile', async () => {
    const res = await unsupportedRole.get('/api/auth/me');
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, 'subscriber');
  });

  test('response exposes only safe fields', async () => {
    const res = await admin.get('/api/auth/me');
    assert.equal(res.status, 200);
    assert.ok(!('id' in res.body.user));
    assert.ok(!('password' in res.body.user));
    assert.ok(!('password_hash' in res.body.user));
  });
});

// ===========================================================================
// POST /api/auth/avatar — requires auth (any role, including unsupported)
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

  test('unsupported role can upload avatar', async () => {
    const res = await unsupportedRole.post('/api/auth/avatar').attach('file', PNG_1X1, 'pic.png');
    assert.equal(res.status, 200);
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

  test('author can change own password', async () => {
    const u = await createUser({ username: tag('cp'), password: 'initialpw1', role: 'author' });
    const agent = await loginAgent(u.username, 'initialpw1');
    const res = await agent.post('/api/auth/change-password').send({ currentPassword: 'initialpw1', newPassword: 'brandnew99' });
    assert.equal(res.status, 200);
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

  test('unsupported role gets 403', async () => {
    const res = await unsupportedRole.post('/api/auth/register').send({ username: tag('blocked'), password: 'testpass1' });
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
    assert.ok(!('password' in res.body.user));
    assert.ok(!('password_hash' in res.body.user));
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
      assert.ok(!('owner_user_id' in item));
      assert.ok(!('author_id' in item));
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
    const res = await unsupportedRole.get(`/api/posts/id/${publishedByAuthor.id}`);
    assert.equal(res.status, 200);
  });

  test('owner can read own draft by id', async () => {
    const res = await author.get(`/api/posts/id/${draftByAuthor.id}`);
    assert.equal(res.status, 200);
  });

  test('non-owner cannot read draft by id (returns 403)', async () => {
    const res = await unsupportedRole.get(`/api/posts/id/${draftByAuthor.id}`);
    assert.equal(res.status, 403);
  });

  test('other author cannot read draft by id', async () => {
    const res = await otherAuthor.get(`/api/posts/id/${draftByAuthor.id}`);
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

  test('anonymous gets 404 for draft slug', async () => {
    const res = await request(app).get(`/api/posts/${draftByAuthor.slug}`);
    assert.equal(res.status, 404);
  });

  test('non-owner gets 404 for draft slug', async () => {
    const res = await unsupportedRole.get(`/api/posts/${draftByAuthor.slug}`);
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
// POST /api/posts — requires auth + admin/author role
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

  test('unsupported role gets 403', async () => {
    const res = await unsupportedRole.post('/api/posts').send({ title: tag('post'), content: '<p>test</p>' });
    assert.equal(res.status, 403);
  });
});

// ===========================================================================
// PUT /api/posts/:id — requires auth + admin/author role + ownership
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

  test('unsupported role gets 403', async () => {
    const res = await unsupportedRole.put(`/api/posts/${publishedByAuthor.id}`).send({ title: 'hack' });
    assert.equal(res.status, 403);
  });

  test('other author gets 403', async () => {
    const res = await otherAuthor.put(`/api/posts/${publishedByAuthor.id}`).send({ title: 'hack' });
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
// DELETE /api/posts/:id — requires auth + admin/author role + ownership
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

  test('unsupported role gets 403', async () => {
    const res = await unsupportedRole.delete(`/api/posts/${ownedByAuthor.id}`);
    assert.equal(res.status, 403);
  });

  test('other author gets 403', async () => {
    const res = await otherAuthor.delete(`/api/posts/${ownedByAuthor.id}`);
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
// POST /api/uploads — requires auth + admin/author role
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

  test('unsupported role gets 403', async () => {
    const res = await unsupportedRole.post('/api/uploads').attach('file', PNG_1X1, 'pic.png');
    assert.equal(res.status, 403);
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

  test('unsupported role gets 403', async () => {
    const res = await unsupportedRole.get('/api/audit/alt-text');
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
    const res = await otherAuthor.get(`/api/posts/id/${draftByAuthor.id}`);
    assert.equal(res.status, 403);
  });

  test('author cannot update another author draft', async () => {
    const res = await otherAuthor.put(`/api/posts/${draftByAuthor.id}`).send({ title: 'Hacked' });
    assert.equal(res.status, 403);
  });
});

// ===========================================================================
// Invalid/unsafe session handling
// All invalid sessions must fail closed (401 or 403) without producing 500.
// ===========================================================================

describe('invalid session handling', () => {
  const protectedRoute = (agent) =>
    agent.get(`/api/posts/id/${publishedByAuthor.id}`);

  test('malformed cookie token returns 401', async () => {
    const agent = request.agent(app);
    agent.jar.setCookie('fb_session=not-a-valid-jwt');
    const res = await protectedRoute(agent);
    assert.equal(res.status, 401);
  });

  test('tampered JWT signature returns 401', async () => {
    const token = signJwt({ username: 'admin', sub: 1, role: 'admin' }, 'wrong-secret', 3600);
    const agent = request.agent(app);
    agent.jar.setCookie(`fb_session=${token}`);
    const res = await protectedRoute(agent);
    assert.equal(res.status, 401);
  });

  test('expired JWT returns 401', async () => {
    const token = signJwt({ username: 'admin', sub: 1, role: 'admin' }, config.appSecret, -1);
    const agent = request.agent(app);
    agent.jar.setCookie(`fb_session=${token}`);
    const res = await protectedRoute(agent);
    assert.equal(res.status, 401);
  });

  test('token with unsupported role is denied on privileged routes', async () => {
    const agent = request.agent(app);
    agent.jar.setCookie(cookieFor({ username: 'badactor', sub: 9999, role: 'hacker' }));
    const res = await agent.post('/api/posts').send({ title: 'hack', content: '<p>test</p>' });
    assert.equal(res.status, 403);
  });

  test('token with unsupported role is denied on uploads', async () => {
    const agent = request.agent(app);
    agent.jar.setCookie(cookieFor({ username: 'badactor', sub: 9999, role: 'hacker' }));
    const res = await agent.post('/api/uploads').attach('file', PNG_1X1, 'pic.png');
    assert.equal(res.status, 403);
  });

  test('token with unsupported role is denied on audit', async () => {
    const agent = request.agent(app);
    agent.jar.setCookie(cookieFor({ username: 'badactor', sub: 9999, role: 'hacker' }));
    const res = await agent.get('/api/audit/alt-text');
    assert.equal(res.status, 403);
  });

  test('optional-auth public routes remain usable with no token', async () => {
    const res = await request(app).get('/api/posts');
    assert.equal(res.status, 200);
    const res2 = await request(app).get(`/api/posts/${publishedByAuthor.slug}`);
    assert.equal(res2.status, 200);
  });

  test('optional-auth with invalid token still works (token ignored)', async () => {
    const agent = request.agent(app);
    agent.jar.setCookie('fb_session=invalid-token');
    const res = await agent.get('/api/posts');
    assert.equal(res.status, 200);
  });

  test('invalid sessions never produce 500', async () => {
    // Run several invalid-token scenarios and verify none return 500.
    const scenarios = [
      { cookie: 'fb_session=bad', name: 'malformed' },
      { cookie: `fb_session=${signJwt({}, 'bad-secret', 3600)}`, name: 'tampered' },
      { cookie: `fb_session=${signJwt({}, config.appSecret, -1)}`, name: 'expired' },
    ];
    for (const { cookie } of scenarios) {
      for (const path of ['/api/auth/me', `/api/posts/id/${publishedByAuthor.id}`, '/api/uploads', '/api/audit/alt-text']) {
        const agent = request.agent(app);
        agent.jar.setCookie(cookie);
        const req = path === '/api/uploads' ? agent.post(path).attach('file', PNG_1X1, 'pic.png') : agent.get(path);
        const res = await req;
        assert.ok(res.status !== 500, `${path} must not return 500 for invalid token`);
      }
    }
  });
});
