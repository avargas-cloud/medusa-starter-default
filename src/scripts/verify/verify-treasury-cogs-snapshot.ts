/**
 * verify-treasury-cogs-snapshot.ts
 *
 * Proves the COGS-immutability contract for order-only payment applications:
 *   - An application WITH a frozen cost_snapshot → Treasury COGS for its cash
 *     day does NOT change when the product's average cost changes later.
 *   - A legacy application WITHOUT a snapshot → Treasury COGS DOES change (live
 *     fallback), confirming the fallback path still works.
 * Also asserts the reconciliation invariant (delta == 0) for both reports and
 * exercises buildOrderCostSnapshot against a real order.
 *
 * SANDBOX ONLY. Refuses to run unless DATABASE_URL points at the Docker
 * sandbox (port 5499). All writes are cleaned up in a finally block.
 *
 * Run: cd backend && DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *      REDIS_URL=redis://localhost:6399 MEILISEARCH_HOST=http://localhost:7799 \
 *      npx medusa exec ./src/scripts/verify/verify-treasury-cogs-snapshot.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";

import { FINANCE_MODULE } from "../../modules/finance";
import { buildOrderCostSnapshot } from "../../lib/finance/build-order-cost-snapshot";
import { loadDailyReport } from "../../api/admin/accounting/treasury/_lib/load-daily-report";

const DAY_SNAP = "2014-07-15";
const DAY_LEGACY = "2014-07-16";

export default async function verify({ container }: ExecArgs) {
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!dbUrl.includes("5499") && !dbUrl.toLowerCase().includes("sandbox")) {
    throw new Error(
      `REFUSING TO RUN: DATABASE_URL does not look like the sandbox (got: ${dbUrl.replace(/:[^:@/]*@/, ":***@")}). This script mutates data.`
    );
  }

  const pg = container.resolve("__pg_connection__") as Parameters<
    typeof buildOrderCostSnapshot
  >[0] & {
    raw: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  };
  const finance = container.resolve(FINANCE_MODULE) as any;
  const log = (m: string) => console.log(`[verify-cogs] ${m}`);

  // 0. Column present?
  const col = await pg.raw(
    `SELECT 1 FROM information_schema.columns WHERE table_name='payment_application' AND column_name='cost_snapshot'`
  );
  if (col.rows.length === 0) {
    throw new Error("cost_snapshot column missing — run the migration first.");
  }
  log("✓ cost_snapshot column exists");

  // 1. Find a usable order: non-draft, has a customer, lines, and a variant with cost metadata.
  const ordRes = await pg.raw(
    `
    SELECT o.id AS order_id, o.customer_id,
           COALESCE(SUM(ROUND(oli.unit_price * oi.quantity * 100)),0)::bigint AS source_total_cents
    FROM "order" o
    JOIN order_item oi ON oi.order_id = o.id
    JOIN order_line_item oli ON oli.id = oi.item_id AND oli.deleted_at IS NULL
    JOIN product_variant pv ON pv.id = oli.variant_id
    WHERE COALESCE(o.status::text,'') NOT IN ('draft','canceled','cancelled')
      AND o.customer_id IS NOT NULL
      AND (NULLIF(pv.metadata->>'avg_landed_cost_cents','') IS NOT NULL
           OR NULLIF(pv.metadata->>'qb_avg_cost','') IS NOT NULL
           OR NULLIF(pv.metadata->>'qb_purchase_cost','') IS NOT NULL)
    GROUP BY o.id, o.customer_id
    HAVING COALESCE(SUM(ROUND(oli.unit_price * oi.quantity * 100)),0) > 0
    LIMIT 1
    `
  );
  if (ordRes.rows.length === 0) {
    throw new Error("No suitable order with cost metadata found in sandbox.");
  }
  const { order_id, customer_id, source_total_cents } = ordRes.rows[0];
  const amount = Number(source_total_cents);
  log(`Using order ${order_id} (customer ${customer_id}, total ${amount}c)`);

  // 2. buildOrderCostSnapshot smoke test
  const snapshot = await buildOrderCostSnapshot(pg, order_id);
  log(
    `Snapshot: ${snapshot.lines.length} lines, captured_at=${snapshot.captured_at}`
  );
  const costedLine = snapshot.lines.find((l) => l.unit_cost_cents != null);
  if (!costedLine || !costedLine.variant_id) {
    throw new Error("Snapshot has no line with a costed variant — cannot test.");
  }
  log(
    `  sample line: sku=${costedLine.sku} qty=${costedLine.quantity} unit_cost_cents=${costedLine.unit_cost_cents} is_china=${costedLine.is_china}`
  );

  const createdPaymentIds: string[] = [];
  const variantId = costedLine.variant_id;
  let originalMeta: any = null;

  try {
    // Capture original variant metadata for restore.
    const metaRes = await pg.raw(
      `SELECT metadata FROM product_variant WHERE id = ?`,
      [variantId]
    );
    originalMeta = metaRes.rows[0]?.metadata ?? {};

    // 3a. Snapshot-backed application on DAY_SNAP
    const paySnap = await finance.createCustomerPayments({
      customer_id,
      amount,
      method: "cash",
      received_at: new Date(`${DAY_SNAP}T12:00:00Z`),
      created_by: "verify-cogs",
      source: "pos",
      type: "payment",
      status: "available",
    });
    createdPaymentIds.push(paySnap.id);
    await finance.createPaymentApplications({
      payment_id: paySnap.id,
      invoice_id: null,
      order_id,
      amount_applied: amount,
      applied_at: new Date(`${DAY_SNAP}T12:00:00Z`),
      applied_by: "verify-cogs",
      cost_snapshot: snapshot,
    });

    // 3b. Legacy application (NO snapshot) on DAY_LEGACY
    const payLegacy = await finance.createCustomerPayments({
      customer_id,
      amount,
      method: "cash",
      received_at: new Date(`${DAY_LEGACY}T12:00:00Z`),
      created_by: "verify-cogs",
      source: "pos",
      type: "payment",
      status: "available",
    });
    createdPaymentIds.push(payLegacy.id);
    await finance.createPaymentApplications({
      payment_id: payLegacy.id,
      invoice_id: null,
      order_id,
      amount_applied: amount,
      applied_at: new Date(`${DAY_LEGACY}T12:00:00Z`),
      applied_by: "verify-cogs",
      cost_snapshot: null,
    });

    const cogsOf = (r: Awaited<ReturnType<typeof loadDailyReport>>) =>
      r.totals.cogs_china_cents + r.totals.cogs_local_cents;

    const snapBefore = await loadDailyReport(pg, DAY_SNAP);
    const legacyBefore = await loadDailyReport(pg, DAY_LEGACY);
    log(
      `delta check: snap=${snapBefore.reconciliation.delta_cents} legacy=${legacyBefore.reconciliation.delta_cents}`
    );
    if (
      snapBefore.reconciliation.delta_cents !== 0 ||
      legacyBefore.reconciliation.delta_cents !== 0
    ) {
      throw new Error("Reconciliation invariant violated (delta != 0).");
    }
    const cSnap1 = cogsOf(snapBefore);
    const cLegacy1 = cogsOf(legacyBefore);
    log(`COGS before mutation: snapshot-day=${cSnap1}  legacy-day=${cLegacy1}`);

    // 4. Simulate a PO receipt changing the product's average cost (inflate ×3).
    const bumped = {
      ...(originalMeta || {}),
      avg_landed_cost_cents: String(
        Math.max(1, (costedLine.unit_cost_cents ?? 100) * 3)
      ),
      qb_avg_cost: String(
        ((costedLine.unit_cost_cents ?? 100) * 3) / 100
      ),
    };
    await pg.raw(`UPDATE product_variant SET metadata = ?::jsonb WHERE id = ?`, [
      JSON.stringify(bumped),
      variantId,
    ]);
    log("Mutated variant avg cost (simulated PO receipt).");

    const snapAfter = await loadDailyReport(pg, DAY_SNAP);
    const legacyAfter = await loadDailyReport(pg, DAY_LEGACY);
    const cSnap2 = cogsOf(snapAfter);
    const cLegacy2 = cogsOf(legacyAfter);
    log(`COGS after mutation:  snapshot-day=${cSnap2}  legacy-day=${cLegacy2}`);

    // 5. Assertions
    const frozenOk = cSnap1 === cSnap2 && cSnap1 > 0;
    const driftedOk = cLegacy1 !== cLegacy2 && cLegacy1 > 0;
    log(
      `RESULT: snapshot-frozen=${frozenOk ? "PASS" : "FAIL"} (${cSnap1}→${cSnap2}); legacy-drifts=${driftedOk ? "PASS" : "FAIL"} (${cLegacy1}→${cLegacy2})`
    );
    if (!frozenOk) {
      throw new Error(
        `IMMUTABILITY FAILED: snapshot-day COGS changed ${cSnap1} → ${cSnap2}.`
      );
    }
    if (!driftedOk) {
      throw new Error(
        `FALLBACK CHECK FAILED: legacy-day COGS did not drift (${cLegacy1} → ${cLegacy2}). Expected live cost to change it.`
      );
    }
    log("✅ ALL CHECKS PASSED — snapshot freezes COGS; legacy falls back to live.");
  } finally {
    // Cleanup: restore variant metadata and delete synthetic rows.
    try {
      if (originalMeta !== null) {
        await pg.raw(
          `UPDATE product_variant SET metadata = ?::jsonb WHERE id = ?`,
          [JSON.stringify(originalMeta), variantId]
        );
      }
      if (createdPaymentIds.length > 0) {
        await pg.raw(
          `DELETE FROM payment_application WHERE payment_id = ANY(?)`,
          [createdPaymentIds]
        );
        await pg.raw(`DELETE FROM customer_payment WHERE id = ANY(?)`, [
          createdPaymentIds,
        ]);
      }
      log("Cleanup done (variant metadata restored, synthetic rows removed).");
    } catch (e: any) {
      log(`⚠️ Cleanup error (sandbox snapshot can be reset): ${e.message}`);
    }
  }
}
