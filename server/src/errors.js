// Central error taxonomy for the API.
//
// `ApiError` represents a *known*, client-facing failure: a validation problem,
// an authentication/authorization rejection, a missing resource, a conflict, and
// so on. It carries an explicit HTTP `status` and a stable, safe `code` that is
// returned to the client verbatim as `{ error: code }` (plus optional `details`).
//
// The `expose === true` marker is what the central error handler keys off of: an
// `ApiError` is intentionally surfaced to the client, whereas *any other* thrown
// value (a raw `Error`, a SQLite exception, a filesystem error, a programming
// bug) is treated as an unexpected server failure. Those are collapsed into a
// generic `500 internal_error` and never leak the underlying message, stack
// trace, SQL text, filenames, or filesystem paths.
export class ApiError extends Error {
  constructor(status, code, { details } = {}) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    // A stable, machine-readable, safe-to-expose code (never raw exception text).
    this.code = code;
    // Signals to the central handler that this error is safe to surface as-is.
    this.expose = true;
    if (details !== undefined) this.details = details;
  }
}

// Convenience constructors for the statuses the API actually uses. Each defaults
// to a conventional code but accepts an explicit one for more specific cases.
export const badRequest = (code = 'bad_request', details) => new ApiError(400, code, { details });
export const unauthorized = (code = 'unauthorized') => new ApiError(401, code);
export const forbidden = (code = 'forbidden') => new ApiError(403, code);
export const notFound = (code = 'not_found') => new ApiError(404, code);
export const conflict = (code = 'conflict') => new ApiError(409, code);
