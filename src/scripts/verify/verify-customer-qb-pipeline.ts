import { ExecArgs } from "@medusajs/framework/types";
import { Modules, ContainerRegistrationKeys } from "@medusajs/utils";

import { getDbPool } from "../../api/utils/db-pool";
import {
  requireQbCustomer,
  ensureCustomerPipelineRow,
} from "../../lib/quickbooks/qb-pipeline";

/**
 * Verification script for the customer QB pipeline system.
 *
 * Three scenarios (no QB bridge calls made — all reads/writes are local DB):
 *
 *   A) Helper fast-path: customer already has qb_list_id → returns qbListId.
 *   B) Helper wait-path: customer has no qb_list_id → enqueues customer row +
 *      writes dependent waiting row with depends_on.
 *   C) Wake-pass: simulates customer confirming → verifies dependent row moves
 *      waiting → pending and has depends_on cleared semantics (kept for lineage).
 *
 * Usage: npx medusa exec ./src/scripts/verify/verify-customer-qb-pipeline.ts
 */
export default async function verifyCustomerQbPipeline({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const customerModule = container.resolve(Modules.CUSTOMER);
  const pool = getDbPool();

  const results: Array<{ name: string; ok: boolean; detail: string }> = [];

  const logResult = (name: string, ok: boolean, detail: string) => {
    results.push({ name, ok, detail });
    logger.info(
      `${ok ? "✅" : "❌"} [${name}] ${detail}`
    );
  };

  // Pick two real customers from DB — one with qb_list_id, one without.
  const { rows: customersWith } = await pool.query(
    `SELECT id, email FROM customer
      WHERE metadata ? 'qb_list_id' AND deleted_at IS NULL
      LIMIT 1`
  );
  const { rows: customersWithout } = await pool.query(
    `SELECT id, email FROM customer
      WHERE (metadata IS NULL OR NOT (metadata ? 'qb_list_id'))
        AND deleted_at IS NULL
      LIMIT 1`
  );

  if (customersWith.length === 0) {
    logger.warn("⚠️  No customers with qb_list_id found — scenario A skipped");
  }
  if (customersWithout.length === 0) {
    logger.warn("⚠️  No customers without qb_list_id found — creating ephemeral pipeline row for B/C");
  }

  // ── Scenario A — fast path (customer has qb_list_id) ─────────────────────
  if (customersWith.length > 0) {
    const target = customersWith[0];
    const check = await requireQbCustomer({
      customerId: target.id,
      orderId: null,
      step: "sales_receipt",
      selfReferenceId: `verify-a-${Date.now()}`,
      selfReferenceType: "pos_invoice",
    });

    if ("qbListId" in check && check.qbListId) {
      logResult(
        "A fast-path",
        true,
        `customer=${target.email} → qbListId=${check.qbListId}`
      );
    } else {
      logResult(
        "A fast-path",
        false,
        `Expected qbListId, got: ${JSON.stringify(check)}`
      );
    }
  }

  // ── Scenario B — wait-path (customer has no qb_list_id) ──────────────────
  let targetCustomerId: string | null = null;
  let targetCustomerEmail: string | null = null;

  if (customersWithout.length > 0) {
    targetCustomerId = customersWithout[0].id;
    targetCustomerEmail = customersWithout[0].email;
  } else {
    // Create a throwaway customer for the test (will be cleaned up at end)
    const throwaway = await customerModule.createCustomers({
      email: `verify-${Date.now()}@test.local`,
      first_name: "Verify",
      last_name: "Throwaway",
    });
    targetCustomerId = throwaway.id;
    targetCustomerEmail = throwaway.email;
    logger.info(`Created throwaway customer ${targetCustomerId} for test`);
  }

  const bSelfRef = `verify-b-${Date.now()}`;
  const check = await requireQbCustomer({
    customerId: targetCustomerId,
    orderId: null,
    step: "sales_receipt",
    selfReferenceId: bSelfRef,
    selfReferenceType: "pos_invoice",
  });

  let customerRowId: string | null = null;
  if ("waiting" in check && check.customerRowId) {
    customerRowId = check.customerRowId;

    // Verify the customer pipeline row exists in pending state
    const { rows: custRows } = await pool.query(
      `SELECT status, reference_id, medusa_ref_number FROM qb_order_pipeline WHERE id = $1`,
      [customerRowId]
    );
    const custOk =
      custRows.length === 1 &&
      custRows[0].status === "pending" &&
      custRows[0].reference_id === targetCustomerId;
    logResult(
      "B customer row",
      custOk,
      `id=${customerRowId} status=${custRows[0]?.status} ref=${custRows[0]?.reference_id}`
    );

    // Verify the dependent waiting row exists with depends_on set
    const { rows: depRows } = await pool.query(
      `SELECT id, status, depends_on FROM qb_order_pipeline
        WHERE step = 'sales_receipt' AND reference_id = $1`,
      [bSelfRef]
    );
    const depOk =
      depRows.length === 1 &&
      depRows[0].status === "waiting" &&
      depRows[0].depends_on === customerRowId;
    logResult(
      "B dependent row",
      depOk,
      `status=${depRows[0]?.status} depends_on=${depRows[0]?.depends_on}`
    );

    // ── Scenario C — simulate customer confirming, verify wake-pass ────────
    await pool.query(
      `UPDATE qb_order_pipeline SET status = 'confirmed', confirmed_at = NOW(), qb_txn_id = 'TEST-LISTID-123' WHERE id = $1`,
      [customerRowId]
    );

    // Run wake-pass (same query the consolidator uses)
    await pool.query(
      `UPDATE qb_order_pipeline w
          SET status = 'pending', updated_at = NOW(),
              error = NULL, failed_at = NULL, submitted_at = NULL, bridge_op_id = NULL
         FROM qb_order_pipeline d
        WHERE w.depends_on = d.id
          AND w.status = 'waiting'
          AND d.status = 'confirmed'`
    );

    const { rows: afterRows } = await pool.query(
      `SELECT status, depends_on FROM qb_order_pipeline
        WHERE step = 'sales_receipt' AND reference_id = $1`,
      [bSelfRef]
    );
    const wakeOk = afterRows.length === 1 && afterRows[0].status === "pending";
    logResult(
      "C wake-pass",
      wakeOk,
      `dependent row is now ${afterRows[0]?.status} (was waiting)`
    );
  } else {
    logResult(
      "B wait-path",
      false,
      `Expected { waiting: true }, got: ${JSON.stringify(check)}`
    );
  }

  // ── Cleanup test rows ───────────────────────────────────────────────────
  // ALWAYS delete the test-injected pipeline rows, regardless of whether
  // we used a real or throwaway customer. Scenario C writes a synthetic
  // TEST-LISTID-123 into the customer row; leaving it in production would
  // show a misleading "confirmed customer" row in the Admin UI.
  try {
    await pool.query(
      `DELETE FROM qb_order_pipeline WHERE reference_id = $1`,
      [bSelfRef]
    );
    if (customerRowId) {
      await pool.query(
        `DELETE FROM qb_order_pipeline WHERE id = $1`,
        [customerRowId]
      );
    }
    if (customersWithout.length === 0 && targetCustomerId) {
      await customerModule.deleteCustomers([targetCustomerId]);
    }
  } catch (cleanupErr: any) {
    logger.warn(`Cleanup error: ${cleanupErr.message}`);
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  logger.info("─".repeat(60));
  logger.info(
    `Verification complete: ${passed} passed, ${failed} failed, ${results.length} total`
  );
  if (failed > 0) {
    logger.error("Failures:");
    for (const r of results.filter((x) => !x.ok)) {
      logger.error(`  - ${r.name}: ${r.detail}`);
    }
    process.exitCode = 1;
  }

  // Idempotency check: calling ensureCustomerPipelineRow twice for same
  // customer returns the same row id.
  const c1 = await ensureCustomerPipelineRow("verify-idem-" + Date.now(), "t@t");
  const c2 = await ensureCustomerPipelineRow(
    await pool
      .query(
        `SELECT reference_id FROM qb_order_pipeline WHERE id = $1`,
        [c1]
      )
      .then((r) => r.rows[0].reference_id),
    "t@t"
  );
  logger.info(
    `Idempotency: ensureCustomerPipelineRow returns ${
      c1 === c2 ? "same" : "DIFFERENT"
    } id on repeat call (${c1} vs ${c2})`
  );

  await pool.query(`DELETE FROM qb_order_pipeline WHERE id = $1`, [c1]);
}
