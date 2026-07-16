/**
 * upsert-order-only-application.ts
 *
 * SINGLE creation point for order-only payment_application rows (invoice_id
 * IS NULL) on an EXISTING payment. Enforces the invariant behind the partial
 * unique index UQ_payment_application_order_only_active: at most ONE active
 * order-only row per (payment_id, order_id).
 *
 * Semantics:
 *   - no active row      → CREATE (as before)
 *   - active row exists  → INCREMENT its amount_applied (a second legitimate
 *     link to the same order merges into the reservation instead of stacking
 *     a duplicate row — which the unique index would reject)
 *   - link_intent_key already recorded on the row → REPLAY (no-op): a retry
 *     of the same intent must never double-increment.
 *   - unique-violation race (two concurrent creates) → the loser catches
 *     23505, re-reads the winner's row, and increments it.
 *
 * Intent keys are recorded as a `link_intent_keys` OBJECT map (key → cents),
 * not an array: Medusa's update* deep-merges JSONB metadata, so adding an
 * object key persists reliably while array appends do not (2026-05-30 rule).
 * The creation-time `link_intent_key` scalar is kept for back-compat with the
 * route-level replay check.
 *
 * Callers that create the application on a BRAND-NEW payment (refund/web
 * capture subscribers) do not need this helper — a fresh payment_id cannot
 * collide.
 */
import { getNum } from "../../api/admin/invoices/payment-balance";

export interface UpsertOrderOnlyArgs {
  financeService: any;
  knex: any; // __pg_connection__ (positional `?` bindings)
  payment_id: string;
  order_id: string;
  amount_cents: number;
  applied_by: string | null;
  cost_snapshot?: unknown | null;
  link_intent_key?: string | null;
}

export interface UpsertOrderOnlyResult {
  mode: "created" | "incremented" | "replayed";
  application: any;
}

export function matchesLinkIntent(
  metadata: Record<string, any> | null | undefined,
  key: string | null | undefined
): boolean {
  if (!key || !metadata) return false;
  return (
    metadata.link_intent_key === key ||
    metadata.link_intent_keys?.[key] !== undefined
  );
}

function isUniqueViolation(err: any): boolean {
  const msg = String(err?.message ?? "");
  return (
    err?.code === "23505" ||
    err?.name === "UniqueConstraintViolationException" ||
    /duplicate key value/i.test(msg) ||
    /UQ_payment_application_order_only_active/i.test(msg)
  );
}

async function findActiveRow(
  knex: any,
  payment_id: string,
  order_id: string
): Promise<{ id: string; amount_applied: unknown; metadata: any } | null> {
  const { rows } = await knex.raw(
    `SELECT id, amount_applied::numeric AS amount_applied, metadata
       FROM payment_application
      WHERE payment_id = ? AND order_id = ?
        AND invoice_id IS NULL AND voided_at IS NULL AND deleted_at IS NULL
      ORDER BY created_at ASC
      LIMIT 1`,
    [payment_id, order_id]
  );
  return rows[0] ?? null;
}

export async function upsertOrderOnlyApplication(
  args: UpsertOrderOnlyArgs
): Promise<UpsertOrderOnlyResult> {
  const {
    financeService,
    knex,
    payment_id,
    order_id,
    amount_cents,
    applied_by,
    cost_snapshot,
    link_intent_key,
  } = args;

  const increment = async (existing: {
    id: string;
    amount_applied: unknown;
    metadata: any;
  }): Promise<UpsertOrderOnlyResult> => {
    const newTotal = getNum(existing.amount_applied) + amount_cents;
    const application = await financeService.updatePaymentApplications({
      id: existing.id,
      amount_applied: newTotal,
      // Object-map merge (deep-merge safe) — see header comment.
      ...(link_intent_key
        ? { metadata: { link_intent_keys: { [link_intent_key]: amount_cents } } }
        : {}),
    });
    return { mode: "incremented", application };
  };

  const existing = await findActiveRow(knex, payment_id, order_id);
  if (existing) {
    if (matchesLinkIntent(existing.metadata, link_intent_key)) {
      const application = await financeService.retrievePaymentApplication(
        existing.id
      );
      return { mode: "replayed", application };
    }
    return increment(existing);
  }

  try {
    const application = await financeService.createPaymentApplications({
      payment_id,
      invoice_id: null,
      invoice_number: null,
      order_id,
      amount_applied: amount_cents,
      applied_at: new Date(),
      applied_by: applied_by ?? null,
      cost_snapshot: cost_snapshot ?? null,
      ...(link_intent_key ? { metadata: { link_intent_key } } : {}),
    });
    return { mode: "created", application };
  } catch (err: any) {
    if (!isUniqueViolation(err)) throw err;
    // Concurrent create raced us — the unique index rejected this insert.
    // Merge into the winner's row instead.
    const raced = await findActiveRow(knex, payment_id, order_id);
    if (!raced) throw err; // winner vanished (voided/unlinked mid-race) — surface original error
    if (matchesLinkIntent(raced.metadata, link_intent_key)) {
      const application = await financeService.retrievePaymentApplication(
        raced.id
      );
      return { mode: "replayed", application };
    }
    return increment(raced);
  }
}
