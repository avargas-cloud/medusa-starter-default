/**
 * reconcile-native-overcapture.ts  (Phase B remediation — payment ledger)
 *
 * Fixes the historical DEPOSIT DOUBLE-CAPTURE (and any other native over-capture):
 * orders whose native payment_collection captured MORE than the order's real
 * money. Root cause fixed going-forward by the rebind-safe guard in
 * registerMedusaPayment (commit c01a0756) — DEPLOY THAT FIRST.
 *
 *   expected_native_cents = Σ per-payment LEAST(Σ active apps, customer_payment.amount)
 *     (deduped so the same payment appearing in two active applications — e.g. the
 *      order-only + invoice-bound apps of a rebound deposit — contributes at most
 *      its own amount; matches the guard's invariant exactly).
 *   native_effective_cents = round((Σ captured − Σ refunded) × 100) over the
 *     order's pp_system_default payments.
 *   overcapture = native_effective_cents − expected_native_cents  (refund if > 1¢)
 *
 * Guardrails (identical to Phase A):
 *   - DRY_RUN by default; APPLY=true to refund.
 *   - Only refunds provider_id = 'pp_system_default'.
 *   - Integer cents for decisions; dollars only at refundPayment().
 *   - Newest captures first; refunds only the current positive diff, chunked by
 *     refundable capture rows; never over-refunds a payment.
 *   - Idempotent: recomputes live per order, skips when |overcapture| ≤ 1¢.
 *   - Advisory lock per order; asserts native == expected after each order.
 *
 * NOTE: this supersedes reconcile-void-residue.ts (Phase A, already run) — the
 * deduped expected here is the general invariant; the Phase A void-residue orders
 * are already aligned so they will not re-appear as candidates.
 *
 * Usage:
 *   cd backend
 *   yarn medusa exec ./src/scripts/fix/reconcile-native-overcapture.ts            # DRY RUN
 *   APPLY=true yarn medusa exec ./src/scripts/fix/reconcile-native-overcapture.ts # APPLY
 */

import { MedusaContainer } from "@medusajs/framework/types";

const APPLY = process.env.APPLY === "true";
const SYSTEM_PROVIDER = "pp_system_default";
const TOLERANCE_CENTS = 1;

type PaymentRow = {
  id: string;
  provider_id: string | null;
  available_cents: number;
  newest_capture_at: number;
};

function toCents(n: unknown): number {
  return Math.round(Number(n ?? 0) * 100);
}

export default async function reconcileNativeOvercapture({
  container,
}: {
  container: MedusaContainer;
}) {
  const query = container.resolve("query") as any;
  const paymentModule = container.resolve("payment") as any;
  const knex = container.resolve("__pg_connection__") as any;

  console.log(
    `\n[reconcile-native-overcapture] mode=${APPLY ? "APPLY" : "DRY_RUN"}\n`
  );

  // Candidates: native effective > deduped expected.
  const { rows: candidates } = await knex.raw(
    `
    WITH nat AS (
      SELECT opc.order_id,
             ROUND((SUM(pc.captured_amount) - SUM(COALESCE(pc.refunded_amount,0))) * 100)::bigint AS native_eff
      FROM order_payment_collection opc
      JOIN payment_collection pc ON pc.id = opc.payment_collection_id
      GROUP BY opc.order_id
    ),
    expct AS (
      SELECT order_id, COALESCE(SUM(LEAST(applied_cents, payment_cents)),0)::bigint AS exp_native
      FROM (
        SELECT pa.order_id, pa.payment_id,
               SUM(pa.amount_applied)::bigint AS applied_cents,
               MAX(cp.amount)::bigint         AS payment_cents
        FROM payment_application pa
        JOIN customer_payment cp ON cp.id = pa.payment_id AND cp.deleted_at IS NULL
        WHERE pa.voided_at IS NULL AND pa.deleted_at IS NULL AND cp.status <> 'voided'
        GROUP BY pa.order_id, pa.payment_id
      ) per_pay
      GROUP BY order_id
    )
    SELECT n.order_id, o.display_id, n.native_eff,
           COALESCE(e.exp_native,0) AS exp_native,
           (n.native_eff - COALESCE(e.exp_native,0)) AS overcapture
    FROM nat n
    JOIN "order" o ON o.id = n.order_id
    LEFT JOIN expct e ON e.order_id = n.order_id
    WHERE (n.native_eff - COALESCE(e.exp_native,0)) > ?
    ORDER BY overcapture DESC
    `,
    [TOLERANCE_CENTS]
  );

  console.log(
    `[reconcile-native-overcapture] ${candidates.length} candidate order(s) (native > deduped expected)\n`
  );

  let totalRefundedCents = 0;
  let okCount = 0;
  let skipCount = 0;
  const failures: string[] = [];

  for (const c of candidates) {
    const orderId: string = c.order_id;
    const tag = `#${c.display_id}`;

    await knex.raw(`SELECT pg_advisory_lock(hashtext(?))`, [orderId]);
    try {
      const payments = await loadNativePayments(query, orderId);
      const nativeEff = payments.reduce((s, p) => s + p.available_cents, 0);
      const expNative = await loadDedupedExpectedCents(knex, orderId);
      const overcapture = nativeEff - expNative;

      if (overcapture <= TOLERANCE_CENTS) {
        console.log(`${tag} SKIP already-aligned (native ${nativeEff}¢ ≈ expected ${expNative}¢)`);
        skipCount++;
        continue;
      }

      const refundable = payments
        .filter((p) => p.provider_id === SYSTEM_PROVIDER && p.available_cents > 0)
        .sort((a, b) => b.newest_capture_at - a.newest_capture_at);
      const nonSystem = payments.filter(
        (p) => p.provider_id !== SYSTEM_PROVIDER && p.available_cents > 0
      );
      if (nonSystem.length > 0) {
        console.log(
          `${tag} WARN skipping ${nonSystem.length} non-system payment(s) — will NOT refund those`
        );
      }
      const refundableTotal = refundable.reduce((s, p) => s + p.available_cents, 0);
      const plannedCents = Math.min(overcapture, refundableTotal);

      console.log(
        `${tag} native=${nativeEff}¢ expected=${expNative}¢ overcapture=${overcapture}¢ ` +
          `→ refund ${plannedCents}¢ across ${refundable.length} system payment(s)` +
          (plannedCents < overcapture ? ` (capped by refundable ${refundableTotal}¢)` : "")
      );

      if (!APPLY) {
        totalRefundedCents += plannedCents;
        okCount++;
        continue;
      }

      let remaining = overcapture;
      for (const p of refundable) {
        if (remaining <= TOLERANCE_CENTS) break;
        const chunkCents = Math.min(remaining, p.available_cents);
        if (chunkCents <= 0) continue;
        await paymentModule.refundPayment({
          payment_id: p.id,
          amount: chunkCents / 100,
          created_by: "reconcile-native-overcapture",
          note: `Ledger reconciliation (Phase B) — native over-capture for order ${c.display_id}`,
        });
        remaining -= chunkCents;
        totalRefundedCents += chunkCents;
        console.log(`   ↳ refunded ${chunkCents}¢ from ${p.id}`);
      }

      const after = await loadNativePayments(query, orderId);
      const nativeAfter = after.reduce((s, p) => s + p.available_cents, 0);
      const residueAfter = nativeAfter - expNative;
      if (Math.abs(residueAfter) <= TOLERANCE_CENTS) {
        console.log(`${tag} ✅ aligned (native ${nativeAfter}¢ == expected ${expNative}¢)`);
        okCount++;
      } else {
        console.log(`${tag} ⚠️ residual ${residueAfter}¢ after refund`);
        failures.push(`${tag}: residual ${residueAfter}¢`);
      }
    } catch (err: any) {
      console.log(`${tag} ❌ ERROR: ${err.message}`);
      failures.push(`${tag}: ${err.message}`);
    } finally {
      await knex.raw(`SELECT pg_advisory_unlock(hashtext(?))`, [orderId]);
    }
  }

  console.log(
    `\n[reconcile-native-overcapture] done — mode=${APPLY ? "APPLY" : "DRY_RUN"} | ` +
      `orders=${okCount} skipped=${skipCount} refunded=${totalRefundedCents}¢ ($${(
        totalRefundedCents / 100
      ).toFixed(2)}) | failures=${failures.length}`
  );
  if (failures.length) console.log("  failures:\n   - " + failures.join("\n   - "));
}

async function loadNativePayments(
  query: any,
  orderId: string
): Promise<PaymentRow[]> {
  const {
    data: [order],
  } = await query.graph({
    entity: "order",
    fields: [
      "payment_collections.payments.id",
      "payment_collections.payments.provider_id",
      "payment_collections.payments.captures.amount",
      "payment_collections.payments.captures.created_at",
      "payment_collections.payments.refunds.amount",
    ],
    filters: { id: orderId },
  });
  const rows: PaymentRow[] = [];
  for (const pc of order?.payment_collections ?? []) {
    for (const p of pc?.payments ?? []) {
      const capturedCents = (p.captures ?? []).reduce(
        (s: number, c: any) => s + toCents(c.amount),
        0
      );
      const refundedCents = (p.refunds ?? []).reduce(
        (s: number, r: any) => s + toCents(r.amount),
        0
      );
      const newest = (p.captures ?? []).reduce((mx: number, c: any) => {
        const t = c.created_at ? new Date(c.created_at).getTime() : 0;
        return t > mx ? t : mx;
      }, 0);
      rows.push({
        id: p.id,
        provider_id: p.provider_id ?? null,
        available_cents: capturedCents - refundedCents,
        newest_capture_at: newest,
      });
    }
  }
  return rows;
}

async function loadDedupedExpectedCents(
  knex: any,
  orderId: string
): Promise<number> {
  const { rows } = await knex.raw(
    `
    SELECT COALESCE(SUM(LEAST(applied_cents, payment_cents)),0)::bigint AS exp_native
    FROM (
      SELECT pa.payment_id,
             SUM(pa.amount_applied)::bigint AS applied_cents,
             MAX(cp.amount)::bigint         AS payment_cents
      FROM payment_application pa
      JOIN customer_payment cp ON cp.id = pa.payment_id AND cp.deleted_at IS NULL
      WHERE pa.order_id = ? AND pa.voided_at IS NULL AND pa.deleted_at IS NULL
        AND cp.status <> 'voided'
      GROUP BY pa.payment_id
    ) per_pay
    `,
    [orderId]
  );
  return Number(rows[0]?.exp_native ?? 0);
}
