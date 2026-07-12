export function getHashRoute() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, queryStr] = raw.split('?');
  const query = Object.fromEntries(new URLSearchParams(queryStr || ''));
  return { path: path || '/', query };
}

export function navigate(path) {
  if (location.hash === `#${path}`) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = path;
  }
}

export function matchRoute(pattern, path) {
  if (pattern === '*') return {};
  const pp = pattern.split('/').filter(Boolean);
  const cp = path.split('/').filter(Boolean);
  if (pp.length !== cp.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(cp[i]);
    else if (pp[i] !== cp[i]) return null;
  }
  return params;
}

export function resolveRoute(routes) {
  const { path } = getHashRoute();
  for (const route of routes) {
    const params = matchRoute(route.pattern, path);
    if (params) return { route, params, path };
  }
  const fallback = routes.find((r) => r.pattern === '*') || routes[0];
  return { route: fallback, params: {}, path };
}
