import type { PoolClient } from "pg";

import { applyVendorCreditToBill } from "../vendor-credits/apply";
import { postVendorBillAdjustment } from "../ledger/documents/vendor-bill-adjustment";
import { enqueueVendorCreditApply } from "../purchase-orders/qb-vendor-credit-apply-enqueue";

import type { SettleDeps } from "./settle";
import type { CreditAllocationInput, SettlementStep } from "./types";

/**
 * Step 1: apply (part of) an already-posted vendor credit to a bill —
 * exactly the `applyVendorCreditToBill` + adjustments + enqueue sequence
 * `src/api/admin/vendor-credits/[id]/apply/route.ts` runs.
 */
export async function runCreditStep(
  deps: SettleDeps,
  alloc: CreditAllocationInput,
  actorId: string
): Promise<SettlementStep> {
  const client = await deps.pool.connect();
  let application: { id: string; auto_adjustment_ids: string[] };
  try {
    application = await applyVendorCreditToBill(client, {
      creditId: alloc.credit_id,
      vendorBillId: alloc.vendor_bill_id,
      amountCents: alloc.amount_cents,
      actorId,
    });
  } finally {
    client.release();
  }

  for (const adjustmentId of application.auto_adjustment_ids) {
    await deps.runLedgerHook((c: PoolClient) => postVendorBillAdjustment(c, adjustmentId, actorId), {
      source_kind: "vendor_bill_adjustment",
      source_id: adjustmentId,
    });
  }

  const qb = await enqueueVendorCreditApply(deps.knex, application.id).catch((err: unknown) => ({
    queued: false as const,
    reason: err instanceof Error ? err.message : String(err),
  }));

  return {
    kind: "credit",
    credit_id: alloc.credit_id,
    vendor_bill_id: alloc.vendor_bill_id,
    amount_cents: alloc.amount_cents,
    application_id: application.id,
    qb,
  };
}
