/**
 * backfill-orphan-payment-applications.ts
 *
 * Links "orphan" customer_payments that belong to an order but have NO
 * payment_application (the bug behind PAY-2562 / bams_online_payment, and any
 * deposit captured before the auto-link fixes shipped).
 *
 * An orphan is a customer_payment where:
 *   - type = 'payment', not voided, not deleted
 *   - it has an order it belongs to (metadata.order_id OR locked_order_id)
 *   - that order is a REAL (non-draft) order_id (payment_application.order_id is
 *     NOT NULL and must reference "order")
 *   - it has NO non-voided payment_application at all
 *
 * For each, we create an ORDER-ONLY application (invoice_id = NULL) for the
 * payment's full available amount, freezing the cost basis via
 * buildOrderCostSnapshot. This makes the sale visible to Treasury and the
 * deposit show as available credit. No QB enqueue (order-only).
 *
 * DRY-RUN by default: prints what it WOULD do. Pass --commit (process.argv) or
 * env BACKFILL_COMMIT=true to actually write.
 *
 * Run (sandbox dry-run):
 *   cd backend && DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *     REDIS_URL=redis://localhost:6399 MEILISEARCH_HOST=http://localhost:7799 \
 *     npx medusa exec ./src/scripts/migrations/backfill-orphan-payment-applications.ts
 * Run (commit):  add  BACKFILL_COMMIT=true  to the env.
 */
import type { ExecArgs } from "@medusajs/framework/types";

import { FINANCE_MODULE } from "../../modules/finance";
import { buildOrderCostSnapshot } from "../../lib/finance/build-order-cost-snapshot";

export default async function backfill({ container }: ExecArgs) {
  const commit =
    process.env.BACKFILL_COMMIT === "true" ||
    process.argv.includes("--commit");
  const pg = container.resolve("__pg_connection__") as Parameters<
    typeof buildOrderCostSnapshot
  >[0] & { raw: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
  const finance = container.resolve(FINANCE_MODULE) as any;
  const log = (m: string) => console.log(`[backfill-orphan] ${m}`);

  log(commit ? "MODE: COMMIT (will write)" : "MODE: DRY-RUN (no writes)");

  // Candidates: payments with an order in metadata/locked_order_id that resolves
  // to a REAL order, and zero non-voided applications. We resolve the order id
  // from metadata.order_id first, then locked_order_id, and require it to exist
  // in "order" (excludes drafts/estimates — those link at convert-force).
  const candidates = await pg.raw(
    `
    SELECT
      cp.id            AS payment_id,
      cp.display_id    AS display_id,
      cp.amount        AS amount,
      cp.source        AS source,
      COALESCE(o_meta.id, o_lock.id) AS order_id
    FROM customer_payment cp
    LEFT JOIN "order" o_meta ON o_meta.id = (cp.metadata->>'order_id')
    LEFT JOIN "order" o_lock ON o_lock.id = cp.locked_order_id
    WHERE cp.deleted_at IS NULL
      AND cp.type = 'payment'
      AND cp.status <> 'voided'
      AND COALESCE(cp.method, '') <> 'credit_memo'
      AND COALESCE(o_meta.id, o_lock.id) IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM payment_application pa
        WHERE pa.payment_id = cp.id AND pa.voided_at IS NULL
      )
    ORDER BY cp.created_at
    `
  );

  const rows = candidates.rows ?? [];
  log(`Found ${rows.length} orphan payment(s) belonging to a real order.`);
  if (rows.length === 0) return;

  let linked = 0;
  let failed = 0;
  for (const r of rows) {
    const tag = r.display_id ? `PAY-${r.display_id}` : r.payment_id;
    const amount = Number(r.amount);
    log(
      `  ${tag} (${(amount / 100).toFixed(2)}, ${r.source}) → order ${r.order_id}`
    );
    if (!commit) continue;
    try {
      const snapshot = await buildOrderCostSnapshot(pg, r.order_id);
      await finance.createPaymentApplications({
        payment_id: r.payment_id,
        invoice_id: null,
        invoice_number: null,
        order_id: r.order_id,
        amount_applied: amount,
        applied_at: new Date(),
        applied_by: "system:backfill-orphan",
        cost_snapshot: snapshot,
      });
      linked++;
    } catch (e: any) {
      failed++;
      log(`    ⚠️ failed: ${e.message}`);
    }
  }

  if (commit) {
    log(`DONE — linked ${linked}, failed ${failed}, of ${rows.length}.`);
  } else {
    log(`DRY-RUN complete — re-run with BACKFILL_COMMIT=true to link these ${rows.length}.`);
  }
}
