import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../src/config.js';

const PROD = {
  NODE_ENV: 'production',
  APP_SECRET: 'prod-secret-0123456789abcdef0123456789abcdef',
  TRUST_PROXY: 'loopback',
};

test('production accepts a long, non-default APP_SECRET with an explicit trust proxy', () => {
  const cfg = resolveConfig({ ...PROD });
  assert.equal(cfg.trustProxy, 'loopback');
  assert.equal(cfg.appSecret, PROD.APP_SECRET);
});

test('production refuses a short APP_SECRET', () => {
  assert.throws(() => resolveConfig({ ...PROD, APP_SECRET: 'short-secret' }), /APP_SECRET/);
});

test('production refuses known insecure default secrets', () => {
  assert.throws(
    () => resolveConfig({ ...PROD, APP_SECRET: 'dev-insecure-secret-change-me' }),
    /known insecure default/
  );
  assert.throws(
    () => resolveConfig({ ...PROD, APP_SECRET: 'test-secret-not-for-production' }),
    /known insecure default/
  );
});

test('production refuses a missing TRUST_PROXY', () => {
  assert.throws(() => resolveConfig({ ...PROD, TRUST_PROXY: undefined }), /TRUST_PROXY/);
  assert.throws(() => resolveConfig({ ...PROD, TRUST_PROXY: '' }), /TRUST_PROXY/);
});

test('production refuses an explicitly disabled trust proxy', () => {
  assert.throws(() => resolveConfig({ ...PROD, TRUST_PROXY: 'false' }), /TRUST_PROXY/);
  assert.throws(() => resolveConfig({ ...PROD, TRUST_PROXY: '0' }), /TRUST_PROXY/);
});

test('TRUST_PROXY=1 is a bounded numeric hop count, not the unbounded boolean true', () => {
  assert.equal(resolveConfig({ TRUST_PROXY: '1' }).trustProxy, 1);
  assert.equal(resolveConfig({ TRUST_PROXY: '2' }).trustProxy, 2);
  assert.equal(resolveConfig({ TRUST_PROXY: '0' }).trustProxy, 0);
  assert.notEqual(resolveConfig({ TRUST_PROXY: '1' }).trustProxy, true);
});

test('production accepts a bounded hop-count trust proxy', () => {
  const cfg = resolveConfig({ ...PROD, TRUST_PROXY: '1' });
  assert.equal(cfg.trustProxy, 1);
});

test('unbounded boolean-true proxy trust is rejected everywhere', () => {
  assert.throws(() => resolveConfig({ TRUST_PROXY: 'true' }), /TRUST_PROXY=true/);
  assert.throws(() => resolveConfig({ ...PROD, TRUST_PROXY: 'true' }), /TRUST_PROXY=true/);
});

test('non-production environments accept default weak secrets without a trust proxy', () => {
  const cfg = resolveConfig({ NODE_ENV: 'development' });
  assert.equal(cfg.appSecret, 'dev-insecure-secret-change-me');
  assert.equal(cfg.trustProxy, 'loopback');
});

test('trust proxy accepts the supported proxy-addr values', () => {
  assert.equal(resolveConfig({ TRUST_PROXY: 'false' }).trustProxy, false);
  assert.equal(resolveConfig({ TRUST_PROXY: '2' }).trustProxy, 2);
  assert.equal(resolveConfig({ TRUST_PROXY: 'loopback' }).trustProxy, 'loopback');
  assert.equal(resolveConfig({ TRUST_PROXY: '10.0.0.1' }).trustProxy, '10.0.0.1');
  assert.equal(resolveConfig({ TRUST_PROXY: '10.0.0.0/8' }).trustProxy, '10.0.0.0/8');
  assert.equal(resolveConfig({ TRUST_PROXY: 'loopback, 10.0.0.1' }).trustProxy, 'loopback, 10.0.0.1');
});
