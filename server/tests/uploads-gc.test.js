import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { createPost, updatePost, deletePost } from '../src/services/posts.js';
import { setAvatar, seedAdminIfMissing } from '../src/services/admin.js';
import {
  extractUploadUrls,
  uploadUrlToPath,
  diffRemovedUploads,
} from '../src/services/uploadRefs.js';

// Owner/admin actor so updatePost/deletePost authorization passes.
const ADMIN = { sub: 1, role: 'admin' };

mkdirSync(config.uploadsDir, { recursive: true });

// Track every file/dir we create so a stray assertion failure never leaves
// artifacts behind in the real uploads directory.
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

// Create a real upload file and return its on-disk path and public URL, exactly
// as the upload endpoint would produce it (`/uploads/<uuid>.<ext>`).
function makeUpload(ext = '.png') {
  const name = `${randomUUID()}${ext}`;
  const filePath = path.join(config.uploadsDir, name);
  writeFileSync(filePath, 'fake-image-bytes');
  artifacts.push(filePath);
  return { name, filePath, url: `${config.uploadsUrl}/${name}` };
}

function img(url, alt = 'x') {
  return `<p><img src="${url}" alt="${alt}"></p>`;
}

test('removed image is deleted after a post update', () => {
  const a = makeUpload();
  const post = createPost({ title: 'GC removed', content: img(a.url) }, ADMIN);
  assert.ok(existsSync(a.filePath));

  updatePost(post.id, { content: '<p>no image anymore</p>' }, ADMIN);
  assert.equal(existsSync(a.filePath), false, 'orphaned upload should be deleted');
});

test('image is retained when still present in the updated content', () => {
  const a = makeUpload();
  const post = createPost({ title: 'GC kept', content: img(a.url, 'before') }, ADMIN);

  updatePost(post.id, { content: img(a.url, 'after') }, ADMIN);
  assert.ok(existsSync(a.filePath), 'still-referenced upload must be retained');
});

test('shared image is retained while another post references it', () => {
  const a = makeUpload();
  const p1 = createPost({ title: 'GC share A', content: img(a.url) }, ADMIN);
  createPost({ title: 'GC share B', content: img(a.url) }, ADMIN);

  // Drop the image from p1 only.
  updatePost(p1.id, { content: '<p>removed here</p>' }, ADMIN);
  assert.ok(existsSync(a.filePath), 'shared upload must stay while another post uses it');
});

test('shared image is deleted after the last referencing post is removed', () => {
  const a = makeUpload();
  const p1 = createPost({ title: 'GC last A', content: img(a.url) }, ADMIN);
  const p2 = createPost({ title: 'GC last B', content: img(a.url) }, ADMIN);

  deletePost(p1.id, ADMIN);
  assert.ok(existsSync(a.filePath), 'retained while p2 still references it');

  deletePost(p2.id, ADMIN);
  assert.equal(existsSync(a.filePath), false, 'deleted once the last reference is gone');
});

test('post deletion cleans unshared uploads', () => {
  const a = makeUpload();
  const post = createPost({ title: 'GC delete', content: img(a.url) }, ADMIN);
  assert.ok(existsSync(a.filePath));

  deletePost(post.id, ADMIN);
  assert.equal(existsSync(a.filePath), false);
});

test('external image URLs are ignored by extraction and cleanup', () => {
  const a = makeUpload();
  const external = 'https://cdn.example.com/remote.png';
  const post = createPost(
    { title: 'GC external', content: `<p><img src="${a.url}"><img src="${external}"></p>` },
    ADMIN
  );

  // Only the local upload is recognised.
  assert.deepEqual(extractUploadUrls(post.content), [a.url]);

  // Updating away both images deletes only the local file and never throws on
  // the external URL.
  updatePost(post.id, { content: '<p>clean</p>' }, ADMIN);
  assert.equal(existsSync(a.filePath), false);
});

test('a post update does not delete a file used as a profile avatar', async () => {
  const seeded = await seedAdminIfMissing();
  const a = makeUpload();
  setAvatar(seeded.id, a.url); // the file is now a profile avatar
  const post = createPost({ title: 'GC avatar update', content: img(a.url) }, ADMIN);

  updatePost(post.id, { content: '<p>image removed from the post</p>' }, ADMIN);
  assert.ok(existsSync(a.filePath), 'a file used as an avatar must not be deleted');
});

test('a post deletion does not delete a file used as a profile avatar', async () => {
  const seeded = await seedAdminIfMissing();
  const a = makeUpload();
  setAvatar(seeded.id, a.url);
  const post = createPost({ title: 'GC avatar delete', content: img(a.url) }, ADMIN);

  deletePost(post.id, ADMIN);
  assert.ok(existsSync(a.filePath), 'avatar-referenced file must survive post deletion');
});

test('a file becomes eligible for cleanup once no avatar references it', async () => {
  const seeded = await seedAdminIfMissing();
  const a = makeUpload();
  setAvatar(seeded.id, a.url);
  const post = createPost({ title: 'GC avatar cleared', content: img(a.url) }, ADMIN);

  // Clear the avatar first, then drop the image from the post: with neither a
  // post nor an avatar referencing it, the file is finally collectible.
  setAvatar(seeded.id, null);
  updatePost(post.id, { content: '<p>gone</p>' }, ADMIN);
  assert.equal(existsSync(a.filePath), false, 'no post and no avatar reference -> deleted');
});

test('query and fragment URL variants are rejected', () => {
  assert.equal(uploadUrlToPath('/uploads/a.png?v=2'), null);
  assert.equal(uploadUrlToPath('/uploads/a.png#frag'), null);
  assert.equal(uploadUrlToPath('/uploads/a.png?'), null);
  assert.equal(uploadUrlToPath('/uploads/a.png#'), null);

  const html = '<p><img src="/uploads/a.png?v=2"><img src="/uploads/b.png#x"></p>';
  assert.deepEqual(extractUploadUrls(html), []);
});

test('path traversal attempts are ignored', () => {
  assert.equal(uploadUrlToPath('/uploads/../../etc/passwd'), null);
  assert.equal(uploadUrlToPath('/uploads/..%2f..%2fsecret.png'), null);
  assert.equal(uploadUrlToPath('/uploads/sub/dir/file.png'), null);
  assert.equal(uploadUrlToPath('/uploads/'), null);

  const html = '<p><img src="/uploads/../secret.png"><img src="/uploads/a/b.png"></p>';
  assert.deepEqual(extractUploadUrls(html), []);
});

test('a missing upload file does not fail update or delete', () => {
  const missing = `${config.uploadsUrl}/${randomUUID()}.png`; // never written to disk
  const post = createPost({ title: 'GC missing', content: img(missing) }, ADMIN);

  const updated = updatePost(post.id, { content: '<p>x</p>' }, ADMIN);
  assert.ok(updated, 'update succeeds even though the referenced file is absent');

  const missing2 = `${config.uploadsUrl}/${randomUUID()}.png`;
  const post2 = createPost({ title: 'GC missing 2', content: img(missing2) }, ADMIN);
  assert.equal(deletePost(post2.id, ADMIN), true, 'delete succeeds with an absent file');
});

test('files outside uploadsDir are never deleted', () => {
  const outside = path.join(os.tmpdir(), `flipblog-gc-outside-${randomUUID()}.png`);
  writeFileSync(outside, 'protected');
  artifacts.push(outside);

  // A crafted traversal URL must not map to the outside file.
  assert.equal(uploadUrlToPath(`/uploads/../../${path.basename(outside)}`), null);

  // Even when such a URL is stored in content, cleanup ignores it.
  const post = createPost(
    { title: 'GC outside', content: `<p><img src="/uploads/../../${path.basename(outside)}"></p>` },
    ADMIN
  );
  deletePost(post.id, ADMIN);
  assert.ok(existsSync(outside), 'a file outside uploadsDir must never be deleted');
});

test('a cleanup filesystem failure does not fail the post operation', () => {
  // Point a content image URL at a path that is actually a directory. rmSync
  // without `recursive` throws on a directory, exercising the swallow-and-log
  // path while proving the post operation still succeeds.
  const name = `${randomUUID()}.png`;
  const dirAtFilePath = path.join(config.uploadsDir, name);
  mkdirSync(dirAtFilePath, { recursive: true });
  artifacts.push(dirAtFilePath);
  const url = `${config.uploadsUrl}/${name}`;

  const post = createPost({ title: 'GC fs-fail', content: img(url) }, ADMIN);
  const ok = deletePost(post.id, ADMIN);

  assert.equal(ok, true, 'post deletion succeeds despite a cleanup failure');
  assert.ok(existsSync(dirAtFilePath), 'the failing target is left untouched');
});

test('diffRemovedUploads reports only URLs dropped from content', () => {
  const a = makeUpload();
  const b = makeUpload();
  const prev = `${img(a.url)}${img(b.url)}`;
  const next = img(b.url);
  assert.deepEqual(diffRemovedUploads(prev, next), [a.url]);
  assert.deepEqual(diffRemovedUploads(next, next), []);
});
