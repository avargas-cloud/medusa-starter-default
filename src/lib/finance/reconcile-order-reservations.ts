/**
 * reconcile-order-reservations.ts
 *
 * "El POS order define el monto linkeado": the single rule that keeps
 * order-only payment reservations (invoice_id IS NULL) in sync with the
 * order's real balance.
 *
 *   allowed  = max(0, orderTotal − invoiceBoundApplied)   (0 if canceled)
 *   excess   = orderOnlyLinked − allowed  → AUTO-CLAMP (release back to the
 *              payment's available pool; LIFO — newest link cedes first)
 *   gap      = allowed − orderOnlyLinked  → surfaced to the POS so it can
 *              OFFER covering the increase with available credit (never
 *              auto-links; the operator confirms via the Cover-with-Credit
 *              modal).
 *
 * Order total source of truth: `order.metadata.pos_total` (DOLLARS, persisted
 * by post-edit-sync) — falls back to Medusa order.total (cents) when absent.
 *
 * NEVER touches (they are permanent ledger rows, not reservations):
 *   - web-capture applications (customer_payment.source = 'web' — web sales
 *     stay order-only forever to feed Treasury)
 *   - refund tracking applications (customer_payment.type = 'refund')
 *
 * Releases are audit-logged on the payment's metadata under
 * `auto_clamp_releases` (object map — deep-merge safe) and are recoverable:
 * the money returns to the payment's available balance, and the increase-gap
 * prompt re-offers it if the order grows again.
 *
 * Safety note: this is HYGIENE, not the money-safety layer — CONVERT-ON-APPLY
 * already clamps at consume time, so a missed/late reconcile can never cause
 * an overcharge.
 */
import { getNum } from "../../api/admin/invoices/payment-balance";
import { FINANCE_MODULE } from "../../modules/finance";

const EPSILON_CENTS = 100; // tolerate <$1 drift between pos_total and order.total

export interface OrderReservationState {
  order_status: string;
  order_total_cents: number;
  invoice_bound_cents: number;
  order_only_cents: number;
  allowed_cents: number;
  excess_cents: number;
  gap_cents: number;
  /** true when neither pos_total nor order.total was resolvable — clamp and
   *  link-time caps must FAIL OPEN (skip) rather than treat allowed as 0. */
  total_unknown: boolean;
}

export interface ReconcileResult {
  state: OrderReservationState;
  released_cents: number;
  released: Array<{
    application_id: string;
    payment_id: string;
    released_cents: number;
    deleted: boolean;
  }>;
}

interface Scope {
  resolve: (key: string) => any;
}

async function loadState(
  scope: Scope,
  orderId: string
): Promise<{
  state: OrderReservationState;
  rows: Array<{ id: string; payment_id: string; amount_applied: unknown }>;
} | null> {
  const knex = scope.resolve("__pg_connection__") as any;

  const { rows: orderRows } = await knex.raw(
    `SELECT status, metadata->>'pos_total' AS pos_total FROM "order" WHERE id = ? AND deleted_at IS NULL`,
    [orderId]
  );
  if (!orderRows[0]) return null;
  const orderStatus = String(orderRows[0].status ?? "");

  let orderTotalCents = 0;
  const posTotalDollars = Number(orderRows[0].pos_total);
  if (Number.isFinite(posTotalDollars) && posTotalDollars > 0) {
    orderTotalCents = Math.round(posTotalDollars * 100);
  } else {
    try {
      const query = scope.resolve("query") as any;
      const {
        data: [order],
      } = await query.graph({
        entity: "order",
        fields: ["id", "total"],
        filters: { id: orderId },
      });
      orderTotalCents = Math.round(getNum(order?.total));
    } catch {
      orderTotalCents = 0;
    }
  }

  const { rows: sums } = await knex.raw(
    `SELECT COALESCE(SUM(pa.amount_applied) FILTER (WHERE pa.invoice_id IS NOT NULL), 0)::numeric AS invoice_bound
       FROM payment_application pa
      WHERE pa.order_id = ? AND pa.voided_at IS NULL AND pa.deleted_at IS NULL`,
    [orderId]
  );
  const invoiceBoundCents = Math.round(Number(sums[0]?.invoice_bound ?? 0));

  // Clampable reservations only — see header for the web/refund exclusion.
  const { rows } = await knex.raw(
    `SELECT pa.id, pa.payment_id, pa.amount_applied::numeric AS amount_applied
       FROM payment_application pa
       JOIN customer_payment cp ON cp.id = pa.payment_id
      WHERE pa.order_id = ?
        AND pa.invoice_id IS NULL AND pa.voided_at IS NULL AND pa.deleted_at IS NULL
        AND cp.deleted_at IS NULL
        AND cp.source <> 'web'
        AND cp.type <> 'refund'
        AND cp.status <> 'voided'
      ORDER BY pa.created_at DESC`,
    [orderId]
  );
  const orderOnlyCents = rows.reduce(
    (s: number, r: any) => s + Math.round(getNum(r.amount_applied)),
    0
  );

  const isCanceled = orderStatus === "canceled";
  const totalUnknown = !isCanceled && orderTotalCents <= 0;
  // Fail-open when the total is unknowable (0): clamping everything to zero on
  // a data gap would strip legitimate reservations.
  const allowedCents = isCanceled
    ? 0
    : totalUnknown
      ? Math.max(orderOnlyCents, 0)
      : Math.max(0, orderTotalCents - invoiceBoundCents);

  const excessCents = Math.max(0, orderOnlyCents - allowedCents);
  const gapCents = Math.max(0, allowedCents - orderOnlyCents);

  return {
    state: {
      order_status: orderStatus,
      order_total_cents: orderTotalCents,
      invoice_bound_cents: invoiceBoundCents,
      order_only_cents: orderOnlyCents,
      allowed_cents: allowedCents,
      excess_cents: excessCents,
      gap_cents: gapCents,
      total_unknown: totalUnknown,
    },
    rows,
  };
}

/** Read-only: the allowance/gap math without releasing anything. */
export async function computeOrderReservationState(
  scope: Scope,
  orderId: string
): Promise<OrderReservationState | null> {
  const loaded = await loadState(scope, orderId);
  return loaded?.state ?? null;
}

export async function reconcileOrderReservations(
  scope: Scope,
  orderId: string,
  opts: { logger?: { info: (m: string) => void; warn: (m: string) => void } } = {}
): Promise<ReconcileResult | null> {
  const loaded = await loadState(scope, orderId);
  if (!loaded) return null;
  const { state, rows } = loaded;
  const log = opts.logger;

  // Canceled orders release exactly; live orders tolerate <$1 drift.
  const shouldClamp =
    state.order_status === "canceled"
      ? state.excess_cents > 0
      : state.excess_cents > EPSILON_CENTS;

  if (!shouldClamp) {
    return { state, released_cents: 0, released: [] };
  }

  const financeService = scope.resolve(FINANCE_MODULE) as any;
  const released: ReconcileResult["released"] = [];
  let remaining = state.excess_cents;

  for (const row of rows) {
    if (remaining <= 0) break;
    const rowAmt = Math.round(getNum(row.amount_applied));
    if (rowAmt <= 0) continue;
    const rel = Math.min(remaining, rowAmt);

    if (rel >= rowAmt) {
      // Full release — soft-delete (audit-preserving; readers + the partial
      // unique index all filter deleted_at).
      const knex = scope.resolve("__pg_connection__") as any;
      await knex.raw(
        `UPDATE payment_application
            SET deleted_at = NOW(), updated_at = NOW(),
                metadata = COALESCE(metadata,'{}'::jsonb) || '{"auto_clamp_released":true}'::jsonb
          WHERE id = ?`,
        [row.id]
      );
      released.push({
        application_id: row.id,
        payment_id: row.payment_id,
        released_cents: rowAmt,
        deleted: true,
      });
    } else {
      // Partial — decrement via the module service (maintains raw_amount_applied).
      await financeService.updatePaymentApplications({
        id: row.id,
        amount_applied: rowAmt - rel,
      });
      released.push({
        application_id: row.id,
        payment_id: row.payment_id,
        released_cents: rel,
        deleted: false,
      });
    }
    remaining -= rel;
  }

  // Audit trail on each affected payment (object-map key = deep-merge safe).
  for (const r of released) {
    try {
      await financeService.updateCustomerPayments({
        id: r.payment_id,
        metadata: {
          auto_clamp_releases: {
            [`${r.application_id}:${Date.now()}`]: {
              order_id: orderId,
              released_cents: r.released_cents,
              deleted: r.deleted,
              at: new Date().toISOString(),
            },
          },
        },
      });
    } catch {
      /* audit is best-effort */
    }
  }

  const releasedCents = released.reduce((s, r) => s + r.released_cents, 0);
  log?.info(
    `[reservation-clamp] order ${orderId}: released ${releasedCents}¢ across ${released.length} reservation(s) (total=${state.order_total_cents} bound=${state.invoice_bound_cents} linked=${state.order_only_cents} allowed=${state.allowed_cents})`
  );

  // Recompute post-release so callers (post-edit-sync response → POS modal)
  // see the fresh gap/linked numbers.
  const after = await loadState(scope, orderId);
  return {
    state: after?.state ?? state,
    released_cents: releasedCents,
    released,
  };
}
