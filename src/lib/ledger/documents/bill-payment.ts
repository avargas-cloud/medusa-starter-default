import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { getBusinessDateString } from "../../date/et";
import { loadPurchaseAccountMap } from "../accounts";
import { buildBillPaymentLines } from "../lines/bill-payment";
import { postDocumentJournal, reverseDocumentJournal } from "../post";
import { LedgerAccount, LedgerError, PostResult, ReverseResult } from "../types";

/**
 * DDL: `src/migrations/1783400000000-VendorCreditsAndBillPayments.ts`
 * (`vendor_bill_payment`, sibling F2). Lee por nombre de columna, no crea ni
 * modifica ese módulo.
 */
type PaymentHeader = {
  id: string;
  number: string | null;
  status: string;
  amount_cents: string;
  bank_account_list_id: string;
  payment_date: string;
  voided_at: string | null;
};

async function loadHeader(client: PoolClient, paymentId: string): Promise<PaymentHeader | null> {
  const { rows } = await client.query<PaymentHeader>(
    `SELECT id, number, status, amount_cents::text, bank_account_list_id, payment_date::text, voided_at::text
     FROM vendor_bill_payment WHERE id = $1 AND deleted_at IS NULL`,
    [paymentId]
  );
  return rows[0] ?? null;
}

async function loadBankAccount(client: PoolClient, listId: string): Promise<LedgerAccount> {
  const { rows } = await client.query<{
    qb_list_id: string;
    name: string;
    account_type: string;
    normal_balance: string | null;
  }>(
    `SELECT qb_list_id, name, account_type, normal_balance FROM qb_account WHERE qb_list_id = $1`,
    [listId]
  );
  const row = rows[0];
  if (!row) throw new LedgerError("GL_ACCOUNT_MAP_MISSING", { qbListId: listId });
  return {
    id: row.qb_list_id,
    name: row.name,
    account_type: row.account_type,
    currency: "USD",
    normal_balance:
      row.normal_balance === "debit" || row.normal_balance === "credit" ? row.normal_balance : null,
  };
}

export async function postBillPayment(
  client: PoolClient,
  paymentId: string,
  actorId: string
): Promise<PostResult> {
  const header = await loadHeader(client, paymentId);
  if (!header) throw new LedgerError("GL_SOURCE_INVALID", { paymentId });
  if (header.status !== "posted")
    throw new LedgerError("GL_SOURCE_INVALID", { status: header.status });

  const map = await loadPurchaseAccountMap(client);
  const bankAccount = await loadBankAccount(client, header.bank_account_list_id);
  const lines = buildBillPaymentLines(
    { amountCents: BigInt(header.amount_cents), bankAccount },
    map
  );
  // §3: un pago que sólo aplica un crédito viaja como `PaymentAmount 0.00` —
  // no postea nada al GL (el efecto ya lo tiene el `vendor_credit` aplicado).
  if (lines.length === 0) return { status: "skipped", reason: "zero_amount" };

  const day = getBusinessDateString(header.payment_date);
  const sourceSnapshot = { header };
  const sourceHash = createHash("sha256").update(JSON.stringify(sourceSnapshot)).digest("hex");

  return postDocumentJournal(client, {
    source_kind: "vendor_bill_payment",
    source_id: paymentId,
    document_number: header.number ?? paymentId,
    day,
    reference: header.number ?? paymentId,
    description: `Bill Payment ${header.number ?? paymentId}`,
    lines,
    source_snapshot: sourceSnapshot,
    source_hash: sourceHash,
    actor_id: actorId,
  });
}

export async function reverseBillPayment(
  client: PoolClient,
  paymentId: string,
  actorId: string,
  reason = "bill payment voided"
): Promise<ReverseResult> {
  const header = await loadHeader(client, paymentId);
  if (!header) return { status: "nothing_to_reverse" };
  const day = getBusinessDateString(header.voided_at ?? header.payment_date);
  return reverseDocumentJournal(client, {
    source_kind: "vendor_bill_payment",
    source_id: paymentId,
    day,
    reason,
    actor_id: actorId,
  });
}
