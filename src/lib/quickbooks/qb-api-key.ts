/**
 * The QuickBooks bridge API key, or a failure that says what is missing.
 *
 * Until 2026-07-29 every caller wrote `process.env.QB_API_KEY || "<literal>"` with
 * the real key inlined as the fallback — 73 tracked files across the `backend` and
 * `quickbooks-bridge` repos, all on GitHub. Removing those literals is what makes
 * the pending rotation non-destructive: before, rotating would have broken every
 * one of them.
 *
 * Dropping the fallback turned the type into `string | undefined`, and tsc caught
 * eleven call sites that build a header from it. The tempting fix is `?? ""`, which
 * type-checks and is wrong in a specific way: an empty key makes the bridge answer
 * 401, which reads like a bridge auth problem rather than "nobody set the variable".
 * This codebase has been bitten by that exact shape three separate times in one day
 * — a swallowed drift_log insert, a 404 check that never matched, a secret scanner
 * that printed secrets — so the error names the cause instead.
 *
 * Called at USE time, never at module load: the sandbox and local dev run with the
 * bridge disabled and no key set, and a module-scope throw would take the boot down
 * on a path that never talks to QuickBooks.
 */
export function requireQbApiKey(): string {
  const key = process.env.QB_API_KEY
  if (!key) {
    throw new Error(
      'QB_API_KEY is not set — refusing to call the QuickBooks bridge without a key. ' +
        'It belongs in backend/.env locally and in the Railway service variables in production.',
    )
  }
  return key
}
