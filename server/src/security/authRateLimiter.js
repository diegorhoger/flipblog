export function createLoginRateLimiter({ maxFailures = 5, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
  const store = new Map();

  function tryConsume(key, max) {
    const limit = max ?? maxFailures;
    const entry = store.get(key);
    const t = now();
    if (!entry || t >= entry.resetAt) {
      store.set(key, { count: 1, resetAt: t + windowMs });
      return true;
    }
    if (entry.count >= limit) return false;
    entry.count++;
    return true;
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
    const entry = store.get(key);
    const t = now();
    if (!entry || t >= entry.resetAt) {
      if (entry) store.delete(key);
      return { remaining: limit, resetAt: 0 };
    }
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

  return { tryConsume, clearKey, clearPrefix, status, cleanup, _store: store, _maxFailures: maxFailures };
}

export function loginLimiter(rateLimiter, { log } = {}) {
  return (req, res, next) => {
    const ipKey = `ip:${req.ip}`;
    const ipMaxFailures = rateLimiter._maxFailures * 3;
    const userKey = req.valid?.username
      ? `ip:${req.ip}:login:${req.valid.username.toLowerCase().trim()}`
      : null;

    // Check if either key is over the limit. tryConsume pre-allocates a slot if
    // under the limit; if over, the request is marked as rate-limited and we
    // proceed to the handler anyway — a legitimate user with correct credentials
    // must always be able to log in even after hitting the limit.
    const ipAllowed = rateLimiter.tryConsume(ipKey, ipMaxFailures);
    const userAllowed = userKey ? rateLimiter.tryConsume(userKey) : true;
    const overLimit = !ipAllowed || !userAllowed;

    const originalJson = res.json.bind(res);
    res.json = function (body) {
      if (res.statusCode === 200) {
        // Successful authentication: clear the rate-limit state for this IP and
        // user so the user is not penalised for previous wrong attempts.
        rateLimiter.clearKey(ipKey);
        if (userKey) rateLimiter.clearKey(userKey);
        return originalJson(body);
      }

      if (res.statusCode === 401 && overLimit) {
        // Authentication failed while over the limit: return 429 instead so the
        // client sees a rate-limit error, not a credential hint.
        const ipStatus = rateLimiter.status(ipKey, ipMaxFailures);
        const userStatus = userKey ? rateLimiter.status(userKey) : ipStatus;
        const resetAt = Math.max(ipStatus.resetAt, userStatus.resetAt);
        const retryAfter = Math.ceil(Math.max(0, resetAt - Date.now()) / 1000);
        res.set('Retry-After', String(retryAfter));

        if (log) {
          log.info({ event: 'auth_rate_limited', route: 'login', requestId: req.requestId });
        }

        res.statusCode = 429;
        return originalJson({ error: 'too_many_attempts' });
      }

      return originalJson(body);
    };

    next();
  };
}

export function changePasswordLimiter(rateLimiter, { log } = {}) {
  return (req, res, next) => {
    const userKey = `user:${req.user.sub}:change-password`;

    const allowed = rateLimiter.tryConsume(userKey);
    const overLimit = !allowed;

    const originalJson = res.json.bind(res);
    res.json = function (body) {
      if (res.statusCode === 200) {
        rateLimiter.clearKey(userKey);
        return originalJson(body);
      }

      if (res.statusCode === 401 && overLimit) {
        const s = rateLimiter.status(userKey);
        const retryAfter = Math.ceil(Math.max(0, s.resetAt - Date.now()) / 1000);
        res.set('Retry-After', String(retryAfter));

        if (log) {
          log.info({ event: 'auth_rate_limited', route: 'change-password', requestId: req.requestId });
        }

        res.statusCode = 429;
        return originalJson({ error: 'too_many_attempts' });
      }

      return originalJson(body);
    };

    next();
  };
}
