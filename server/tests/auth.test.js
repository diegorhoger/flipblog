import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app, request, ADMIN, authedAgent } from './helpers.js';
import { createUser } from '../src/services/admin.js';

test('login fails with wrong password', async () => {
  const res = await request(app).post('/api/auth/login').send({ username: ADMIN.username, password: 'wrong' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'invalid_credentials');
});

test('GET /api/auth/me requires authentication', async () => {
  const res = await request(app).get('/api/auth/me');
  assert.equal(res.status, 401);
});

test('login, me, and logout flow', async () => {
  const agent = await authedAgent();
  const me = await agent.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.username, ADMIN.username);
  assert.equal(me.body.user.role, 'admin');

  const out = await agent.post('/api/auth/logout');
  assert.equal(out.status, 200);
  const after = await agent.get('/api/auth/me');
  assert.equal(after.status, 401);
});

test('protected post creation requires auth', async () => {
  const res = await request(app).post('/api/posts').send({ title: 'nope' });
  assert.equal(res.status, 401);
});

test('admin can register a new user, who can then log in', async () => {
  const agent = await authedAgent();
  const username = `invitee_${Date.now()}`;
  const register = await agent
    .post('/api/auth/register')
    .send({ username, password: 'sup3rsecret', role: 'author' });
  assert.equal(register.status, 201);
  assert.equal(register.body.user.username, username);
  assert.equal(register.body.user.role, 'author');

  const login = await request(app).post('/api/auth/login').send({ username, password: 'sup3rsecret' });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, 'author');
});

test('registration rejects a duplicate username', async () => {
  const agent = await authedAgent();
  const res = await agent
    .post('/api/auth/register')
    .send({ username: ADMIN.username, password: 'sup3rsecret' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'username_taken');
});

test('registration rejects weak passwords and invalid usernames', async () => {
  const agent = await authedAgent();
  const short = await agent.post('/api/auth/register').send({ username: 'newbie', password: 'short' });
  assert.equal(short.status, 400);
  assert.equal(short.body.error, 'validation_failed');

  const badUser = await agent
    .post('/api/auth/register')
    .send({ username: 'bad user!', password: 'sup3rsecret' });
  assert.equal(badUser.status, 400);
});

test('non-admin users cannot register new users', async () => {
  const agent = await authedAgent();
  const author = await createUser({ username: `author_${Date.now()}`, password: 'sup3rsecret', role: 'author' });

  const authorAgent = request.agent(app);
  const login = await authorAgent
    .post('/api/auth/login')
    .send({ username: author.username, password: 'sup3rsecret' });
  assert.equal(login.status, 200);

  const blocked = await authorAgent
    .post('/api/auth/register')
    .send({ username: `other_${Date.now()}`, password: 'sup3rsecret' });
  assert.equal(blocked.status, 403);
});

test('unauthenticated registration is rejected', async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ username: 'ghost', password: 'sup3rsecret' });
  assert.equal(res.status, 401);
});
