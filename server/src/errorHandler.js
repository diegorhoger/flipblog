import { ApiError } from './errors.js';

// Central error handler factory. It draws a hard line between three kinds of
// failure:
//
//   * Known, client-facing errors (ApiError): validation, auth, lookup and
//     conflict problems. These carry an explicit status + a stable, safe code
//     that we surface as-is (with optional validation `details`).
//   * Client request-parsing errors raised by `express.json()` before any route
//     runs: malformed JSON and oversized bodies. These are bad requests, not
//     server faults, so they map to fixed safe codes (400/413) — never the
//     parser's message or the offending body.
//   * Everything else: unexpected application/database failures (raw Errors,
//     SQLite exceptions, filesystem errors, bugs). These are correlated with the
//     request id (set by the requestId middleware) and logged via the injected
//     logger as a generic `internal_error`, but never leak the underlying
//     message, stack trace, SQL text, filenames, or filesystem paths to the
//     client.
//
// Taking `log` as a parameter keeps this pure and testable without global state.
export function createErrorHandler(log) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (err instanceof ApiError) {
      const body = { error: err.code };
      if (err.details !== undefined) body.details = err.details;
      return res.status(err.status).json(body);
    }
    // body-parser (express.json) surfaces client-input problems via `err.type`.
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid_json' });
    }
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload_too_large' });
    }
    log.error(
      {
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        code: 'internal_error',
      },
      err
    );
    res.status(500).json({ error: 'internal_error' });
  };
}
