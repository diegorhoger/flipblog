import request from 'supertest';
import { app } from '../src/app.js';
import { seedUserIfMissing } from '../src/services/users.js';

export const ADMIN = {
  username: process.env.ADMIN_USER || 'admin',
  password: process.env.ADMIN_PASSWORD || 'test-password',
};

const CSRF_COOKIE = 'fb_csrf';
const CSRF_HEADER = 'x-csrf-token';

// Read the CSRF token from a login response's Set-Cookie headers so tests can
// echo it back as the x-csrf-token header (the same double-submit dance the web
// client performs).
export function csrfTokenFrom(res) {
  const setCookie = res?.headers?.['set-cookie'];
  if (!setCookie) return null;
  const entries = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const entry of entries) {
    const match = entry.match(new RegExp(`(?:^|;\\s*)${CSRF_COOKIE}=([^;]+)`));
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

// Log in an agent and attach the CSRF header it must send on state-changing
// requests (POST/PUT/PATCH/DELETE) once the CSRF middleware is enforced.
export async function loginAndAttachCsrf(agent, username, password) {
  const res = await agent.post('/api/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`test login failed: ${res.status}`);
  const token = csrfTokenFrom(res);
  if (token) agent.set(CSRF_HEADER, token);
  return agent;
}

export async function authedAgent() {
  await seedUserIfMissing();
  return loginAndAttachCsrf(request.agent(app), ADMIN.username, ADMIN.password);
}

export { app, request };
