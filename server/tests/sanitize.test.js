import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeContent } from '../src/services/sanitize.js';

test('sanitize preserves a safe alt attribute on images', () => {
  const html = '<p><img src="/uploads/p.png" alt="Capa da revista"></p>';
  const out = sanitizeContent(html);
  assert.match(out, /<img[^>]+src="\/uploads\/p\.png"/);
  assert.match(out, /<img[^>]+alt="Capa da revista"/);
});

test('sanitize escapes hostile content inside alt', () => {
  const hostile = '<img src="/x.png" alt=\'"><script>alert(1)</script>\'>';
  const out = sanitizeContent(hostile);
  assert.ok(!out.includes('<script>'), 'script must be stripped');
  assert.ok(out.includes('alt='), 'alt attribute is retained');
  // The injected markup inside alt must be inert (quoted/escaped), not live.
  assert.ok(!out.includes('<script>alert'));
});

test('sanitize keeps an empty alt="" for decorative images', () => {
  const out = sanitizeContent('<img src="/d.png" alt="">');
  assert.match(out, /<img[^>]+alt=""/);
});
