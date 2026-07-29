/**
 * Document quiescence gate for `apply_payment`.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * The apply_payment dependency gates historically asked only "does the document
 * EXIST in QuickBooks yet?" (`if (!paymentTxnId)` / `if (!invoiceTxnId)`). Once
 * a TxnID existed the apply dispatched immediately — even while a MUTATION of
 * that same document was still queued.
 *
 * CM-1105 / Invoice 21215 (2026-07-27) is the incident that proved the gap: an
 * operator shrank a credit memo that was already in QB from $1,036.33 to
 * $150.34. While the corrective `credit_memo_mod` sat in the queue, the
 * `apply_payment` fired and QuickBooks rejected it with Error 3210. The mod
 * landed 2 minutes later; the identical apply would then have succeeded.
 *
 * A sweep of all 68 historical credit-memo applies showed the predicate below
 * separates the incident perfectly: the one failure had a live mutation on its
 * document, the 67 successes had none. So this gate costs nothing in latency.
 *
 * ── Design notes ──────────────────────────────────────────────────────────────
 * - The gate runs immediately BEFORE the bridge call, on every attempt — not
 *   once at enqueue time. A stale answer is worthless here.
 * - It deliberately does NOT use `depends_on`: that column holds a single
 *   parent, and an apply depends on TWO documents (source + target). Modelling
 *   one leaves the other race open. Worse, a parent that ends `skipped` or
 *   `failed` never wakes its child (`runWakeDependentsPass` only accepts
 *   `confirmed`/`fixed`), which has already stranded a row for 23 days.
 * - Liveness is decided in TypeScript (`isLiveOperation`) rather than in SQL so
 *   the rule is unit-testable. The SQL only narrows by document, which is
 *   indexed and returns a handful of rows.
 *
 * This gate cannot see an edit made by a human directly in QuickBooks Desktop.
 * That residual risk is covered by the retry policy on the apply itself.
 */

/** Steps that can change a Credit Memo in QuickBooks. */
export const CREDIT_MEMO_MUTATION_STEPS = [
  "credit_memo",
  "credit_memo_mod",
  "void_credit_memo",
] as const;

/** Steps that can change an Invoice or Sales Receipt in QuickBooks. */
export const INVOICE_MUTATION_STEPS = [
  "invoice",
  "invoice_update",
  "void_invoice",
  "sales_receipt",
  "sales_receipt_update",
  "void_sales_receipt",
] as const;

/** Steps that can change a ReceivePayment in QuickBooks. */
export const PAYMENT_MUTATION_STEPS = [
  "payment",
  "payment_method_change",
  "payment_txndate_change",
  "transfer_payment",
] as const;

/** Statuses in which an operation may still change the document. */
export const LIVE_STATUSES = [
  "waiting",
  "pending",
  "processing",
  "submitted",
] as const;

/**
 * Every step that can mutate a document an apply depends on. Used as a
 * belt-and-suspenders filter on the query result — `apply_payment` is
 * deliberately absent, so an apply can never block another apply.
 */
const MUTATION_STEPS: ReadonlySet<string> = new Set<string>([
  ...CREDIT_MEMO_MUTATION_STEPS,
  ...INVOICE_MUTATION_STEPS,
  ...PAYMENT_MUTATION_STEPS,
]);

export type PipelineOperationRow = {
  id: string;
  step: string;
  status: string;
  reference_id: string | null;
  medusa_ref_number: string | null;
  next_retry_at: Date | string | null;
};

export type QuiescenceBlocker = {
  id: string;
  step: string;
  status: string;
  reference: string | null;
};

/**
 * True when the operation may still mutate its document.
 *
 * `failed` is the subtle case: a failed row WITH `next_retry_at` is still alive
 * (the consolidator will pick it up), while a failed row WITHOUT one is
 * terminal. Blocking on the terminal kind would strand the apply forever behind
 * something nobody is going to run — it already surfaces in the pipeline UI and
 * the error digest on its own.
 */
export function isLiveOperation(row: PipelineOperationRow): boolean {
  if ((LIVE_STATUSES as readonly string[]).includes(row.status)) return true;
  return row.status === "failed" && row.next_retry_at != null;
}

/** Minimal shape of a `pg` pool/client, so tests can pass a fake. */
type Queryable = {
  query(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: PipelineOperationRow[] }>;
};

export type ApplyPaymentBlockerInput = {
  /** `pos_invoice.id` of the document being paid. */
  invoiceId: string;
  /** `customer_payment.reference` (e.g. "CM-1105") for credit-memo payments. */
  creditMemoNumber?: string | null;
  /** `customer_payment.id` for every other payment type. */
  paymentId?: string | null;
  /** The apply row itself, so it never blocks on its own presence. */
  excludeRowId?: string | null;
};

/**
 * Returns the live operations on the source and target documents of an apply.
 * Empty array means both documents are quiescent and the apply may dispatch.
 */
export async function findApplyPaymentBlockers(
  pool: Queryable,
  input: ApplyPaymentBlockerInput
): Promise<QuiescenceBlocker[]> {
  const { rows } = await pool.query(
    `SELECT p.id, p.step, p.status, p.reference_id, p.medusa_ref_number,
            p.next_retry_at
       FROM qb_order_pipeline p
       LEFT JOIN pos_credit_memo cm ON cm.id = p.reference_id
      WHERE (
              -- Target document: the invoice being paid.
              (p.step = ANY($1::text[]) AND p.reference_id = $2)
              -- Source document: the credit memo the credit came from.
              OR ($3::text IS NOT NULL
                  AND p.step = ANY($4::text[])
                  AND cm.credit_memo_number = $3)
              -- Source document: the ReceivePayment being merged into.
              OR ($5::text IS NOT NULL
                  AND p.step = ANY($6::text[])
                  AND p.reference_id = $5)
            )
        -- p.id is uuid: compare as text so the parameter never has to be
        -- inferred as uuid (a bare "$n::text" on one side makes Postgres reject
        -- the whole statement with "operator does not exist: uuid <> text").
        AND ($7::text IS NULL OR p.id::text <> $7::text)`,
    [
      INVOICE_MUTATION_STEPS,
      input.invoiceId,
      input.creditMemoNumber ?? null,
      CREDIT_MEMO_MUTATION_STEPS,
      input.paymentId ?? null,
      PAYMENT_MUTATION_STEPS,
      input.excludeRowId ?? null,
    ]
  );

  // The SQL already excludes the caller's own row and any non-mutation step;
  // both are re-checked here so the invariant holds no matter how the rows were
  // obtained. An apply must never be able to block an apply.
  return rows
    .filter((r) => r.id !== input.excludeRowId)
    .filter((r) => MUTATION_STEPS.has(r.step))
    .filter(isLiveOperation)
    .map((r) => ({
      id: r.id,
      step: r.step,
      status: r.status,
      reference: r.medusa_ref_number,
    }));
}

/** One-line, operator-readable summary of why an apply is waiting. */
export function describeBlockers(blockers: QuiescenceBlocker[]): string {
  return blockers
    .map((b) => `${b.step}${b.reference ? ` (${b.reference})` : ""} [${b.status}]`)
    .join(", ");
}

/** How long to sit out before re-checking whether the documents went quiet. */
export const QUIESCENCE_RECHECK_SECONDS = 45;

/**
 * Upper bound on deferral. Past this, the apply stops waiting and fails
 * VISIBLY so a human looks at it — it never dispatches anyway. Forcing the ADD
 * through after a timeout would trade a visible block for an accounting risk.
 */
export const QUIESCENCE_MAX_WAIT_MS = 15 * 60 * 1000;

/**
 * True when an apply has been deferred longer than the allowed window.
 *
 * A missing timestamp means this is the first deferral → keep waiting. An
 * unparseable one means the stamp is corrupt: give up rather than defer
 * forever, since a silently sleeping row is exactly the failure mode this
 * whole gate exists to avoid.
 */
export function hasWaitedTooLong(
  since: Date | string | null | undefined,
  now: Date = new Date(),
  maxWaitMs: number = QUIESCENCE_MAX_WAIT_MS
): boolean {
  if (since == null) return false;
  const startedAt = since instanceof Date ? since : new Date(since);
  if (Number.isNaN(startedAt.getTime())) return true;
  return now.getTime() - startedAt.getTime() > maxWaitMs;
}
