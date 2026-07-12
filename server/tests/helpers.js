import request from 'supertest';
import { app } from '../src/app.js';
import { seedAdminIfMissing } from '../src/services/admin.js';

export const ADMIN = {
  username: process.env.ADMIN_USER || 'admin',
  password: process.env.ADMIN_PASSWORD || 'test-password',
};

export async function authedAgent() {
  await seedAdminIfMissing();
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send(ADMIN);
  if (res.status !== 200) throw new Error(`test login failed: ${res.status}`);
  return agent;
}

export { app, request };
