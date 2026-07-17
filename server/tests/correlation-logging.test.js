import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import {
  isValidRequestId,
  generateRequestId,
  extractError,
  redact,
  createLogger,
  REQUEST_ID_PATTERN,
} from '../src/logging.js';
import { requestId } from '../src/middleware/requestId.js';
import { app, request } from './helpers.js';

// Capture everything written to a stream (one JSON object per line) for
// assertions about structured output.
function captureStream() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return {
    stream,
    text: () => chunks.join(''),
    lines: () => chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
  };
}

// --- request id validation / generation ---

test('a valid request id is accepted', () => {
  assert.equal(isValidRequestId('abc-123_XY'), true);
  assert.equal(isValidRequestId(generateRequestId()), true);
});

test('invalid request ids are rejected', () => {
  for (const bad of ['', 'short', 'with space', 'bad\ninject', 'bad\tinject', 'bad"quote', 'x'.repeat(200)]) {
    assert.equal(isValidRequestId(bad), false, `expected "${bad}" to be invalid`);
  }
});

test('generateRequestId yields a strict-pattern uuid', () => {
  const id = generateRequestId();
  assert.ok(REQUEST_ID_PATTERN.test(id));
  assert.notEqual(generateRequestId(), generateRequestId());
});

// --- safe error extraction (no stack / no leaked internals) ---

test('extractError drops the stack and returns only a coarse shape', () => {
  const err = new Error("SELECT * FROM admin WHERE secret='x'");
  err.code = 'ERR_SQLITE_ERROR';
  const ex = extractError(err);
  assert.equal(ex.name, 'Error');
  assert.equal(ex.code, 'ERR_SQLITE_ERROR');
  assert.ok(ex.message.includes('SELECT'));
  assert.ok(!('stack' in ex));
});

test('extractError tolerates non-Error throws', () => {
  assert.deepEqual(extractError('boom'), { name: 'Error', message: 'boom' });
  assert.deepEqual(extractError({ name: 'Weird' }), { name: 'Weird', message: '[object Object]' });
});

// --- redaction of sensitive data ---

test('redact masks known-sensitive keys recursively', () => {
  const redacted = redact({
    nested: { password: 'hunter2', token: 'abc' },
    authorization: 'Bearer secret',
    cookie: 'fb_session=xyz',
    safe: 'kept',
  });
  const serialized = JSON.stringify(redacted);
  assert.ok(!serialized.includes('hunter2'), 'password must be masked');
  assert.ok(!serialized.includes('Bearer secret'), 'authorization must be masked');
  assert.ok(!serialized.includes('fb_session=xyz'), 'cookie must be masked');
  assert.ok(serialized.includes('kept'), 'non-sensitive values survive');
  assert.ok(serialized.includes('[redacted]'));
});

test('redact drops functions and bounds depth / cycles', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const out = redact({ fn: () => 1, cyc: cyclic, deep: { a: { b: { c: { d: { e: { f: 'x' } } } } } } });
  assert.equal(out.fn, undefined, 'functions are dropped');
  assert.equal(out.cyc.self, '[circular]', 'cycles are contained');
});

// --- logger emits structured JSON ---

test('logger writes one structured JSON line per call and redacts', () => {
  const cap = captureStream();
  const log = createLogger({ stream: cap.stream, isProduction: true });
  log.info({ requestId: 'r1', method: 'GET', password: 'nope', path: '/api/auth/login' });
  const lines = cap.lines();
  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.equal(line.level, 'info');
  assert.equal(line.requestId, 'r1');
  assert.equal(line.path, '/api/auth/login');
  assert.equal(line.password, '[redacted]');
  assert.ok(typeof line.time === 'string');
});

test('logger.error records error classification without leaking internals', () => {
  const cap = captureStream();
  const log = createLogger({ stream: cap.stream, isProduction: true });
  const err = new Error('boom at C:\\secret\\path sql=err');
  err.code = 'ERR_SQLITE_ERROR';
  log.error({ requestId: 'r9', path: '/x', code: 'internal_error' }, err);
  const line = cap.lines()[0];
  assert.equal(line.level, 'error');
  assert.equal(line.requestId, 'r9');
  assert.equal(line.code, 'internal_error');
  // In production we still log the coarse error name + code for correlation, but
  // never the raw message (which may carry SQL/paths) or the stack.
  assert.equal(line.error.name, 'Error');
  assert.equal(line.error.code, 'ERR_SQLITE_ERROR');
  assert.ok(line.error.message === undefined || !line.error.message.includes('boom'));
  assert.ok(!('stack' in line));
  assert.ok(JSON.stringify(line).includes('[redacted]') === false);
});

// --- requestId middleware ---

function makeReqRes() {
  const req = { headers: {}, method: 'GET', path: '/api/health' };
  const res = {
    statusCode: 200,
    _headers: {},
    set(k, v) {
      this._headers[k.toLowerCase()] = v;
    },
    on() {},
  };
  return { req, res };
}

test('requestId generates and sets a fresh X-Request-ID when none supplied', () => {
  const cap = captureStream();
  const log = createLogger({ stream: cap.stream, isProduction: true });
  const { req, res } = makeReqRes();
  let nexted = false;
  requestId({ log })(req, res, () => {
    nexted = true;
  });
  assert.equal(nexted, true);
  assert.ok(REQUEST_ID_PATTERN.test(req.requestId));
  assert.equal(res._headers['x-request-id'], req.requestId);
});

test('requestId echoes a valid incoming X-Request-ID and rejects an invalid one', () => {
  const cap = captureStream();
  const log = createLogger({ stream: cap.stream, isProduction: true });

  const good = makeReqRes();
  good.req.headers['x-request-id'] = 'client-supplied-123';
  requestId({ log })(good.req, good.res, () => {});
  assert.equal(good.req.requestId, 'client-supplied-123');
  assert.equal(good.res._headers['x-request-id'], 'client-supplied-123');

  const bad = makeReqRes();
  bad.req.headers['x-request-id'] = 'has "injection"';
  requestId({ log })(bad.req, bad.res, () => {});
  assert.notEqual(bad.req.requestId, 'has "injection"');
  assert.ok(REQUEST_ID_PATTERN.test(bad.req.requestId));
});

// --- end-to-end correlation through the app ---

test('every API response carries an X-Request-ID header', async () => {
  const res = await request(app).get('/api/health');
  assert.ok(res.headers['x-request-id'], 'header must be present');
  assert.ok(REQUEST_ID_PATTERN.test(res.headers['x-request-id']));
});

test('a supplied valid X-Request-ID is echoed back on the response', async () => {
  const res = await request(app).get('/api/health').set('X-Request-ID', 'trace-abc-123');
  assert.equal(res.headers['x-request-id'], 'trace-abc-123');
});

test('an invalid X-Request-ID is replaced with a generated one', async () => {
  // 'bad id' is well-formed HTTP but fails the strict id pattern (contains a
  // space), so the server must discard it and generate a fresh uuid instead.
  const res = await request(app).get('/api/health').set('X-Request-ID', 'bad id');
  assert.ok(REQUEST_ID_PATTERN.test(res.headers['x-request-id']));
  assert.notEqual(res.headers['x-request-id'], 'bad id');
});

test('a 500 internal error is logged with the request id and a generic code', async () => {
  const { createErrorHandler } = await import('../src/errorHandler.js');
  const logged = [];
  const fakeLog = { error: (event, err) => logged.push({ event, err }) };

  const handler = createErrorHandler(fakeLog);
  const req = { requestId: 'req-xyz-123', method: 'POST', path: '/api/auth/avatar' };
  let statusCode;
  const res = { status(code) { statusCode = code; return { json: () => {} }; } };

  handler(new Error("boom at C:\\secret\\db sql=err"), req, res);

  assert.equal(statusCode, 500);
  assert.equal(logged.length, 1);
  const { event, err } = logged[0];
  assert.equal(event.requestId, 'req-xyz-123');
  assert.equal(event.method, 'POST');
  assert.equal(event.path, '/api/auth/avatar');
  assert.equal(event.code, 'internal_error');
  // The raw error is passed to the logger but its message must never reach the
  // client body; the logger is responsible for redaction (tested separately).
  assert.ok(err instanceof Error);
});

test('a validated ApiError still surfaces its status and code without logging', async () => {
  const { createErrorHandler } = await import('../src/errorHandler.js');
  const { ApiError } = await import('../src/errors.js');
  const logged = [];
  const fakeLog = { error: (event) => logged.push(event) };

  const handler = createErrorHandler(fakeLog);
  const req = { requestId: 'req-aaa', method: 'GET', path: '/api/posts/999' };
  let statusCode;
  let body;
  const res = { status(code) { statusCode = code; return { json: (b) => { body = b; } }; } };

  handler(new ApiError(404, 'not_found'), req, res);

  assert.equal(statusCode, 404);
  assert.deepEqual(body, { error: 'not_found' });
  assert.equal(logged.length, 0, 'known client errors are not logged as server faults');
});

test('body-parser errors map to fixed safe codes without logging', async () => {
  const { createErrorHandler } = await import('../src/errorHandler.js');
  const logged = [];
  const fakeLog = { error: (event) => logged.push(event) };

  const handler = createErrorHandler(fakeLog);
  const req = { requestId: 'req-bbb', method: 'POST', path: '/api/auth/login' };
  const run = (err, expectedStatus, expectedCode) => {
    let statusCode;
    let body;
    handler(err, req, { status(code) { statusCode = code; return { json: (b) => { body = b; } }; } });
    assert.equal(statusCode, expectedStatus);
    assert.equal(body.error, expectedCode);
  };
  run({ type: 'entity.parse.failed' }, 400, 'invalid_json');
  run({ type: 'entity.too.large' }, 413, 'payload_too_large');
  assert.equal(logged.length, 0);
});
