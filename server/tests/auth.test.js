import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app, request, ADMIN, authedAgent } from './helpers.js';
import { createUser } from '../src/services/users.js';

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

test('me returns username, role and created_at', async () => {
  const agent = await authedAgent();
  const me = await agent.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.username, ADMIN.username);
  assert.equal(me.body.user.role, 'admin');
  assert.ok(me.body.user.created_at);
});

test('user can change their own password', async () => {
  const created = await createUser({ username: `pw_${Date.now()}`, password: 'initialpw1', role: 'author' });
  const agent = request.agent(app);
  const login = await agent.post('/api/auth/login').send({ username: created.username, password: 'initialpw1' });
  assert.equal(login.status, 200);

  const change = await agent
    .post('/api/auth/change-password')
    .send({ currentPassword: 'initialpw1', newPassword: 'brandnew99' });
  assert.equal(change.status, 200);

  const oldLogin = await request(app)
    .post('/api/auth/login')
    .send({ username: created.username, password: 'initialpw1' });
  assert.equal(oldLogin.status, 401);

  const newLogin = await request(app)
    .post('/api/auth/login')
    .send({ username: created.username, password: 'brandnew99' });
  assert.equal(newLogin.status, 200);
});

test('change-password rejects a wrong current password', async () => {
  const created = await createUser({ username: `pw2_${Date.now()}`, password: 'initialpw1', role: 'author' });
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ username: created.username, password: 'initialpw1' });
  const change = await agent
    .post('/api/auth/change-password')
    .send({ currentPassword: 'wrongpw', newPassword: 'brandnew99' });
  assert.equal(change.status, 401);
});

test('change-password rejects a weak new password', async () => {
  const created = await createUser({ username: `pw3_${Date.now()}`, password: 'initialpw1', role: 'author' });
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ username: created.username, password: 'initialpw1' });
  const change = await agent
    .post('/api/auth/change-password')
    .send({ currentPassword: 'initialpw1', newPassword: 'short' });
  assert.equal(change.status, 400);
});

test('change-password requires authentication', async () => {
  const res = await request(app)
    .post('/api/auth/change-password')
    .send({ currentPassword: 'x', newPassword: 'brandnew99' });
  assert.equal(res.status, 401);
});

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAQDJ/PWeAAAAAElFTkSuQmCC',
  'base64'
);

test('authenticated user can upload a profile picture', async () => {
  const agent = await authedAgent();
  const res = await agent.post('/api/auth/avatar').attach('file', PNG_1X1, 'pic.png');
  assert.equal(res.status, 200);
  assert.match(res.body.avatar, /^\/uploads\/.+/);
  const me = await agent.get('/api/auth/me');
  assert.equal(me.body.user.avatar, res.body.avatar);
});

test('avatar upload rejects unsupported file types', async () => {
  const agent = await authedAgent();
  const res = await agent.post('/api/auth/avatar').attach('file', Buffer.from('hello'), 'doc.txt');
  assert.equal(res.status, 415);
});

test('avatar upload requires authentication', async () => {
  const res = await request(app).post('/api/auth/avatar').attach('file', PNG_1X1, 'pic.png');
  assert.equal(res.status, 401);
});
