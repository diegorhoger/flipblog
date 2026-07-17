import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app, request, authedAgent } from './helpers.js';
import { getDb } from '../src/db.js';
import { createUser, seedUserIfMissing } from '../src/services/users.js';
import { createPost } from '../src/services/posts.js';
import {
  auditPostContent,
  classifyImage,
  isPlaceholderAlt,
  FINDING_TYPES,
  AUDIT_LEGEND,
} from '../src/services/altAudit.js';

function resetPosts() {
  getDb().exec('DELETE FROM posts');
}

// Seed the real admin up front. Some tests below create additional users (e.g. a
// non-manager role) directly; without an admin already present, a later
// seedUserIfMissing() would see a non-empty admin table and skip creating the
// canonical admin, breaking authedAgent() logins.
await seedUserIfMissing();

// --- Pure classifier / parser unit tests ------------------------------------

test('detects a missing alt attribute (alt reported as null)', () => {
  const findings = auditPostContent('<p><img src="/uploads/a.png"></p>');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, FINDING_TYPES.MISSING);
  assert.equal(findings[0].alt, null);
  assert.equal(findings[0].src, '/uploads/a.png');
});

test('detects an empty alt=""', () => {
  const findings = auditPostContent('<p><img src="/uploads/a.png" alt=""></p>');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, FINDING_TYPES.EMPTY);
  assert.equal(findings[0].alt, '');
});

test('whitespace-only alt is treated as empty', () => {
  const findings = auditPostContent('<p><img src="/x.png" alt="   "></p>');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, FINDING_TYPES.EMPTY);
});

test('detects placeholder alt values', () => {
  for (const alt of ['image', 'img', 'photo', 'picture', 'image1', 'foto 2', 'imagem', 'IMG_3']) {
    const findings = auditPostContent(`<p><img src="/x.png" alt="${alt}"></p>`);
    assert.equal(findings.length, 1, `expected finding for "${alt}"`);
    assert.equal(findings[0].type, FINDING_TYPES.PLACEHOLDER, `"${alt}" should be a placeholder`);
  }
});

test('detects filename-only alt text as a placeholder', () => {
  const findings = auditPostContent('<p><img src="/uploads/xyz.png" alt="IMG_1234.JPG"></p>');
  assert.equal(findings[0].type, FINDING_TYPES.PLACEHOLDER);
});

test('detects alt equal to the image filename as a placeholder', () => {
  // alt matches the src basename (without extension).
  assert.equal(isPlaceholderAlt('sunset-photo', '/uploads/sunset-photo.png'), true);
  assert.equal(isPlaceholderAlt('sunset-photo.png', '/uploads/sunset-photo.png'), true);
});

test('meaningful alt text is ignored (no finding)', () => {
  const findings = auditPostContent(
    '<p><img src="/uploads/a.png" alt="A red bicycle leaning against a brick wall"></p>'
  );
  assert.deepEqual(findings, []);
});

test('classifyImage distinguishes missing from empty', () => {
  assert.equal(classifyImage(false, null, '/x.png'), FINDING_TYPES.MISSING);
  assert.equal(classifyImage(true, '', '/x.png'), FINDING_TYPES.EMPTY);
  assert.equal(classifyImage(true, 'image', '/x.png'), FINDING_TYPES.PLACEHOLDER);
  assert.equal(classifyImage(true, 'A descriptive caption', '/x.png'), null);
});

test('reports multiple images in one post, in document order', () => {
  const html =
    '<p><img src="/1.png"></p>' +
    '<p><img src="/2.png" alt=""></p>' +
    '<p><img src="/3.png" alt="photo"></p>' +
    '<p><img src="/4.png" alt="A good description of the scene"></p>';
  const findings = auditPostContent(html);
  assert.equal(findings.length, 3); // the meaningful one is excluded
  assert.deepEqual(
    findings.map((f) => f.type),
    [FINDING_TYPES.MISSING, FINDING_TYPES.EMPTY, FINDING_TYPES.PLACEHOLDER]
  );
  assert.deepEqual(
    findings.map((f) => f.src),
    ['/1.png', '/2.png', '/3.png']
  );
});

test('reports external and local image URLs safely (src preserved, no fs path)', () => {
  const html =
    '<p><img src="https://cdn.example.com/remote.jpg"></p>' +
    '<p><img src="/uploads/local.png"></p>';
  const findings = auditPostContent(html);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].src, 'https://cdn.example.com/remote.jpg');
  assert.equal(findings[1].src, '/uploads/local.png');
  // No absolute filesystem path anywhere in the serialized findings.
  const serialized = JSON.stringify(findings);
  assert.ok(!/[A-Za-z]:\\/.test(serialized), 'must not contain a Windows filesystem path');
});

test('empty / non-image content yields no findings', () => {
  assert.deepEqual(auditPostContent(''), []);
  assert.deepEqual(auditPostContent('<p>no images here</p>'), []);
  assert.deepEqual(auditPostContent(null), []);
});

test('the decorative-empty explanation is present in the legend', () => {
  const detail = AUDIT_LEGEND[FINDING_TYPES.EMPTY].detail.toLowerCase();
  assert.match(detail, /decorativ/);
});

// --- Endpoint: authorization -----------------------------------------------

test('unauthenticated request is rejected with 401', async () => {
  const res = await request(app).get('/api/audit/alt-text');
  assert.equal(res.status, 401);
});

test('a role that cannot manage posts is rejected with 403', async () => {
  // Create a user with a role outside the manage-posts set and log in.
  const username = `subscriber_${Date.now()}`;
  await createUser({ username, password: 'sup3rsecret', role: 'subscriber' });
  const agent = request.agent(app);
  const login = await agent.post('/api/auth/login').send({ username, password: 'sup3rsecret' });
  assert.equal(login.status, 200);

  const res = await agent.get('/api/audit/alt-text');
  assert.equal(res.status, 403);
});

// --- Endpoint: findings, ownership, pagination ------------------------------

test('admin sees findings for all posts', async () => {
  resetPosts();
  const admin = await authedAgent();

  // Register an author and create a post owned by them.
  const author = await createUser({
    username: `auditauthor_${Date.now()}`,
    password: 'sup3rsecret',
    role: 'author',
  });
  createPost(
    { title: 'Author post', content: '<p><img src="/uploads/author.png"></p>' },
    { sub: author.id, role: 'author' }
  );
  // And a post owned by the admin.
  await admin
    .post('/api/posts')
    .send({ title: 'Admin post', content: '<p><img src="/uploads/admin.png" alt="image"></p>' });

  const res = await admin.get('/api/audit/alt-text');
  assert.equal(res.status, 200);
  assert.equal(res.body.totalPosts, 2, 'admin should see both posts');
  const titles = res.body.items.map((i) => i.title).sort();
  assert.deepEqual(titles, ['Admin post', 'Author post']);
});

test('an author sees findings only for their own posts', async () => {
  resetPosts();
  const admin = await authedAgent();

  // A post owned by the admin (should NOT be visible to the author).
  await admin
    .post('/api/posts')
    .send({ title: 'Admin owned', content: '<p><img src="/uploads/admin.png"></p>' });

  // Register + log in as the author, then create their own post.
  const username = `owner_${Date.now()}`;
  await createUser({ username, password: 'sup3rsecret', role: 'author' });
  const authorAgent = request.agent(app);
  await authorAgent.post('/api/auth/login').send({ username, password: 'sup3rsecret' });
  await authorAgent
    .post('/api/posts')
    .send({ title: 'Author owned', content: '<p><img src="/uploads/mine.png"></p>' });

  const res = await authorAgent.get('/api/audit/alt-text');
  assert.equal(res.status, 200);
  assert.equal(res.body.totalPosts, 1, 'author should see only their own post');
  assert.equal(res.body.items[0].title, 'Author owned');
});

test('pagination bounds the number of posts per page', async () => {
  resetPosts();
  const admin = await authedAgent();
  // Create 3 posts that each have a finding.
  for (let i = 0; i < 3; i++) {
    await admin
      .post('/api/posts')
      .send({ title: `Post ${i}`, content: `<p><img src="/uploads/p${i}.png"></p>` });
  }

  const page1 = await admin.get('/api/audit/alt-text?page=1&limit=2');
  assert.equal(page1.status, 200);
  assert.equal(page1.body.limit, 2);
  assert.equal(page1.body.totalPosts, 3);
  assert.equal(page1.body.pages, 2);
  assert.equal(page1.body.items.length, 2);

  const page2 = await admin.get('/api/audit/alt-text?page=2&limit=2');
  assert.equal(page2.body.items.length, 1);
  // Pages must not overlap.
  const ids1 = new Set(page1.body.items.map((i) => i.postId));
  const ids2 = new Set(page2.body.items.map((i) => i.postId));
  for (const id of ids2) assert.ok(!ids1.has(id), 'page 2 must not repeat page 1 items');
});

test('the limit is clamped to a safe maximum', async () => {
  const admin = await authedAgent();
  const res = await admin.get('/api/audit/alt-text?limit=9999');
  assert.equal(res.status, 200);
  assert.ok(res.body.limit <= 50, 'limit should be clamped to at most 50');
});

test('the response exposes only safe metadata (no raw HTML or filesystem paths)', async () => {
  resetPosts();
  const admin = await authedAgent();
  await admin.post('/api/posts').send({
    title: 'Safety',
    content: '<p><img src="/uploads/safe.png"></p><p>Some <strong>body</strong> text</p>',
  });

  const res = await admin.get('/api/audit/alt-text');
  assert.equal(res.status, 200);

  const item = res.body.items[0];
  // Only whitelisted post keys.
  assert.deepEqual(Object.keys(item).sort(), ['findings', 'postId', 'slug', 'title']);
  // Only whitelisted finding keys.
  assert.deepEqual(Object.keys(item.findings[0]).sort(), ['alt', 'src', 'type']);

  const serialized = JSON.stringify(res.body);
  // No stored HTML markup should leak (only the bare src URLs are present).
  assert.ok(!serialized.includes('<strong>'), 'must not leak post HTML body');
  assert.ok(!serialized.includes('<img'), 'must not leak raw <img> markup');
  // No absolute filesystem paths.
  assert.ok(!/[A-Za-z]:\\/.test(serialized), 'must not leak a Windows filesystem path');
  assert.ok(!serialized.includes('/public/uploads'), 'must not leak an on-disk uploads path');
});

test('the endpoint returns the legend including the decorative-empty note', async () => {
  const admin = await authedAgent();
  const res = await admin.get('/api/audit/alt-text');
  assert.equal(res.status, 200);
  assert.ok(res.body.legend, 'legend must be present');
  assert.match(res.body.legend.empty_alt.detail.toLowerCase(), /decorativ/);
});

test('a post with only meaningful alt text produces no findings', async () => {
  resetPosts();
  const admin = await authedAgent();
  await admin.post('/api/posts').send({
    title: 'All good',
    content: '<p><img src="/uploads/ok.png" alt="A detailed and useful description"></p>',
  });
  const res = await admin.get('/api/audit/alt-text');
  assert.equal(res.status, 200);
  assert.equal(res.body.totalFindings, 0);
  assert.equal(res.body.items.length, 0);
});

