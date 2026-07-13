import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app, request, authedAgent } from './helpers.js';

test('list is empty initially and paginates', async () => {
  const res = await request(app).get('/api/posts');
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 0);
  assert.equal(Array.isArray(res.body.items), true);
});

test('create -> get -> update -> delete lifecycle', async () => {
  const agent = await authedAgent();

  const created = await agent.post('/api/posts').send({
    title: 'Meu Primeiro Post',
    author: 'Tester',
    content: '<h2>Intro</h2><p>hello</p><hr data-page-break><h2>Capitulo</h2><p>world</p>',
    status: 'published',
  });
  assert.equal(created.status, 201);
  assert.ok(created.body.slug);
  assert.equal(created.body.pageCount, 2);
  assert.equal(created.body.pages.length, 2);

  const slug = created.body.slug;
  const fetched = await request(app).get(`/api/posts/${slug}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.pages.length, 2);
  assert.equal(fetched.body.pages[0].title, 'Intro');

  const updated = await agent.put(`/api/posts/${created.body.id}`).send({ title: 'Renomeado' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.title, 'Renomeado');
  assert.equal(updated.body.slug, slug); // slug is preserved when not explicitly changed

  const resluggled = await agent.put(`/api/posts/${created.body.id}`).send({ title: 'Renomeado', slug: 'novo-slug' });
  assert.equal(resluggled.status, 200);
  assert.equal(resluggled.body.slug, 'novo-slug');

  const del = await agent.delete(`/api/posts/${created.body.id}`);
  assert.equal(del.status, 204);
  const gone = await request(app).get(`/api/posts/${updated.body.slug}`);
  assert.equal(gone.status, 404);
});

test('validation rejects missing title', async () => {
  const agent = await authedAgent();
  const res = await agent.post('/api/posts').send({ content: '<p>x</p>' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'validation_failed');
});

test('drafts are excluded from published list but visible with status=all', async () => {
  const agent = await authedAgent();
  await agent.post('/api/posts').send({ title: 'Rascunho', status: 'draft', content: '<p>draft</p>' });

  const published = await request(app).get('/api/posts?status=published');
  assert.equal(published.body.total, 0);

  const all = await request(app).get('/api/posts?status=all');
  assert.equal(all.body.total, 1);
  assert.equal(all.body.items[0].status, 'draft');
});

test('malicious HTML in content is sanitized', async () => {
  const agent = await authedAgent();
  const res = await agent.post('/api/posts').send({
    title: 'XSS',
    content: '<p>ok</p><script>alert(1)</script><img src=x onerror=alert(1)>',
  });
  assert.equal(res.status, 201);
  assert.doesNotMatch(res.body.content, /<script>/i);
  assert.doesNotMatch(res.body.content, /onerror/i);
});

test('updating a missing post returns 404', async () => {
  const agent = await authedAgent();
  const res = await agent.put('/api/posts/999999').send({ title: 'x' });
  assert.equal(res.status, 404);
});

test('ownership: a non-owner author cannot edit another author’s post', async () => {
  const admin = await authedAgent();
  // Register a second author via the admin-only endpoint.
  const reg = await admin
    .post('/api/auth/register')
    .send({ username: 'author2', password: 'password2', role: 'author' });
  assert.equal(reg.status, 201);

  const owner = await authedAgent();
  const created = await owner
    .post('/api/posts')
    .send({ title: 'Dono', content: '<p>intro</p>' });
  assert.equal(created.status, 201);
  const id = created.body.id;

  // Log in as author2.
  const intruder = request.agent(app);
  const login = await intruder.post('/api/auth/login').send({ username: 'author2', password: 'password2' });
  assert.equal(login.status, 200);

  const forbidden = await intruder.put(`/api/posts/${id}`).send({ title: 'Hack' });
  assert.equal(forbidden.status, 403);

  // The owner can still edit their own post.
  const ok = await owner.put(`/api/posts/${id}`).send({ title: 'Renomeado pelo dono' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.title, 'Renomeado pelo dono');

  // An admin can edit any post.
  const adminEdit = await admin.put(`/api/posts/${id}`).send({ title: 'Pelo admin' });
  assert.equal(adminEdit.status, 200);
  assert.equal(adminEdit.body.title, 'Pelo admin');
});

test('ownership: a non-owner author cannot delete another author’s post', async () => {
  const admin = await authedAgent();
  const reg = await admin
    .post('/api/auth/register')
    .send({ username: 'author3', password: 'password3', role: 'author' });
  assert.equal(reg.status, 201);

  const owner = await authedAgent();
  const created = await owner.post('/api/posts').send({ title: 'Alvo', content: '<p>x</p>' });
  const id = created.body.id;

  const intruder = request.agent(app);
  await intruder.post('/api/auth/login').send({ username: 'author3', password: 'password3' });

  const forbidden = await intruder.delete(`/api/posts/${id}`);
  assert.equal(forbidden.status, 403);

  const ownerDelete = await owner.delete(`/api/posts/${id}`);
  assert.equal(ownerDelete.status, 204);
});
