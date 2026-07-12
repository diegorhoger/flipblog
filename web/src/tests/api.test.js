import { describe, it, expect, vi, afterEach } from 'vitest';

function fakeFetch(json, { ok = true, status = 200 } = {}) {
  return vi.fn(async () => ({
    ok,
    status,
    text: async () => (json === null ? '' : JSON.stringify(json)),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api client', () => {
  it('getPosts parses list response', async () => {
    vi.stubGlobal('fetch', fakeFetch({ items: [{ id: 1, title: 'A' }], total: 1, page: 1, limit: 12, pages: 1 }));
    const { api } = await import('../lib/api.js');
    const res = await api.getPosts({ status: 'published' });
    expect(res.ok).toBe(true);
    expect(res.data.items).toHaveLength(1);
  });

  it('login surfaces invalid_credentials', async () => {
    vi.stubGlobal('fetch', fakeFetch({ error: 'invalid_credentials' }, { ok: false, status: 401 }));
    const { api } = await import('../lib/api.js');
    const res = await api.login('admin', 'wrong');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
  });

  it('createPost sends JSON body and returns 201', async () => {
    const fetchMock = fakeFetch({ id: 2, slug: 'novo' }, { status: 201 });
    vi.stubGlobal('fetch', fetchMock);
    const { api } = await import('../lib/api.js');
    const res = await api.createPost({ title: 'novo', content: '<p>x</p>' });
    expect(res.status).toBe(201);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body).title).toBe('novo');
  });

  it('deletePost issues DELETE with no body', async () => {
    const fetchMock = fakeFetch(null, { status: 204 });
    vi.stubGlobal('fetch', fetchMock);
    const { api } = await import('../lib/api.js');
    const res = await api.deletePost(5);
    expect(res.status).toBe(204);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  it('upload sends FormData', async () => {
    const fetchMock = fakeFetch({ url: '/uploads/x.png' }, { status: 201 });
    vi.stubGlobal('fetch', fetchMock);
    const { api } = await import('../lib/api.js');
    const file = new File(['x'], 'x.png', { type: 'image/png' });
    const res = await api.upload(file);
    expect(res.data.url).toBe('/uploads/x.png');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('register posts username, password and role', async () => {
    const fetchMock = fakeFetch({ user: { username: 'ana', role: 'author' } }, { status: 201 });
    vi.stubGlobal('fetch', fetchMock);
    const { api } = await import('../lib/api.js');
    const res = await api.register('ana', 'sup3rsecret', 'author');
    expect(res.status).toBe(201);
    expect(res.data.user.username).toBe('ana');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/register');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ username: 'ana', password: 'sup3rsecret', role: 'author' });
  });
});
