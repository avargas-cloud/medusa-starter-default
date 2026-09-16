/**
 * src/scripts/fix/adopt-qb-bill-payments.ts — ap-rounding-cleanup-20260916 (C1)
 *
 * QuickBooks BillPaymentCheck #637 (TxnID 1D12D9-1789488167, 2026-09-15,
 * Regions Bank Checking 1416, $1,449.65, Luxury LED LLC) paid VB-1077
 * ($1,034.93) and VB-1079 ($414.72) and never reached the POS — both bills
 * still show open here. This adopts it through the SAME lane a POS payment
 * uses (`createBillPayment`: number, snapshot, allocations, period checks,
 * and the automatic rounding write-off — VB-1079 is 3¢ short in the POS),
 * then stamps the QB TxnID so the pipeline never re-sends it, and posts the
 * GL (Dr AP / Cr Regions 1416). Nothing goes to QuickBooks.
 *
 * Idempotent by `qb_txn_id`. DRY RUN by default; `APPLY=true` writes.
 */
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";
import type { PoolClient } from "pg";
import { getDbPool } from "../../api/utils/db-pool";
import { createBillPayment } from "../../lib/bill-payments/create";
import { computeBillBalancesBatch } from "../../lib/finance/recompute-bill-finance";
import { postBillPayment } from "../../lib/ledger/documents/bill-payment";
import { postVendorBillAdjustment } from "../../lib/ledger/documents/vendor-bill-adjustment";

const APPLY = process.env.APPLY === "true";
const ACTOR = "script:adopt-qb-bill-payments";

const PAYMENT = {
  qb_txn_id: "1D12D9-1789488167",
  ref: "637",
  date: "2026-09-15",
  bank_qb_list_id: "80000167-1684269278", // Regions Bank Checking 1416
  vendor_qb_list_id: "80001EFD-1713290558", // Luxury LED LLC
  amount_cents: 144965,
  allocations: [
    { bill_qb_txn_id: "1CBC65-1785436439", amount_cents: 103493 }, // VB-1077
    { bill_qb_txn_id: "1CD194-1786714050", amount_cents: 41472 }, // VB-1079 (POS payable 41475 → 3¢ rounding)
  ],
};

export default async function main({
  container,
}: {
  container: MedusaContainer;
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const say = (m: string) => logger.info(`[adopt-bp] ${m}`);
  const client: PoolClient = await getDbPool().connect();
  try {
    say(APPLY ? "APPLY" : "DRY RUN — nothing is written");
    const sum = PAYMENT.allocations.reduce((s, a) => s + a.amount_cents, 0);
    if (sum !== PAYMENT.amount_cents)
      throw new Error(`allocations ${sum} ≠ amount ${PAYMENT.amount_cents}`);

    const { rows: existing } = await client.query<{ number: string | null }>(
      `SELECT number FROM vendor_bill_payment WHERE qb_txn_id = $1 AND deleted_at IS NULL`,
      [PAYMENT.qb_txn_id]
    );
    if (existing[0])
      return say(`already adopted as ${existing[0].number} — nothing to do`);

    const { rows: vendors } = await client.query<{
      id: string;
      full_name: string;
    }>(
      `SELECT id, full_name FROM qb_vendor WHERE qb_list_id = $1 AND deleted_at IS NULL`,
      [PAYMENT.vendor_qb_list_id]
    );
    const vendor = vendors[0];
    if (!vendor) throw new Error("vendor not found");
    const { rows: bills } = await client.query<{
      id: string;
      number: string | null;
      qb_txn_id: string;
    }>(
      `SELECT id, number, qb_txn_id FROM vendor_bill WHERE qb_txn_id = ANY($1::text[]) AND deleted_at IS NULL`,
      [PAYMENT.allocations.map((a) => a.bill_qb_txn_id)]
    );
    if (bills.length !== PAYMENT.allocations.length)
      throw new Error(
        `expected ${PAYMENT.allocations.length} bills, found ${bills.length}`
      );
    const before = await computeBillBalancesBatch(
      client,
      bills.map((b) => b.id)
    );
    for (const b of bills)
      say(`  ${b.number} balance now ${before.get(b.id)?.balance_cents}¢`);
    say(
      `check #${PAYMENT.ref} ${PAYMENT.date} ${vendor.full_name} $${(PAYMENT.amount_cents / 100).toFixed(2)} from Regions 1416`
    );
    if (!APPLY) return;

    const created = await createBillPayment(client, {
      vendor_id: vendor.id,
      bank_account_list_id: PAYMENT.bank_qb_list_id,
      payment_date: PAYMENT.date,
      method: "check",
      reference: PAYMENT.ref,
      memo: `Adopted from QuickBooks BillPaymentCheck ${PAYMENT.qb_txn_id} (ap-rounding-cleanup-20260916)`,
      allocations: PAYMENT.allocations.map((a) => ({
        vendor_bill_id: bills.find((b) => b.qb_txn_id === a.bill_qb_txn_id)!.id,
        amount_cents: a.amount_cents,
      })),
      actor_id: ACTOR,
    });
    await client.query(
      `UPDATE vendor_bill_payment SET qb_txn_id = $2, qb_synced_at = now() WHERE id = $1`,
      [created.id, PAYMENT.qb_txn_id]
    );
    say(
      `  ✓ ${created.number} created (qb_txn_id stamped) · auto adjustments: ${created.auto_adjustment_ids.length}`
    );

    await client.query("BEGIN");
    const gl = await postBillPayment(client, created.id, ACTOR);
    await client.query("COMMIT");
    say(`  GL payment: ${gl.status}`);
    for (const adjustmentId of created.auto_adjustment_ids) {
      await client.query("BEGIN");
      const g = await postVendorBillAdjustment(client, adjustmentId, ACTOR);
      await client.query("COMMIT");
      say(`  GL rounding ${adjustmentId}: ${g.status}`);
    }
    const after = await computeBillBalancesBatch(
      client,
      bills.map((b) => b.id)
    );
    for (const b of bills)
      say(
        `  ${b.number} balance ${before.get(b.id)?.balance_cents}¢ → ${after.get(b.id)?.balance_cents}¢`
      );
  } finally {
    client.release();
  }
}
