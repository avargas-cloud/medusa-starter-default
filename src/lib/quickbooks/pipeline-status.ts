/**
 * src/lib/quickbooks/pipeline-status.ts
 *
 * THE vocabulary of every `qb_*_pipeline` row and of `qb_sync_log`
 * (plan qb-pipeline-status-vocab-20260917). Nine values, one per meaning:
 *
 *   waiting     queued, dispatchable now
 *   blocked     parked — behind `depends_on`, or a time rule (SO hold)
 *   processing  claimed by a worker
 *   submitted   at the bridge, not yet confirmed by QuickBooks
 *   synced      confirmed in QuickBooks (also: mod applied, void applied)
 *   error       failed, retry SCHEDULED (`next_retry_at` is always set)
 *   failed      terminal — needs a human (Retry / Mark fixed)
 *   skipped     abandoned on purpose (superseded, dependency skipped, cancel)
 *   fixed       resolved by hand (Mark fixed)
 *
 * Before this plan there were four vocabularies for the same nine meanings:
 *   sales      pending/waiting/confirmed/failed(+next_retry_at)
 *   purchases  failed_permanent/cancelled, mod `completed`, void `voided`
 *   sync log   completed
 * `LEGACY_STATUS_ALIASES` is the translation table; nothing else in `src/`
 * may spell a status literal — `verify-qb-pipeline-status-vocab.ts` fails on
 * any literal outside this file.
 *
 * Cutover (expand/contract, no QB_SYNC pause — pausing DROPS enqueues):
 *   VOCAB_PHASE = "expand"    code reads BOTH vocabularies and writes the new
 *                             one, except sales dispatchable which stays
 *                             `pending`: the legacy sales `waiting` means
 *                             BLOCKED, so `waiting` cannot be written as
 *                             dispatchable until every legacy row is converted.
 *   convert script            rewrites rows (sales waiting→blocked, …)
 *   VOCAB_PHASE = "contract"  single literals; sales dispatchable = `waiting`.
 *                             `pending` stays readable for the ≤8 min the
 *                             expand build keeps writing it during the deploy;
 *                             the consolidator sweeps it to `waiting`.
 */

export const PIPELINE_STATUSES = [
  "waiting",
  "blocked",
  "processing",
  "submitted",
  "synced",
  "error",
  "failed",
  "skipped",
  "fixed",
] as const;

export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

export type PipelineFamily = "sales" | "purchase" | "log";

/** Flip to "contract" in the second deploy, after the conversion script. */
export const VOCAB_PHASE: "expand" | "contract" = "expand";

const EXPAND = VOCAB_PHASE === "expand";

/**
 * Legacy literal → canonical meaning, per family. Sales `failed` is missing on
 * purpose: its meaning depends on `next_retry_at` (see `normalizePipelineStatus`).
 */
export const LEGACY_STATUS_ALIASES: Record<
  PipelineFamily,
  Readonly<Record<string, PipelineStatus>>
> = {
  sales: {
    pending: "waiting",
    waiting: "blocked",
    confirmed: "synced",
  },
  purchase: {
    failed_permanent: "failed",
    cancelled: "skipped",
    completed: "synced", // mod_status
    voided: "synced", // void_status
  },
  log: {
    completed: "synced",
  },
};

export function isPipelineStatus(value: unknown): value is PipelineStatus {
  return (
    typeof value === "string" &&
    (PIPELINE_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Canonical status of a row, whatever vocabulary it was written in.
 * Unknown literals come back unchanged as a string so callers can surface them
 * instead of silently mapping them to something.
 */
export function normalizePipelineStatus(
  family: PipelineFamily,
  raw: string | null | undefined,
  nextRetryAt?: Date | string | null
): PipelineStatus | string {
  if (raw == null) return "";
  if (family === "sales" && raw === "failed") {
    return nextRetryAt ? "error" : "failed";
  }
  if (family === "sales" && raw === "waiting" && !EXPAND) {
    // After contract the literal is canonical (dispatchable).
    return "waiting";
  }
  const alias = LEGACY_STATUS_ALIASES[family][raw];
  if (alias) return alias;
  return raw;
}

export function pipelineStatusIs(
  family: PipelineFamily,
  row: { status: string | null; next_retry_at?: Date | string | null },
  ...wanted: PipelineStatus[]
): boolean {
  const n = normalizePipelineStatus(family, row.status, row.next_retry_at);
  return (wanted as string[]).includes(n as string);
}

// ── SQL fragments ──────────────────────────────────────────────────────────
// Already-quoted, comma-joined literal lists for `status IN (...)`. These are
// the ONLY status literals allowed in SQL anywhere in src/. They interpolate
// into template strings (no user input, so no binding needed) and work with
// both knex.raw (`?`) and pg (`$1`) call sites.

const q = (...lits: string[]) => lits.map((l) => `'${l}'`).join(", ");

/** The literals of a SQL list as a JS array — for `.includes()` checks that cannot use SQL. */
export function literalsOf(list: string): readonly string[] {
  return list.split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
}

/** Sales (`qb_order_pipeline`). */
export const SALES_SQL = {
  /** Rows the dispatcher may claim now (also honour `next_retry_at` on them). */
  dispatchable: EXPAND ? q("pending") : q("waiting", "pending"),
  /** Parked behind `depends_on` or a time rule. */
  blocked: EXPAND ? q("blocked", "waiting") : q("blocked"),
  processing: q("processing"),
  submitted: q("submitted"),
  synced: EXPAND ? q("synced", "confirmed") : q("synced"),
  /** Confirmed-or-resolved: what a dependent row waits for. */
  done: EXPAND ? q("synced", "confirmed", "fixed") : q("synced", "fixed"),
  skipped: q("skipped"),
  fixed: q("fixed"),
  /** Any status that means "this row may still reach QuickBooks". */
  inFlight: EXPAND
    ? q("pending", "processing", "submitted", "waiting", "blocked")
    : q("waiting", "pending", "processing", "submitted", "blocked"),
  /** `error` OR legacy `failed`-with-backoff. Pair with `retryDue()`. */
  retryable: EXPAND ? q("error", "failed") : q("error"),
  /** Terminal failure literal (pair with `salesTerminal()` in expand). */
  failed: q("failed"),
  /** Any failed attempt, retrying or terminal (retry_count bumps, claim reuse). */
  failedAny: q("error", "failed"),
  /** What a UNIQUE "live row" index must exclude. */
  notLive: q("failed", "skipped"),
} as const;

/** Predicate: a sales row whose retry is due. `a` = table alias with dot, or "". */
export function salesRetryDue(a = ""): string {
  return `(${a}status IN (${SALES_SQL.retryable}) AND ${a}next_retry_at IS NOT NULL AND ${a}next_retry_at <= NOW())`;
}

/** Predicate: a sales row that is retrying (due or not). */
export function salesRetrying(a = ""): string {
  return EXPAND
    ? `(${a}status IN (${SALES_SQL.retryable}) AND ${a}next_retry_at IS NOT NULL)`
    : `(${a}status = 'error')`;
}

/** Predicate: a sales row that is terminally failed (needs a human). */
export function salesTerminal(a = ""): string {
  return EXPAND
    ? `(${a}status = 'failed' AND ${a}next_retry_at IS NULL)`
    : `(${a}status = 'failed')`;
}

/** Purchases family (PO, item receipt, vendor bill, item, vendor, inventory adjustment). */
export const PURCHASE_SQL = {
  dispatchable: q("waiting"),
  processing: q("processing"),
  submitted: q("submitted"),
  synced: q("synced"),
  /** `mod_status` success. */
  modSynced: EXPAND ? q("synced", "completed") : q("synced"),
  /** `void_status` success. */
  voidSynced: EXPAND ? q("synced", "voided") : q("synced"),
  error: q("error"),
  failed: EXPAND ? q("failed", "failed_permanent") : q("failed"),
  skipped: EXPAND ? q("skipped", "cancelled") : q("skipped"),
  fixed: q("fixed"),
  /** Any failed attempt, retrying or terminal. */
  failedAny: EXPAND ? q("error", "failed", "failed_permanent") : q("error", "failed"),
  /** Open = will still be worked by a cron. */
  open: q("waiting", "error"),
  inFlight: q("waiting", "processing", "submitted", "error"),
  /** Terminal, not a success. */
  dead: EXPAND
    ? q("failed", "failed_permanent", "skipped", "cancelled")
    : q("failed", "skipped"),
} as const;

/** `qb_sync_log`. */
export const LOG_SQL = {
  synced: EXPAND ? q("synced", "completed") : q("synced"),
  failed: q("failed"),
} as const;

// ── Literals to WRITE ──────────────────────────────────────────────────────

export const WRITE = {
  sales: {
    dispatchable: (EXPAND ? "pending" : "waiting") as "pending" | "waiting",
    blocked: "blocked" as const,
    processing: "processing" as const,
    submitted: "submitted" as const,
    synced: "synced" as const,
    error: "error" as const,
    failed: "failed" as const,
    skipped: "skipped" as const,
    fixed: "fixed" as const,
  },
  purchase: {
    dispatchable: "waiting" as const,
    processing: "processing" as const,
    submitted: "submitted" as const,
    synced: "synced" as const,
    error: "error" as const,
    failed: "failed" as const,
    skipped: "skipped" as const,
    fixed: "fixed" as const,
  },
  log: {
    synced: "synced" as const,
    failed: "failed" as const,
  },
} as const;

/**
 * Every literal a DB CHECK constraint must accept during the expand phase
 * (canonical + every legacy spelling), per column kind.
 */
export const CHECK_LITERALS = {
  expand: {
    sales: [...PIPELINE_STATUSES, "pending", "confirmed", "manual"],
    purchaseStatus: [...PIPELINE_STATUSES, "failed_permanent", "cancelled"],
    purchaseMod: [...PIPELINE_STATUSES, "completed", "failed_permanent"],
    purchaseVoid: [...PIPELINE_STATUSES, "voided"],
    log: [...PIPELINE_STATUSES, "completed"],
  },
  contract: {
    /** `pending` stays until the post-contract sweep; sealed in the next deploy. */
    sales: [...PIPELINE_STATUSES, "pending", "manual"],
    purchaseStatus: [...PIPELINE_STATUSES],
    purchaseMod: [...PIPELINE_STATUSES],
    purchaseVoid: [...PIPELINE_STATUSES],
    log: [...PIPELINE_STATUSES],
  },
} as const;

/** Label + tone for badges — one table for the admin UI and the POS. */
export const STATUS_PRESENTATION: Record<
  PipelineStatus,
  { label: string; tone: "grey" | "blue" | "orange" | "green" | "red" | "purple" }
> = {
  waiting: { label: "Waiting", tone: "grey" },
  blocked: { label: "Blocked", tone: "grey" },
  processing: { label: "Processing", tone: "blue" },
  submitted: { label: "Submitted", tone: "blue" },
  synced: { label: "Synced", tone: "green" },
  error: { label: "Retrying", tone: "orange" },
  failed: { label: "Failed", tone: "red" },
  skipped: { label: "Skipped", tone: "grey" },
  fixed: { label: "Fixed", tone: "purple" },
};
