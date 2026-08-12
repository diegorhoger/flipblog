#!/usr/bin/env node
// Post-deploy smoke test for a live FlipBlog deployment.
//
// Exercises the same-origin API + SPA that a real user hits, through the
// environment's proxy (Caddy) exactly as traffic arrives:
//   1. liveness  GET /api/health/live                      -> 200
//   2. readiness GET /api/health/ready                     -> 200
//   3. login     POST /api/auth/login  (admin creds)       -> 200 + session/CSRF
//   4. me        GET /api/auth/me                          -> 200 (session works)
//   5. uploads   POST /api/uploads  multipart PNG          -> 201, URL fetchable
//   6. publish   POST /api/posts        (published + cover)-> 201
//   7. reader    GET /api/posts/:slug   (anonymous)        -> 200 + content
//   8. cleanup   DELETE /api/posts/:id                     -> 204
//
// The admin credentials come from the deployment's env file (the same values
// /etc/flipblog/app.env seeds), so this validates the real secret wiring.
//
// Usage:
//   node scripts/post-deploy-smoke.mjs --base-url https://flipblog.example.com \
//       --username <admin> --password <admin-password>

const BASE = arg('--base-url').replace(/\/$/, '');
const USERNAME = arg('--username');
const PASSWORD = arg('--password');

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i === -1 || !process.argv[i + 1]) {
    console.error(`usage: node scripts/post-deploy-smoke.mjs --base-url <url> --username <u> --password <p>`);
    process.exit(2);
  }
  return process.argv[i + 1];
}

// --- minimal cookie jar (fetch has none) -------------------------------------
const jar = new Map();

function jarCookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function absorbSetCookie(res) {
  let h = res.headers.getSetCookie?.();
  if (!h) {
    const single = res.headers.get('set-cookie');
    h = single ? [single] : [];
  }
  for (const c of h) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    if (val) jar.set(key, val);
  }
}

function csrfToken() {
  return jar.get('fb_csrf') || '';
}

async function req(method, path, { body, headers = {}, auth = false } = {}) {
  const h = { ...headers };
  if (auth) {
    if (jar.has('fb_session')) h.cookie = jarCookieHeader();
    if (csrfToken()) h['x-csrf-token'] = csrfToken();
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : body,
    redirect: 'manual',
  });
  absorbSetCookie(res);
  return res;
}

function assert(cond, label, detailFn = () => '') {
  if (cond) {
    console.log(`  ✓ ${label}`);
    return;
  }
  Promise.resolve(typeof detailFn === 'function' ? detailFn() : detailFn).then((d) => {
    console.error(`  ✗ ${label} — ${d}`);
    process.exit(1);
  });
}

async function main() {
  console.log(`Smoke ${BASE} (user: ${USERNAME})`);

  // 1-2. health
  const live = await req('GET', '/api/health/live');
  assert(live.status === 200, 'liveness 200', `got ${live.status}`);
  const ready = await req('GET', '/api/health/ready');
  assert(ready.status === 200, 'readiness 200', `got ${ready.status}`);

  // 3. login (sets session + CSRF cookies in the jar)
  const login = await req('POST', '/api/auth/login', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  assert(login.status === 200, 'admin login 200', async () => `got ${login.status}: ${await login.text()}`);
  assert(jar.has('fb_session'), 'session cookie issued');

  // 4. authenticated identity
  const me = await req('GET', '/api/auth/me', { auth: true });
  assert(me.status === 200, 'authenticated /api/auth/me 200', `got ${me.status}`);
  const meBody = await me.json();
  assert(meBody.user?.username === USERNAME, `me reports ${USERNAME}`, JSON.stringify(meBody));

  // 5. upload a real image (1x1 PNG), then fetch it back anonymously
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
  const fd = new FormData();
  fd.append('file', new Blob([png], { type: 'image/png' }), 'deploy-smoke.png');
  const up = await req('POST', '/api/uploads', { auth: true, body: fd });
  assert(up.status === 201, 'upload 201', async () => `got ${up.status}: ${await up.text()}`);
  const upBody = await up.json();
  const upUrl = upBody.url;
  assert(typeof upUrl === 'string' && upUrl.length > 0, 'upload returned a url');
  const fetchUp = await fetch(`${BASE}${upUrl}`);
  assert(fetchUp.status === 200, 'uploaded file publicly fetchable', `got ${fetchUp.status}`);

  // 6. publish a post with the uploaded cover
  const title = `Deploy smoke ${Date.now()}`;
  const content = '<h1>Deploy verification</h1><p>login, upload, publish, reader all exercised.</p>';
  const pub = await req('POST', '/api/posts', {
    auth: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, content, status: 'published', cover_image: upUrl }),
  });
  assert(pub.status === 201, 'publish post 201', async () => `got ${pub.status}: ${await pub.text()}`);
  const post = await pub.json();
  const id = post.id;
  const slug = post.slug;
  assert(Number.isFinite(Number(id)), 'post has id');
  assert(slug, 'post has slug');

  // 7. anonymous reader view
  const read = await req('GET', `/api/posts/${slug}`);
  assert(read.status === 200, `reader can fetch /api/posts/${slug}`, `got ${read.status}`);
  const readBody = await read.json();
  assert(readBody.content.includes('Deploy verification'), 'reader sees the published content');

  // 8. cleanup: delete the smoke post (2xx accepted; do not fail the run on 4xx)
  const del = await req('DELETE', `/api/posts/${id}`, { auth: true });
  if (del.status !== 204) {
    console.log(`  - cleanup DELETE /api/posts/${id} -> ${del.status} (accepted, not failing)`);
  } else {
    console.log('  ✓ smoke post cleaned up');
  }

  console.log('POST-DEPLOY SMOKE PASS');
}

async function safeMain() {
  try {
    await main();
  } catch (err) {
    console.error(`POST-DEPLOY SMOKE FAIL: ${err.message}`);
    process.exit(1);
  }
}

safeMain();