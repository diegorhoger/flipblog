import { generateRequestId, isValidRequestId } from '../logging.js';

// Attaches a request id to every request and echoes it back on the response via
// `X-Request-ID`, so a client-visible `internal_error` can be correlated to the
// exact server log line. If the caller supplies its own `X-Request-ID` we reuse
// it only when it is well-formed (strict pattern); an invalid value is discarded
// and replaced with a freshly generated id to keep logs/headers free of injected
// control characters.
export function requestId({ log } = {}) {
  return (req, res, next) => {
    const incoming = req.headers['x-request-id'];
    const id = isValidRequestId(incoming) ? incoming : generateRequestId();
    req.requestId = id;
    res.set('X-Request-ID', id);

    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      log?.info?.({
        requestId: id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Number(ms.toFixed(1)),
      });
    });
    next();
  };
}
