import { describe, it, expect, beforeEach } from 'vitest';
import { matchRoute, getHashRoute, resolveRoute } from '../lib/router.js';

beforeEach(() => {
  location.hash = '';
});

describe('matchRoute', () => {
  it('matches static patterns', () => {
    expect(matchRoute('/admin', '/admin')).toEqual({});
  });

  it('extracts params', () => {
    expect(matchRoute('/read/:slug', '/read/ola-mundo')).toEqual({ slug: 'ola-mundo' });
  });

  it('returns null on segment mismatch', () => {
    expect(matchRoute('/read/:slug', '/read/a/b')).toBeNull();
    expect(matchRoute('/admin', '/login')).toBeNull();
  });

  it('wildcard matches anything', () => {
    expect(matchRoute('*', '/whatever')).toEqual({});
  });
});

describe('getHashRoute', () => {
  it('defaults to /', () => {
    expect(getHashRoute().path).toBe('/');
  });

  it('parses path and query', () => {
    location.hash = '/read/foo?preview=1';
    const r = getHashRoute();
    expect(r.path).toBe('/read/foo');
    expect(r.query).toEqual({ preview: '1' });
  });
});

describe('resolveRoute', () => {
  const routes = [
    { pattern: '/', view: 'home' },
    { pattern: '/read/:slug', view: 'reader' },
    { pattern: '*', view: 'fallback' },
  ];
  it('resolves the most specific route', () => {
    location.hash = '/read/abc';
    expect(resolveRoute(routes).route.view).toBe('reader');
  });
});
