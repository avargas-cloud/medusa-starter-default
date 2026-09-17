import type { PoolClient } from "pg";

import { assertBankAccountingPeriodOpen } from "../accounting/banking-period-lock";
import { computeBillBalance, type PgQueryClient } from "../finance/recompute-bill-finance";
import { postVendorCredit } from "../ledger";
import { postVendorBillAdjustment } from "../ledger/documents/vendor-bill-adjustment";
import { applyVendorCreditToBill } from "../vendor-credits/apply";
import { createDraftVendorCredit } from "../vendor-credits/create";
import { markVendorCreditPosted } from "../vendor-credits/post";
import { enqueueVendorCreditAdd } from "../purchase-orders/qb-vendor-credit-enqueue";
import { enqueueVendorCreditApply } from "../purchase-orders/qb-vendor-credit-apply-enqueue";

import { lockPrepaymentLine } from "./prepayments";
import type { SettleDeps } from "./settle";
import { BillSettlementError, type PrepaymentAllocationInput, type SettlementStep } from "./types";

/**
 * Step 2: settle a bill with money the vendor is already holding as a
 * prepayment (a posted check/expense line against its OtherCurrentAsset
 * account) — by minting the account-only VendorCredit the accountant's QB
 * pattern uses (Dr AP / Cr prepayment), posting it, and applying it.
 *
 * Capacity is checked TWICE, on purpose:
 *   1. Here, in a short read-only transaction (`lockPrepaymentLine`) — early,
 *      readable failure, before any document is minted.
 *   2. DEFINITIVELY inside `createDraftVendorCredit` (`vendor-credits/create.ts`),
 *      under its own `FOR UPDATE OF l`, because this transaction's lock is
 *      released at its COMMIT before that one opens — a second settlement can
 *      race in between. That second check is the one that can never be wrong.
 *
 * The accounting period is checked HERE too, before anything is minted:
 * `markVendorCreditPosted` re-checks it, but by then the draft credit and its
 * consumption row already exist — a 423 there would leave a draft that keeps
 * consuming the check line (caught by the sandbox E2E, [C4]).
 */
export async function runPrepaymentStep(
  deps: SettleDeps,
  alloc: PrepaymentAllocationInput,
  vendorId: string,
  settlementDate: string,
  actorId: string
): Promise<SettlementStep> {
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    let lock: { check_id: string; account_list_id: string; account_name: string; remaining_cents: number };
    let docNumber: string;
    try {
      await assertBankAccountingPeriodOpen(client, settlementDate);
      lock = await lockPrepaymentLine(client, alloc.gl_check_line_id, vendorId);
      if (alloc.amount_cents > lock.remaining_cents) {
        throw new BillSettlementError(
          "prepayment_exceeds_remaining",
          `Consuming ${alloc.amount_cents} would exceed this check line's remaining prepayment (${lock.remaining_cents} available).`,
          409
        );
      }

      const { rows: billRows } = await client.query(
        `SELECT id, vendor_id FROM vendor_bill WHERE id = $1 AND deleted_at IS NULL`,
        [alloc.vendor_bill_id]
      );
      const bill = billRows[0] as { id: string; vendor_id: string } | undefined;
      if (!bill || bill.vendor_id !== vendorId) {
        throw new BillSettlementError("prepayment_bill_not_found", "Vendor bill not found for this vendor.", 404);
      }
      const balance = await computeBillBalance(client as unknown as PgQueryClient, alloc.vendor_bill_id);
      if (!balance || alloc.amount_cents > balance.balance_cents) {
        throw new BillSettlementError(
          "prepayment_exceeds_bill_balance",
          `Applying ${alloc.amount_cents} would exceed the bill's open balance (${balance?.balance_cents ?? 0} available).`,
          409
        );
      }

      const { rows: checkRows } = await client.query(`SELECT doc_number FROM gl_check WHERE id = $1`, [
        lock.check_id,
      ]);
      docNumber = (checkRows[0] as { doc_number: string }).doc_number;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
    // Validation-only tx: nothing written yet, just the row lock releasing.
    await client.query("COMMIT");

    const credit = await createDraftVendorCredit(client, {
      vendor_id: vendorId,
      credit_date: settlementDate,
      reason: "prepayment",
      memo: `Prepayment ${docNumber} · ${lock.account_name}`,
      lines: [
        {
          line_type: "qb_account",
          qb_account_list_id: lock.account_list_id,
          description: `Applied from ${docNumber}`,
          amount_cents: alloc.amount_cents,
        },
      ],
      actor_id: actorId,
      prepayment: { gl_check_id: lock.check_id, gl_check_line_id: alloc.gl_check_line_id, consumed_cents: alloc.amount_cents },
    });

    await markVendorCreditPosted(client, credit.id, actorId);
    // Account-only credit (no product lines) — moveVendorCreditStock never
    // applies here, unlike the PO-return lane.
    await deps.runLedgerHook((c: PoolClient) => postVendorCredit(c, credit.id, actorId), {
      source_kind: "vendor_credit",
      source_id: credit.id,
    });
    const qbAdd = await enqueueVendorCreditAdd(deps.knex, credit.id).catch((err: unknown) => ({
      queued: false as const,
      reason: err instanceof Error ? err.message : String(err),
    }));

    const application = await applyVendorCreditToBill(client, {
      creditId: credit.id,
      vendorBillId: alloc.vendor_bill_id,
      amountCents: alloc.amount_cents,
      actorId,
    });
    for (const adjustmentId of application.auto_adjustment_ids) {
      await deps.runLedgerHook((c: PoolClient) => postVendorBillAdjustment(c, adjustmentId, actorId), {
        source_kind: "vendor_bill_adjustment",
        source_id: adjustmentId,
      });
    }
    const qbApply = await enqueueVendorCreditApply(deps.knex, application.id).catch((err: unknown) => ({
      queued: false as const,
      reason: err instanceof Error ? err.message : String(err),
    }));

    return {
      kind: "prepayment",
      gl_check_line_id: alloc.gl_check_line_id,
      vendor_bill_id: alloc.vendor_bill_id,
      amount_cents: alloc.amount_cents,
      vendor_credit_id: credit.id,
      vendor_credit_number: credit.number,
      application_id: application.id,
      qb_add: qbAdd,
      qb_apply: qbApply,
    };
  } finally {
    client.release();
  }
}
