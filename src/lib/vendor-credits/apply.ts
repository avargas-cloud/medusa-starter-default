import { generateEntityId } from "@medusajs/utils";

import { computeBillBalance, type PgQueryClient } from "../finance/recompute-bill-finance";

import { VendorCreditError, type PgClient } from "./types";

interface CreditRow {
  id: string;
  status: string;
  vendor_id: string;
  total_cents: number;
  applied_cents: number;
}

interface BillRow {
  id: string;
  status: string;
  vendor_id: string;
}

/**
 * Apply (part of) a posted vendor credit to an open bill. Invariants
 * (plan §3), enforced under row locks in one transaction:
 *   - credit is `posted` (never draft/voided);
 *   - Σ active applications of the credit ≤ credit.total_cents;
 *   - the bill is `confirmed|synced` and the application ≤ its open balance;
 *   - vendor of the credit = vendor of the bill.
 */
export async function applyVendorCreditToBill(
  client: PgClient,
  params: { creditId: string; vendorBillId: string; amountCents: number; actorId: string }
): Promise<{ id: string }> {
  const { creditId, vendorBillId, amountCents, actorId } = params;
  if (!(amountCents > 0)) {
    throw new VendorCreditError("invalid_amount", "amount_cents must be > 0.");
  }

  await client.query("BEGIN");
  try {
    const { rows: creditRows } = await client.query(
      `SELECT id, status, vendor_id, total_cents, applied_cents FROM vendor_credit
        WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [creditId]
    );
    const credit = creditRows[0] as CreditRow | undefined;
    if (!credit) throw new VendorCreditError("not_found", "Vendor credit not found.", 404);
    if (credit.status !== "posted") {
      throw new VendorCreditError(
        "invalid_status",
        `Vendor credit is ${credit.status}, expected posted.`,
        409
      );
    }

    const { rows: billRows } = await client.query(
      `SELECT id, status, vendor_id FROM vendor_bill WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [vendorBillId]
    );
    const bill = billRows[0] as BillRow | undefined;
    if (!bill) throw new VendorCreditError("bill_not_found", "Vendor bill not found.", 404);
    if (!["confirmed", "synced"].includes(bill.status)) {
      throw new VendorCreditError(
        "bill_not_payable",
        `Vendor bill is ${bill.status}, expected confirmed or synced.`,
        409
      );
    }
    if (bill.vendor_id !== credit.vendor_id) {
      throw new VendorCreditError(
        "vendor_mismatch",
        "The credit and the bill belong to different vendors."
      );
    }

    const { rows: sumRows } = await client.query(
      `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS applied
         FROM vendor_credit_application WHERE credit_id = $1 AND voided_at IS NULL`,
      [creditId]
    );
    const alreadyApplied = Number((sumRows[0] as { applied: number }).applied);
    if (alreadyApplied + amountCents > credit.total_cents) {
      throw new VendorCreditError(
        "exceeds_credit_total",
        `Applying ${amountCents} would exceed the credit's total (${credit.total_cents - alreadyApplied} available).`
      );
    }

    const balance = await computeBillBalance(client as unknown as PgQueryClient, vendorBillId);
    if (!balance || amountCents > balance.balance_cents) {
      throw new VendorCreditError(
        "exceeds_bill_balance",
        `Applying ${amountCents} would exceed the bill's open balance (${balance?.balance_cents ?? 0} available).`
      );
    }

    const id = generateEntityId("", "vcap");
    await client.query(
      `INSERT INTO vendor_credit_application (id, credit_id, vendor_bill_id, amount_cents, applied_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, creditId, vendorBillId, amountCents, actorId]
    );
    await client.query(
      `UPDATE vendor_credit SET applied_cents = applied_cents + $2, updated_at = now() WHERE id = $1`,
      [creditId, amountCents]
    );
    await client.query("COMMIT");
    return { id };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}
