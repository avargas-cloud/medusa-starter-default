/**
 * Recognising MeiliSearch's errors, which is less obvious than it looks.
 *
 * `MeiliSearchApiError` in this client version carries NOTHING useful at the top
 * level — its own keys are `name`, `cause` and `response`. The machine-readable
 * code is on `err.cause.code` and the HTTP status on `err.response.status`.
 *
 * Verified against the live client 2026-07-29:
 *   err.code                → undefined
 *   err.httpStatus          → undefined
 *   err.cause.code          → "index_not_found" / "document_not_found"
 *   err.response.status     → 404
 *
 * Both of the obvious guesses are the undefined ones, so a check written from
 * memory silently never matches — and a never-matching check on an error path
 * turns into a capability the code claims to have and does not. That has already
 * happened twice in this codebase, so the shape lives here once and gets probed
 * against the real client rather than assumed.
 */

interface MeiliErrorShape {
  code?: unknown;
  httpStatus?: unknown;
  cause?: { code?: unknown };
  response?: { status?: unknown };
}

function meiliCode(err: unknown): string | undefined {
  const e = err as MeiliErrorShape;
  // Tolerate the top-level spellings too: they are undefined today, but a client
  // upgrade that starts populating them should not silently stop matching.
  const code = e?.cause?.code ?? e?.code;
  return typeof code === "string" ? code : undefined;
}

function meiliStatus(err: unknown): number | undefined {
  const e = err as MeiliErrorShape;
  const status = e?.response?.status ?? e?.httpStatus;
  return typeof status === "number" ? status : undefined;
}

/** The whole index is absent — typically a sandbox that was restored but never synced. */
export function isIndexNotFound(err: unknown): boolean {
  return meiliCode(err) === "index_not_found";
}

/**
 * The index exists and this one document does not.
 *
 * For a reconciler this is drift, not a failure: the database has a row and the
 * index has no document for it, which is precisely what needs healing.
 */
export function isDocumentNotFound(err: unknown): boolean {
  return meiliCode(err) === "document_not_found" || meiliStatus(err) === 404;
}
