export function createLoginRateLimiter({ maxFailures = 5, windowMs = 15 * 60 * 1000, maxEntries = 10000, now = Date.now } = {}) {
  const store = new Map();

  function getEntry(key) {
    const entry = store.get(key);
    const t = now();
    if (entry && t < entry.resetAt) return entry;
    if (entry) store.delete(key);
    return null;
  }

  function isBlocked(key, max) {
    const limit = max ?? maxFailures;
    const entry = getEntry(key);
    if (!entry) return { blocked: false, remaining: limit, resetAt: 0 };
    return { blocked: entry.count >= limit, remaining: Math.max(0, limit - entry.count), resetAt: entry.resetAt };
  }

  function evictOne() {
    let oldest = Infinity;
    let oldestKey = null;
    for (const [key, entry] of store) {
      if (entry.resetAt < oldest) {
        oldest = entry.resetAt;
        oldestKey = key;
      }
    }
    if (oldestKey) store.delete(oldestKey);
  }

  function record(key, max) {
    const limit = max ?? maxFailures;
    const t = now();
    const entry = store.get(key);

    if (!entry || t >= entry.resetAt) {
      if (store.size >= maxEntries) evictOne();
      store.set(key, { count: 1, resetAt: t + windowMs });
      return 1;
    }

    entry.count++;
    return entry.count;
  }

  function clearKey(key) {
    store.delete(key);
  }

  function clearPrefix(prefix) {
    for (const key of store.keys()) {
      if (key.startsWith(prefix)) store.delete(key);
    }
  }

  function status(key, max) {
    const limit = max ?? maxFailures;
    const entry = getEntry(key);
    if (!entry) return { remaining: limit, resetAt: 0 };
    return { remaining: Math.max(0, limit - entry.count), resetAt: entry.resetAt };
  }

  function cleanup() {
    const t = now();
    for (const [key, entry] of store) {
      if (t >= entry.resetAt) store.delete(key);
    }
  }

  const interval = setInterval(cleanup, 60_000);
  interval.unref();

  return {
    isBlocked,
    record,
    clearKey,
    clearPrefix,
    status,
    cleanup,
    reset() { store.clear(); },
    get size() { return store.size; },
    get maxFailures() { return maxFailures; },
    get maxEntries() { return maxEntries; },
    get _now() { return now; },
    _getEntry(key) {
      const e = getEntry(key);
      return e ? { count: e.count, resetAt: e.resetAt } : null;
    },
    destroy() { clearInterval(interval); },
  };
}

function sendBlocked(res, limiter, status, route, log, requestId) {
  const retryAfter = Math.ceil(Math.max(0, status.resetAt - limiter._now()) / 1000);
  res.set('Retry-After', String(retryAfter));
  if (log) {
    log.info({ event: 'auth_rate_limited', route, requestId });
  }
  return res.status(429).json({ error: 'too_many_attempts' });
}

export function loginLimiter(rateLimiter, { log } = {}) {
  return (req, res, next) => {
    const ipKey = `ip:${req.ip}`;
    const ipLimit = rateLimiter.maxFailures * 3;
    const username = req.valid?.username?.toLowerCase().trim();
    const userKey = username ? `ip:${req.ip}:login:${username}` : null;

    const ipStatus = rateLimiter.isBlocked(ipKey, ipLimit);
    if (ipStatus.blocked) return sendBlocked(res, rateLimiter, ipStatus, 'login', log, req.requestId);

    if (userKey) {
      const userStatus = rateLimiter.isBlocked(userKey);
      if (userStatus.blocked) return sendBlocked(res, rateLimiter, userStatus, 'login', log, req.requestId);
    }

    const originalJson = res.json.bind(res);
    res.json = function (body) {
      if (res.statusCode === 200) {
        if (userKey) rateLimiter.clearKey(userKey);
        return originalJson(body);
      }

      if (res.statusCode === 401 && body?.error === 'invalid_credentials') {
        rateLimiter.record(ipKey, ipLimit);
        if (userKey) rateLimiter.record(userKey);
      }

      return originalJson(body);
    };

    next();
  };
}

export function changePasswordLimiter(rateLimiter, { log } = {}) {
  return (req, res, next) => {
    const userKey = `user:${req.user.sub}:change-password`;

    const userStatus = rateLimiter.isBlocked(userKey);
    if (userStatus.blocked) return sendBlocked(res, rateLimiter, userStatus, 'change-password', log, req.requestId);

    const originalJson = res.json.bind(res);
    res.json = function (body) {
      if (res.statusCode === 200) {
        rateLimiter.clearKey(userKey);
        return originalJson(body);
      }

      if (res.statusCode === 401 && body?.error === 'invalid_credentials') {
        rateLimiter.record(userKey);
      }

      return originalJson(body);
    };

    next();
  };
}
