import type { PoolClient } from "pg";
import { generateEntityId } from "@medusajs/utils";

import { assertBankAccountingPeriodOpen } from "../accounting/banking-period-lock";
import { computeBillBalancesBatch, type PgQueryClient } from "../finance/recompute-bill-finance";

import { nextBillPaymentNumber } from "./numbering";
import {
  BillPaymentError,
  BILL_PAYMENT_METHODS,
  type CreateBillPaymentInput,
  type PgClient,
} from "./types";

interface VendorRow {
  id: string;
  full_name: string;
  qb_list_id: string;
}

interface BankAccountRow {
  qb_list_id: string;
  full_name: string;
  account_type: string;
  currency: string | null;
}

interface BillRow {
  id: string;
  status: string;
  vendor_id: string;
}

interface CreditApplicationRow {
  id: string;
  credit_id: string;
  vendor_bill_id: string;
  voided_at: string | null;
}

/**
 * Posts a bill payment against one or more open bills, atomically:
 *   - Σ allocations = amount_cents (plan §3);
 *   - each allocation ≤ the target bill's open balance;
 *   - only `confirmed|synced` bills are payable;
 *   - the vendor of every bill = the payment's vendor;
 *   - the bank account (`qb_account`) is Bank or CreditCard, matching `method`
 *     (`card` → CreditCard, everything else → Bank — this is the same split
 *     QBXML uses to choose `BillPaymentCheckAdd` vs `BillPaymentCreditCardAdd`);
 *   - period lock on `payment_date`.
 * Rows are locked with `SELECT … FOR UPDATE` in a fixed order (bills sorted
 * by id) to avoid deadlocking against a concurrent payment/credit-apply on
 * the same bill set.
 */
export async function createBillPayment(
  client: PgClient,
  input: CreateBillPaymentInput
): Promise<{ id: string; number: string }> {
  if (!BILL_PAYMENT_METHODS.includes(input.method)) {
    throw new BillPaymentError("invalid_method", `Unknown method: ${input.method}`);
  }
  if (input.allocations.length === 0) {
    throw new BillPaymentError("no_allocations", "A payment needs at least one allocation.");
  }
  const amountCents = input.allocations.reduce((sum, a) => sum + a.amount_cents, 0);
  for (const a of input.allocations) {
    if (!(a.amount_cents > 0)) {
      throw new BillPaymentError("invalid_allocation_amount", "Every allocation must have amount_cents > 0.");
    }
  }

  await client.query("BEGIN");
  try {
    const { rows: vendorRows } = await client.query(
      `SELECT id, full_name, qb_list_id FROM qb_vendor WHERE id = $1 AND deleted_at IS NULL`,
      [input.vendor_id]
    );
    const vendor = vendorRows[0] as VendorRow | undefined;
    if (!vendor) throw new BillPaymentError("vendor_not_found", "Vendor not found.", 404);

    const { rows: bankRows } = await client.query(
      `SELECT qb_list_id, full_name, account_type, currency FROM qb_account
        WHERE qb_list_id = $1 AND deleted_at IS NULL AND is_active = true`,
      [input.bank_account_list_id]
    );
    const bankAccount = bankRows[0] as BankAccountRow | undefined;
    if (!bankAccount) {
      throw new BillPaymentError("bank_account_not_found", "Bank account not found or inactive.", 404);
    }
    const expectedType = input.method === "card" ? "CreditCard" : "Bank";
    if (bankAccount.account_type !== expectedType) {
      throw new BillPaymentError(
        "bank_account_type_mismatch",
        `Method ${input.method} needs a ${expectedType} account; ${input.bank_account_list_id} is ${bankAccount.account_type}.`
      );
    }

    await assertBankAccountingPeriodOpen(client as unknown as PoolClient, input.payment_date);

    // Lock bills in a fixed order (their own ids) — the same discipline the
    // China-finance recompute uses for its groups, and the reason to avoid
    // ORDER BY vendor_bill_id ASC here would be a real deadlock risk between
    // two concurrent payments that share two of the same bills in opposite order.
    const billIds = [...new Set(input.allocations.map((a) => a.vendor_bill_id))].sort();
    const { rows: billRows } = await client.query(
      `SELECT id, status, vendor_id FROM vendor_bill
        WHERE id = ANY($1::text[]) AND deleted_at IS NULL
        ORDER BY id FOR UPDATE`,
      [billIds]
    );
    const billsById = new Map((billRows as BillRow[]).map((b) => [b.id, b]));
    for (const billId of billIds) {
      const bill = billsById.get(billId);
      if (!bill) throw new BillPaymentError("bill_not_found", `Vendor bill ${billId} not found.`, 404);
      if (!["confirmed", "synced"].includes(bill.status)) {
        throw new BillPaymentError(
          "bill_not_payable",
          `Vendor bill ${billId} is ${bill.status}, expected confirmed or synced.`,
          409
        );
      }
      if (bill.vendor_id !== vendor.id) {
        throw new BillPaymentError(
          "vendor_mismatch",
          `Vendor bill ${billId} does not belong to this payment's vendor.`
        );
      }
    }

    const balances = await computeBillBalancesBatch(client as unknown as PgQueryClient, billIds);
    const perBillTotal = new Map<string, number>();
    for (const a of input.allocations) {
      perBillTotal.set(a.vendor_bill_id, (perBillTotal.get(a.vendor_bill_id) ?? 0) + a.amount_cents);
    }
    for (const [billId, total] of perBillTotal) {
      const balance = balances.get(billId);
      if (!balance || total > balance.balance_cents) {
        throw new BillPaymentError(
          "exceeds_bill_balance",
          `Allocating ${total} to bill ${billId} would exceed its open balance (${balance?.balance_cents ?? 0} available).`
        );
      }
    }

    const creditApplicationIds = input.allocations
      .map((a) => a.credit_application_id)
      .filter((v): v is string => !!v);
    if (creditApplicationIds.length > 0) {
      const { rows } = await client.query(
        `SELECT ca.id, ca.credit_id, ca.vendor_bill_id, ca.voided_at, vc.vendor_id
           FROM vendor_credit_application ca
           JOIN vendor_credit vc ON vc.id = ca.credit_id
          WHERE ca.id = ANY($1::text[])`,
        [creditApplicationIds]
      );
      const appsById = new Map(
        (rows as (CreditApplicationRow & { vendor_id: string })[]).map((r) => [r.id, r])
      );
      for (const id of creditApplicationIds) {
        const app = appsById.get(id);
        if (!app) throw new BillPaymentError("credit_application_not_found", `${id} not found.`, 404);
        if (app.voided_at) throw new BillPaymentError("credit_application_voided", `${id} is voided.`, 409);
        if (app.vendor_id !== vendor.id) {
          throw new BillPaymentError("vendor_mismatch", `Credit application ${id} belongs to a different vendor.`);
        }
      }
    }

    const id = generateEntityId("", "vbp");
    const number = await nextBillPaymentNumber(client);
    await client.query(
      `INSERT INTO vendor_bill_payment
         (id, number, vendor_id, vendor_name_snapshot, vendor_qb_list_id_snapshot,
          bank_account_list_id, bank_account_snapshot, payment_date, method, reference, amount_cents,
          memo, status, posted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,'posted',$13)`,
      [
        id,
        number,
        vendor.id,
        vendor.full_name,
        vendor.qb_list_id,
        bankAccount.qb_list_id,
        JSON.stringify({
          id: bankAccount.qb_list_id,
          name: bankAccount.full_name,
          account_type: bankAccount.account_type,
          currency: bankAccount.currency ?? "USD",
        }),
        input.payment_date,
        input.method,
        input.reference ?? null,
        amountCents,
        input.memo ?? null,
        input.actor_id,
      ]
    );

    for (const a of input.allocations) {
      const allocId = generateEntityId("", "vbpa");
      await client.query(
        `INSERT INTO vendor_bill_payment_allocation (id, payment_id, vendor_bill_id, amount_cents, credit_application_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [allocId, id, a.vendor_bill_id, a.amount_cents, a.credit_application_id ?? null]
      );
    }

    await client.query("COMMIT");
    return { id, number };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

