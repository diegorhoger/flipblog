import { test, describe, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { app, request, ADMIN } from './helpers.js';
import { createLoginRateLimiter, loginLimiter, changePasswordLimiter } from '../src/security/authRateLimiter.js';
import { authRateLimiter } from '../src/routes/auth.js';
import { createUser, seedUserIfMissing } from '../src/services/users.js';

const VALID_LOGIN = { username: ADMIN.username, password: ADMIN.password };
const WRONG = { username: 'nonexistent', password: 'wrong' };

afterEach(() => {
  authRateLimiter._store.clear();
});

describe('authRateLimiter unit', () => {
  test('tryConsume returns true while under limit', () => {
    const rl = createLoginRateLimiter({ maxFailures: 3, windowMs: 60000, now: () => 1000 });
    assert.equal(rl.tryConsume('k'), true);
    assert.equal(rl.tryConsume('k'), true);
    assert.equal(rl.tryConsume('k'), true);
  });

  test('tryConsume returns false when over limit', () => {
    const rl = createLoginRateLimiter({ maxFailures: 2, windowMs: 60000, now: () => 1000 });
    assert.equal(rl.tryConsume('k'), true);
    assert.equal(rl.tryConsume('k'), true);
    assert.equal(rl.tryConsume('k'), false);
  });

  test('clearKey resets the key', () => {
    const rl = createLoginRateLimiter({ maxFailures: 1, windowMs: 60000, now: () => 1000 });
    assert.equal(rl.tryConsume('k'), true);
    assert.equal(rl.tryConsume('k'), false);
    rl.clearKey('k');
    assert.equal(rl.tryConsume('k'), true);
  });

  test('status returns correct remaining count', () => {
    const rl = createLoginRateLimiter({ maxFailures: 5, windowMs: 60000, now: () => 1000 });
    assert.equal(rl.status('k').remaining, 5);
    rl.tryConsume('k');
    assert.equal(rl.status('k').remaining, 4);
  });

  test('expired window resets the counter', () => {
    let t = 1000;
    const rl = createLoginRateLimiter({ maxFailures: 2, windowMs: 10000, now: () => t });
    assert.equal(rl.tryConsume('k'), true);
    assert.equal(rl.tryConsume('k'), true);
    assert.equal(rl.tryConsume('k'), false);
    t += 10001;
    assert.equal(rl.tryConsume('k'), true);
  });

  test('different keys are independent', () => {
    const rl = createLoginRateLimiter({ maxFailures: 1, windowMs: 60000, now: () => 1000 });
    assert.equal(rl.tryConsume('a'), true);
    assert.equal(rl.tryConsume('a'), false);
    assert.equal(rl.tryConsume('b'), true);
  });

  test('clearPrefix clears all matching keys', () => {
    const rl = createLoginRateLimiter({ maxFailures: 5, windowMs: 60000, now: () => 1000 });
    rl.tryConsume('ip:1.2.3.4');
    rl.tryConsume('ip:1.2.3.4:login:admin');
    rl.tryConsume('ip:5.6.7.8');
    rl.clearPrefix('ip:1.2.3.4');
    assert.equal(rl.status('ip:1.2.3.4').remaining, 5);
    assert.equal(rl.status('ip:1.2.3.4:login:admin').remaining, 5);
    assert.equal(rl.status('ip:5.6.7.8').remaining, 4);
  });

  test('tryConsume is synchronous and atomic', () => {
    const rl = createLoginRateLimiter({ maxFailures: 1, windowMs: 60000, now: () => 1000 });
    assert.equal(rl.tryConsume('k'), true);
    assert.equal(rl.tryConsume('k'), false);
  });
});

describe('login rate limit integration', () => {
  before(() => seedUserIfMissing());

  test('failed logins below threshold return 401', async () => {
    for (let i = 0; i < 4; i++) {
      const res = await request(app).post('/api/auth/login').send(WRONG);
      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'invalid_credentials');
    }
  });

  test('threshold-crossing request returns 429', async () => {
    for (let i = 0; i < 6; i++) {
      const res = await request(app).post('/api/auth/login').send(WRONG);
      if (res.status === 429) {
        assert.equal(res.body.error, 'too_many_attempts');
        return;
      }
    }
    assert.fail('never got 429');
  });

  test('Retry-After header is present on 429', async () => {
    for (let i = 0; i < 6; i++) {
      const res = await request(app).post('/api/auth/login').send(WRONG);
      if (res.status === 429) {
        assert.ok(res.headers['retry-after'] !== undefined);
        const seconds = Number(res.headers['retry-after']);
        assert.ok(Number.isFinite(seconds) && seconds > 0);
        return;
      }
    }
    assert.fail('never got 429');
  });

  test('username normalization cannot bypass limit (Admin != admin)', async () => {
    for (let i = 0; i < 6; i++) {
      const u = i % 2 === 0 ? 'Admin' : 'ADMIN';
      const res = await request(app).post('/api/auth/login').send({ username: u, password: 'bad' });
      if (res.status === 429) {
        assert.equal(res.body.error, 'too_many_attempts');
        return;
      }
    }
    assert.fail('never got 429');
  });

  test('successful login clears failure state for the same IP and user', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/auth/login').send({ username: ADMIN.username, password: 'wrong' });
    }
    const ok = await request(app).post('/api/auth/login').send(VALID_LOGIN);
    assert.equal(ok.status, 200);

    const retry = await request(app).post('/api/auth/login').send({ username: ADMIN.username, password: 'wrong' });
    assert.equal(retry.status, 401);
  });

  test('malformed login bodies return 400 without consuming quota', async () => {
    const res1 = await request(app).post('/api/auth/login').send({});
    assert.equal(res1.status, 400);
    assert.equal(res1.body.error, 'validation_failed');

    const res2 = await request(app).post('/api/auth/login').send({ username: 'u' });
    assert.equal(res2.status, 400);

    const fresh = await request(app).post('/api/auth/login').send(WRONG);
    assert.equal(fresh.status, 401);
  });

  test('429 response body does not reveal internal details', async () => {
    for (let i = 0; i < 6; i++) {
      const res = await request(app).post('/api/auth/login').send(WRONG);
      if (res.status === 429) {
        assert.equal(Object.keys(res.body).length, 1);
        assert.equal(res.body.error, 'too_many_attempts');
        return;
      }
    }
    assert.fail('never got 429');
  });

  test('expired window permits attempts again', async () => {
    const originalNow = Date.now;
    try {
      let fakeTime = 1000000;
      const rl = createLoginRateLimiter({ maxFailures: 5, windowMs: 60000, now: () => fakeTime });

      for (let i = 0; i < 5; i++) {
        rl.tryConsume('ip:127.0.0.1');
      }
      assert.equal(rl.tryConsume('ip:127.0.0.1'), false);

      fakeTime += 60001;
      assert.equal(rl.tryConsume('ip:127.0.0.1'), true);
    } finally {
      authRateLimiter._store.clear();
    }
  });
});

describe('change-password rate limit integration', () => {
  async function createUserAndLogin(agent) {
    const tag = `cp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const created = await createUser({ username: tag, password: 'initialpw1', role: 'author' });
    await agent.post('/api/auth/login').send({ username: tag, password: 'initialpw1' });
    return { username: tag, password: 'initialpw1' };
  }

  test('failed change-password attempts are limited per user', async () => {
    const agent = request.agent(app);
    await createUserAndLogin(agent);

    for (let i = 0; i < 6; i++) {
      const res = await agent.post('/api/auth/change-password').send({
        currentPassword: 'wrong',
        newPassword: 'newpass123',
      });
      if (res.status === 429) {
        assert.equal(res.body.error, 'too_many_attempts');
        return;
      }
      assert.equal(res.status, 401);
    }
    assert.fail('never got 429');
  });

  test('successful password change clears failure state', async () => {
    const agent = request.agent(app);
    const user = await createUserAndLogin(agent);

    for (let i = 0; i < 3; i++) {
      await agent.post('/api/auth/change-password').send({
        currentPassword: 'wrong',
        newPassword: 'newpass123',
      });
    }

    const ok = await agent.post('/api/auth/change-password').send({
      currentPassword: user.password,
      newPassword: 'newpass123',
    });
    assert.equal(ok.status, 200);

    const retry = await agent.post('/api/auth/change-password').send({
      currentPassword: 'wrong',
      newPassword: 'newpass123',
    });
    assert.equal(retry.status, 401);
  });

  test('different users have independent change-password limits', async () => {
    const agent1 = request.agent(app);
    await createUserAndLogin(agent1);

    for (let i = 0; i < 6; i++) {
      const res = await agent1.post('/api/auth/change-password').send({
        currentPassword: 'wrong',
        newPassword: 'newpass123',
      });
      if (res.status === 429) break;
    }

    const agent2 = request.agent(app);
    await createUserAndLogin(agent2);
    const fresh = await agent2.post('/api/auth/change-password').send({
      currentPassword: 'wrong',
      newPassword: 'newpass123',
    });
    assert.equal(fresh.status, 401);
  });
});

describe('proxy safety', () => {
  test('X-Forwarded-For header is not trusted by default (safe default)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', '10.0.0.99')
      .send(WRONG);
    assert.equal(res.status, 401);
  });
});
