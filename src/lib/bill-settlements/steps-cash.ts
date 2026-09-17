import type { PoolClient } from "pg";

import { createBillPayment } from "../bill-payments/create";
import { postBillPayment } from "../ledger";
import { postVendorBillAdjustment } from "../ledger/documents/vendor-bill-adjustment";
import { enqueueBillPaymentAdd } from "../purchase-orders/qb-bill-payment-enqueue";

import type { SettleDeps } from "./settle";
import type { CashPaymentInput, SettlementStep } from "./types";

/**
 * Step 3: pay whatever is left with new cash — the exact
 * `createBillPayment` + GL + adjustments + enqueue sequence
 * `src/api/admin/bill-payments/route.ts` runs.
 */
export async function runCashStep(
  deps: SettleDeps,
  cash: CashPaymentInput,
  vendorId: string,
  settlementDate: string,
  actorId: string
): Promise<SettlementStep> {
  const client = await deps.pool.connect();
  let created: { id: string; number: string; auto_adjustment_ids: string[] };
  try {
    created = await createBillPayment(client, {
      vendor_id: vendorId,
      bank_account_list_id: cash.bank_account_list_id,
      payment_date: settlementDate,
      method: cash.method,
      reference: cash.reference ?? null,
      memo: cash.memo ?? null,
      allocations: cash.allocations,
      actor_id: actorId,
    });
  } finally {
    client.release();
  }

  await deps.runLedgerHook((c: PoolClient) => postBillPayment(c, created.id, actorId), {
    source_kind: "vendor_bill_payment",
    source_id: created.id,
  });
  for (const adjustmentId of created.auto_adjustment_ids) {
    await deps.runLedgerHook((c: PoolClient) => postVendorBillAdjustment(c, adjustmentId, actorId), {
      source_kind: "vendor_bill_adjustment",
      source_id: adjustmentId,
    });
  }

  const qb = await enqueueBillPaymentAdd(deps.knex, created.id).catch((err: unknown) => ({
    queued: false as const,
    reason: err instanceof Error ? err.message : String(err),
  }));

  const amountCents = cash.allocations.reduce((sum, a) => sum + a.amount_cents, 0);
  return { kind: "cash", bill_payment_id: created.id, number: created.number, amount_cents: amountCents, qb };
}
