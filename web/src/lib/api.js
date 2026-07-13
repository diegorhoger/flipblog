async function request(method, path, { body, isForm = false } = {}) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    if (isForm) {
      opts.body = body;
    } else {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch(path, opts);
  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { ok: res.ok, status: res.status, data };
}

export const api = {
  health: () => request('GET', '/api/health'),
  getPosts: (params = {}) =>
    request('GET', '/api/posts?' + new URLSearchParams(params).toString()),
  getPost: (slug) => request('GET', `/api/posts/${encodeURIComponent(slug)}`),
  getPostById: (id) => request('GET', `/api/posts/id/${id}`),
  createPost: (payload) => request('POST', '/api/posts', { body: payload }),
  updatePost: (id, payload) => request('PUT', `/api/posts/${id}`, { body: payload }),
  deletePost: (id) => request('DELETE', `/api/posts/${id}`),
  login: (username, password) =>
    request('POST', '/api/auth/login', { body: { username, password } }),
  logout: () => request('POST', '/api/auth/logout'),
  me: () => request('GET', '/api/auth/me'),
  register: (username, password, role) =>
    request('POST', '/api/auth/register', { body: { username, password, role } }),
  changePassword: (currentPassword, newPassword) =>
    request('POST', '/api/auth/change-password', { body: { currentPassword, newPassword } }),
  uploadAvatar: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return request('POST', '/api/auth/avatar', { body: fd, isForm: true });
  },
  upload: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return request('POST', '/api/uploads', { body: fd, isForm: true });
  },
};

export default api;
