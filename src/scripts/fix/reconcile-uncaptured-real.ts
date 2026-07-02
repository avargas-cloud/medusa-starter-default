/**
 * reconcile-uncaptured-real.ts  (Phase C remediation — payment ledger)
 *
 * Aligns the native ledger for the two orders where REAL (non-credit) POS money
 * failed to capture natively (native < expected_real), so native_effective ==
 * expected_real. Direction is money-IN (capture), so this uses an EXPLICIT
 * allowlist — never a broad query.
 *
 *   expected_real_cents = Σ per-payment LEAST(Σ active apps, customer_payment.amount)
 *                         EXCLUDING credit_memo/store-credit payments (they do not
 *                         create native captures by design).
 *   shortfall = expected_real_cents − native_effective_cents  (capture if > 1¢)
 *
 * We pass `amount = shortfall` to registerMedusaPayment. Its guard caps to
 * (order_expected_all − native), and since shortfall ≤ that gap, it captures
 * EXACTLY the real shortfall — it will NOT capture the credit_memo portion.
 *
 * EXCLUDED on purpose: orders 1430 & 1414 — those under-captures are a native
 * REFUND not mirrored in the finance apps (a legitimate return), NOT a failed
 * capture; capturing there would be wrong.
 *
 * Usage:
 *   cd backend
 *   yarn medusa exec ./src/scripts/fix/reconcile-uncaptured-real.ts             # DRY RUN
 *   APPLY=true yarn medusa exec ./src/scripts/fix/reconcile-uncaptured-real.ts  # APPLY
 */

import { MedusaContainer } from "@medusajs/framework/types";
import { registerMedusaPayment } from "../../api/admin/invoices/register-medusa-payment";

const APPLY = process.env.APPLY === "true";
const TOLERANCE_CENTS = 1;
const TARGET_DISPLAY_IDS = [1652, 1433];

function toCents(n: unknown): number {
  return Math.round(Number(n ?? 0) * 100);
}

export default async function reconcileUncapturedReal({
  container,
}: {
  container: MedusaContainer;
}) {
  const query = container.resolve("query") as any;
  const knex = container.resolve("__pg_connection__") as any;

  console.log(`\n[reconcile-uncaptured-real] mode=${APPLY ? "APPLY" : "DRY_RUN"}\n`);

  const nativeEffCents = async (orderId: string): Promise<number> => {
    const {
      data: [order],
    } = await query.graph({
      entity: "order",
      fields: [
        "payment_collections.payments.captures.amount",
        "payment_collections.payments.refunds.amount",
      ],
      filters: { id: orderId },
    });
    let cents = 0;
    for (const pc of order?.payment_collections ?? []) {
      for (const p of pc?.payments ?? []) {
        cents += (p.captures ?? []).reduce((s: number, c: any) => s + toCents(c.amount), 0);
        cents -= (p.refunds ?? []).reduce((s: number, r: any) => s + toCents(r.amount), 0);
      }
    }
    return cents;
  };

  for (const displayId of TARGET_DISPLAY_IDS) {
    const { rows: oRows } = await knex.raw(
      `SELECT id FROM "order" WHERE display_id = ?`,
      [displayId]
    );
    const orderId = oRows[0]?.id;
    if (!orderId) {
      console.log(`#${displayId} SKIP — order not found`);
      continue;
    }

    await knex.raw(`SELECT pg_advisory_lock(hashtext(?))`, [orderId]);
    try {
      // expected_real (deduped, non-credit) + a representative real payment for logging.
      const { rows: expRows } = await knex.raw(
        `
        SELECT COALESCE(SUM(LEAST(applied_cents, payment_cents)),0)::bigint AS exp_real
        FROM (
          SELECT pa.payment_id,
                 SUM(pa.amount_applied)::bigint AS applied_cents,
                 MAX(cp.amount)::bigint         AS payment_cents
          FROM payment_application pa
          JOIN customer_payment cp ON cp.id = pa.payment_id AND cp.deleted_at IS NULL
          WHERE pa.order_id = ? AND pa.voided_at IS NULL AND pa.deleted_at IS NULL
            AND cp.status <> 'voided'
            AND cp.type <> 'credit_memo' AND COALESCE(cp.method,'') <> 'credit_memo'
          GROUP BY pa.payment_id
        ) x
        `,
        [orderId]
      );
      const expectedReal = Number(expRows[0]?.exp_real ?? 0);

      const { rows: cpRows } = await knex.raw(
        `SELECT cp.id, cp.method FROM payment_application pa
         JOIN customer_payment cp ON cp.id = pa.payment_id
         WHERE pa.order_id = ? AND pa.voided_at IS NULL AND pa.deleted_at IS NULL
           AND cp.type <> 'credit_memo' AND COALESCE(cp.method,'') <> 'credit_memo'
         ORDER BY pa.amount_applied DESC LIMIT 1`,
        [orderId]
      );
      const cpId = cpRows[0]?.id;
      const method = cpRows[0]?.method ?? "cash";

      const native = await nativeEffCents(orderId);
      const shortfall = expectedReal - native;

      console.log(
        `#${displayId} native=${native}¢ expected_real=${expectedReal}¢ shortfall=${shortfall}¢`
      );

      if (shortfall <= TOLERANCE_CENTS) {
        console.log(`#${displayId} SKIP already-aligned`);
        continue;
      }
      if (!APPLY) {
        console.log(`#${displayId} would capture ${shortfall}¢ (method=${method})`);
        continue;
      }

      // Capture exactly the real shortfall. The guard caps to
      // (order_expected_all − native) ≥ shortfall, so requesting `shortfall`
      // captures exactly that — never the credit portion.
      const paymentId = await registerMedusaPayment(container, {
        order_id: orderId,
        amount: shortfall,
        payment_method: method,
        invoice_total: expectedReal,
        customer_payment_id: cpId,
      });

      const after = await nativeEffCents(orderId);
      const ok = Math.abs(after - expectedReal) <= TOLERANCE_CENTS;
      console.log(
        `#${displayId} ${ok ? "✅" : "⚠️"} captured (payment=${paymentId}) → native ${after}¢ ` +
          `${ok ? "==" : "!="} expected_real ${expectedReal}¢`
      );
    } catch (err: any) {
      console.log(`#${displayId} ❌ ERROR: ${err.message}`);
    } finally {
      await knex.raw(`SELECT pg_advisory_unlock(hashtext(?))`, [orderId]);
    }
  }

  console.log(`\n[reconcile-uncaptured-real] done — mode=${APPLY ? "APPLY" : "DRY_RUN"}\n`);
}
