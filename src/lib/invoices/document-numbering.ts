/**
 * Gapless document numbering + create-dedup helpers.
 * Phase 2 of the idempotency initiative — see docs/IDEMPOTENCY_PLAN.md.
 *
 * ALL functions here MUST run inside the invoice module transaction
 * (InvoiceModuleService.withTransaction → sharedContext.transactionManager),
 * sharing one physical transaction with the pos_invoice insert. That is what
 * makes numbering gapless: incrementing a counter row with `UPDATE ... RETURNING`
 * takes a row lock AND rolls back with the transaction, so a failed insert never
 * advances (nor burns) a number — no `SELECT ... FOR UPDATE` + conditional
 * second write needed once everything is in the same tx.
 */

import { createHash } from "crypto";

/** Minimal structural view of the MikroORM EntityManager we use (raw SQL only). */
export interface TxManager {
  execute<T = unknown>(sql: string, params?: unknown[]): Promise<T>;
}

/** Stable content fingerprint of an invoice-create request (order-scoped). */
export function buildInvoiceRequestHash(input: {
  order_id: string;
  customer_id: string;
  fulfillment_id?: string | null;
  is_sales_receipt: boolean;
  amount_paid: number;
  total: number;
  payment_method?: string | null;
  items: Array<{
    sku?: string | null;
    variant_id?: string | null;
    description?: string;
    quantity: number;
    unit_price: number;
    total: number;
  }>;
}): string {
  const canonical = JSON.stringify({
    o: input.order_id,
    c: input.customer_id,
    f: input.fulfillment_id ?? null,
    sr: input.is_sales_receipt,
    ap: Math.round(input.amount_paid),
    t: Math.round(input.total),
    pm: input.payment_method ?? null,
    // Order-independent so item reordering doesn't defeat the fingerprint.
    i: input.items
      .map((it) => ({
        s: it.sku ?? it.variant_id ?? it.description ?? "",
        q: Number(it.quantity),
        u: Math.round(it.unit_price),
        t: Math.round(it.total),
      }))
      .sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : a.q - b.q)),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Resolve the dedup key for a create attempt. Priority:
 *   1. explicit Idempotency-Key header  (primary contract — multiple invoices
 *      per order are legitimate, so the client owns the intent boundary)
 *   2. terminal_payment_id              (a terminal capture maps to ONE invoice)
 *   3. content fingerprint              (fallback for legacy/non-POS callers)
 * `requestHash` is always the content fingerprint, used to detect same-key /
 * different-payload conflicts.
 */
export function resolveInvoiceDedupKey(opts: {
  idempotencyKeyHeader?: string | null;
  terminalPaymentId?: string | null;
  requestHash: string;
}): string {
  const header = opts.idempotencyKeyHeader?.trim();
  if (header) return `header:${header}`;
  if (opts.terminalPaymentId) return `terminal:${opts.terminalPaymentId}`;
  return `fingerprint:${opts.requestHash}`;
}

/** Counter names seeded by migration 1779500000000. */
export type CounterName = "medusa_invoice" | "qb_invoice" | "qb_sales_receipt";

/**
 * Atomically advance a counter row and return the new value as a number.
 * Row-locks via UPDATE; rolls back with the surrounding transaction.
 */
export async function allocateNextNumber(
  em: TxManager,
  name: CounterName
): Promise<number> {
  const rows = await em.execute<Array<{ value: string | number }>>(
    `UPDATE document_number_counter
       SET value = value + 1, updated_at = now()
     WHERE name = ?
     RETURNING value`,
    [name]
  );
  const first = rows?.[0];
  if (!first) {
    throw new Error(
      `[document-numbering] counter '${name}' is missing — run migration 1779500000000 / re-seed`
    );
  }
  return Number(first.value);
}

export type DedupOutcome =
  | { status: "claimed" } // first attempt — caller proceeds to create
  | { status: "existing"; invoiceId: string } // replay — return this invoice
  | { status: "in_progress" } // committed claim with no invoice_id → stale/orphan; caller 409s
  | { status: "conflict" }; // same key, different request → 409

/**
 * Claim a create-attempt for `dedupKey` inside the transaction, BEFORE number
 * allocation.
 *
 * - First attempt inserts the row and returns `claimed`.
 * - A replay of a COMPLETED attempt (row already has invoice_id) returns
 *   `existing` so the caller returns the original invoice instead of minting a
 *   new one.
 * - Same key with a different `requestHash` returns `conflict` (HTTP 409).
 *
 * Concurrency: the ON-CONFLICT branch takes `FOR UPDATE` on the existing row,
 * which blocks on any in-flight sibling transaction holding that key. When the
 * sibling commits with an invoice_id we return `existing`; if it rolled back,
 * its inserted row is gone and we re-claim. Callers should treat a thrown
 * serialization error as a safe retry.
 */
export async function claimInvoiceCreate(
  em: TxManager,
  dedupKey: string,
  requestHash: string
): Promise<DedupOutcome> {
  const inserted = await em.execute<Array<{ dedup_key: string }>>(
    `INSERT INTO invoice_create_attempt (dedup_key, request_hash)
     VALUES (?, ?)
     ON CONFLICT (dedup_key) DO NOTHING
     RETURNING dedup_key`,
    [dedupKey, requestHash]
  );

  if (inserted?.length) {
    return { status: "claimed" };
  }

  // Row already existed — inspect it under a row lock.
  const existing = await em.execute<
    Array<{ request_hash: string; invoice_id: string | null }>
  >(
    `SELECT request_hash, invoice_id
       FROM invoice_create_attempt
      WHERE dedup_key = ?
      FOR UPDATE`,
    [dedupKey]
  );

  const row = existing?.[0];
  if (!row) {
    // Sibling rolled back between our INSERT and SELECT — re-claim.
    return claimInvoiceCreate(em, dedupKey, requestHash);
  }
  if (row.request_hash !== requestHash) return { status: "conflict" };
  if (row.invoice_id) {
    return { status: "existing", invoiceId: row.invoice_id };
  }
  // Row exists, same payload, but has NO invoice_id. The SELECT ... FOR UPDATE
  // above already waited for any in-flight sibling to commit or roll back: a
  // rolled-back sibling leaves no row (handled above), so a committed row with
  // a null invoice_id is a STALE/orphaned claim (a prior attempt that died
  // after claiming but before finalizing). Refuse to double-create — the caller
  // surfaces this as a retryable conflict; a pruning job recycles stale claims.
  return { status: "in_progress" };
}

/**
 * Stamp the created invoice id onto the claim so future replays short-circuit.
 * Fails CLOSED: if no row matches (wrong key, hash mismatch, missing claim) it
 * throws, which rolls back the whole transaction rather than committing an
 * invoice with no durable dedup pointer.
 */
export async function finalizeInvoiceCreate(
  em: TxManager,
  dedupKey: string,
  requestHash: string,
  invoiceId: string
): Promise<void> {
  const rows = await em.execute<Array<{ dedup_key: string }>>(
    `UPDATE invoice_create_attempt
        SET invoice_id = ?, updated_at = now()
      WHERE dedup_key = ? AND request_hash = ?
      RETURNING dedup_key`,
    [invoiceId, dedupKey, requestHash]
  );
  if (!rows?.length) {
    throw new Error(
      `[document-numbering] failed to finalize create claim for '${dedupKey}' (no matching row)`
    );
  }
}
