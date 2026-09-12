import type { PoolClient } from "pg";

import { paymentEconomicStatus } from "./payment-evidence";
import {
  receiptAccounts,
  receiptMapping,
  receiptSetup,
} from "./receipts-setup";
import type {
  ReceiptLine,
  ReceiptSetup,
  ReceiptSource,
} from "./receipts-types";
import { reviewHash } from "./review-common";
import { reviewDate, reviewToday } from "./review-date";
import { BankingError } from "./security";

export type PaymentRow = {
  id: string;
  display_id: number | null;
  customer_id: string;
  source: string;
  type: string;
  amount: string;
  currency: string;
  method: string;
  status: string;
  batch_day: string | null;
  reference: string | null;
  received_at: Date;
  locked_order_id: string | null;
  deleted: boolean;
  customer_deleted: boolean;
  metadata: Record<string, unknown> | null;
  qb: Record<string, unknown> | null;
  medusa_payment_id: string | null;
  medusa_refund_id: string | null;
};
export type ReceiptEvidence = {
  source: ReceiptSource;
  source_hash: string;
  snapshot: Record<string, unknown>;
  blockers: string[];
  lines: ReceiptLine[];
  setup: ReceiptSetup | null;
  allocations: Array<{
    payment_id: string | null;
    receipt_id: string | null;
    opening_item_id?: string | null;
    manual_reference?: string | null;
    manual_description?: string | null;
    amount_cents: number;
  }>;
};

export function receiptPaymentFacts(row: PaymentRow): {
  fingerprint_version: number;
  id: string;
  customer_id: string;
  source: string;
  type: string;
  amount: string | undefined;
  currency: string;
  method: string;
  status: string;
  batch_day: string | null;
  received_at: Date;
  reference: string | null;
  deleted: boolean;
  customer_deleted: boolean;
  medusa_refund_id: string | null;
  provenance: {
    qb_source: unknown;
    is_sales_receipt_payment: unknown;
    pending_sr: boolean;
    qb_import: unknown;
    qb_source_kind: unknown;
    refund_amount: unknown;
    terminal_refunded: unknown;
  };
} {
  const metadata = row.metadata ?? {},
    qb = row.qb ?? {};
  return {
    fingerprint_version: 1,
    id: row.id,
    customer_id: row.customer_id,
    source: row.source,
    type: row.type,
    amount: /^[1-9]\d*(?:\.0+)?$/.test(row.amount)
      ? row.amount.split(".")[0]
      : row.amount,
    currency: row.currency.toUpperCase(),
    method: row.method,
    status: paymentEconomicStatus(row.status),
    batch_day: row.batch_day,
    received_at: row.received_at,
    reference: row.reference,
    deleted: row.deleted,
    customer_deleted: row.customer_deleted,
    medusa_refund_id: row.medusa_refund_id,
    provenance: {
      qb_source: metadata.qb_source ?? null,
      is_sales_receipt_payment: metadata.is_sales_receipt_payment ?? null,
      pending_sr: metadata.qb_sync_status === "pending_sr",
      qb_import: metadata.qb_import ?? null,
      qb_source_kind: qb.source ?? null,
      refund_amount: metadata.refund_amount ?? null,
      terminal_refunded: metadata.terminal_refunded ?? null,
    },
  };
}
export function receiptPaymentBlockers(
  row: PaymentRow,
  setup: ReceiptSetup | null,
  methodPolicy: "standard" | "card" = "standard"
): string[] {
  const result: string[] = [],
    m = row.metadata ?? {},
    qb = row.qb ?? {};
  const methods =
    methodPolicy === "card"
      ? ["credit_card", "debit_card", "card"]
      : ["cash", "check", "ach", "zelle"];
  if (!setup) result.push("BANKING_RECEIPT_SETUP_REQUIRED");
  if (
    row.deleted ||
    row.customer_deleted ||
    row.type !== "payment" ||
    row.source !== "pos" ||
    !methods.includes(row.method) ||
    !["available", "partially_applied", "applied"].includes(row.status)
  )
    result.push("BANKING_RECEIPT_SOURCE_UNSUPPORTED");
  if (
    m.qb_source === "sales_receipt" ||
    m.is_sales_receipt_payment === true ||
    m.qb_sync_status === "pending_sr" ||
    qb.source === "sales_receipt" ||
    m.qb_import === true ||
    m.qb_import === "true" ||
    row.medusa_refund_id ||
    (m.qb_source &&
      !["receive_payment", "customer_payment"].includes(String(m.qb_source))) ||
    (qb.source &&
      !["receive_payment", "customer_payment"].includes(String(qb.source))) ||
    Number(m.refund_amount ?? 0) > 0 ||
    m.terminal_refunded === true
  )
    result.push("BANKING_RECEIPT_PROVENANCE_UNSUPPORTED");
  if (
    !/^[1-9]\d*(?:\.0+)?$/.test(row.amount) ||
    BigInt(row.amount.split(".")[0] || "0") > 999999999999n
  )
    result.push("BANKING_RECEIPT_AMOUNT_INVALID");
  if (row.currency.toUpperCase() !== "USD")
    result.push("BANKING_RECEIPT_USD_REQUIRED");
  if (
    !reviewDate.safeParse(row.batch_day).success ||
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- only reached when safeParse succeeded (short-circuit above), which means batch_day matched the date schema and is not null
    row.batch_day! > reviewToday()
  )
    result.push("BANKING_RECEIPT_DATE_INVALID");
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- reached only when the `if` above was false, i.e. safeParse succeeded, so batch_day is a valid non-null date string
  else if (setup && row.batch_day! < setup.cut_date)
    result.push("BANKING_RECEIPT_BEFORE_CUT");
  return result;
}
export function receiptLine(
  role: ReceiptLine["role"],
  account: ReceiptLine["account_snapshot"],
  cents: number,
  debit: boolean
): ReceiptLine {
  return {
    role,
    account_list_id: account.id,
    account_snapshot: account,
    account_name: account.name,
    account_type: account.account_type,
    debit_cents: debit ? cents : 0,
    credit_cents: debit ? 0 : cents,
  };
}
export async function paymentReceiptSource(
  client: PoolClient,
  id: string,
  methodPolicy: "standard" | "card" = "standard"
): Promise<ReceiptEvidence> {
  const setup = await receiptSetup(client);
  const row = (
    await client.query<PaymentRow>(
      `SELECT mp.id,mp.display_id,mp.customer_id,mp.source,mp.type,
    mp.amount::numeric::text AS amount,mp.currency,mp.method,mp.status,mp.batch_day,mp.reference,mp.received_at,
    mp.locked_order_id,mp.metadata,mp.qb,mp.medusa_payment_id,mp.medusa_refund_id,
    mp.deleted_at IS NOT NULL AS deleted,(c.id IS NULL OR c.deleted_at IS NOT NULL) AS customer_deleted
    FROM customer_payment mp LEFT JOIN customer c ON c.id=mp.customer_id WHERE mp.id=$1 FOR SHARE OF mp`,
      [id]
    )
  ).rows[0];
  if (!row) {
    const anchor = (
      await client.query(
        `SELECT id FROM bank_receipt_accounting WHERE payment_id=$1`,
        [id]
      )
    ).rows[0];
    if (!anchor) throw new BankingError("BANKING_RECEIPT_NOT_FOUND", 404);
    const source: ReceiptSource = {
      id,
      kind: "receipt",
      day: "",
      name: id,
      reference: "",
      amount_cents: null,
      net_cents: null,
      fee_cents: 0,
      currency: null,
      payment_ids: [id],
      account_id: null,
    };
    return {
      source,
      source_hash: reviewHash({ id, missing: true }),
      snapshot: { source, missing: true },
      blockers: ["BANKING_RECEIPT_SOURCE_MISSING"],
      lines: [],
      allocations: [],
      setup,
    };
  }
  const blockers = receiptPaymentBlockers(row, setup, methodPolicy);
  if (
    (
      await client.query(
        `SELECT e.id FROM bank_journal_entry e WHERE e.source_kind='customer_payment' AND e.source_id=$1
    AND e.kind='document' AND e.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id) LIMIT 1`,
        [id]
      )
    ).rowCount
  )
    blockers.push("BANKING_ALREADY_POSTED");
  // Keep the source's customer identity stable until the journal transaction commits.
  const customer = await client.query(
    "SELECT id FROM customer WHERE id=$1 AND deleted_at IS NULL FOR SHARE",
    [row.customer_id]
  );
  if (
    !customer.rowCount &&
    !blockers.includes("BANKING_RECEIPT_SOURCE_UNSUPPORTED")
  )
    blockers.push("BANKING_RECEIPT_SOURCE_UNSUPPORTED");
  const amount = blockers.includes("BANKING_RECEIPT_AMOUNT_INVALID")
    ? null
    : Number(row.amount);
  const source: ReceiptSource = {
    id,
    kind: "receipt",
    day: row.batch_day ?? "",
    name: `Payment ${row.display_id ?? id}`,
    reference: row.reference ?? "",
    amount_cents: amount,
    net_cents: amount,
    fee_cents: 0,
    currency: row.currency.toUpperCase(),
    payment_ids: [id],
    account_id: null,
  };
  const lines: ReceiptLine[] = [];
  if (setup) {
    const accounts = (
      await receiptAccounts(client, [
        setup.ar_account.id,
        setup.clearing_account.id,
      ])
    ).map((a) => receiptMapping(a, true));
    const ar = accounts.find((a) => a.id === setup.ar_account.id),
      clearing = accounts.find((a) => a.id === setup.clearing_account.id);
    if (
      !ar ||
      !clearing ||
      ar.account_type !== "AccountsReceivable" ||
      clearing.account_type !== "OtherCurrentAsset" ||
      ar.currency !== "USD" ||
      clearing.currency !== "USD"
    ) {
      blockers.push("BANKING_RECEIPT_MAPPING_STALE");
    }
    if (amount)
      lines.push(
        receiptLine("clearing", setup.clearing_account, amount, true),
        receiptLine("receivable", setup.ar_account, amount, false)
      );
  }
  const snapshot = {
    source,
    payment: receiptPaymentFacts(row),
    setup: setup ? { ...setup, frozen: undefined } : null,
  };
  return {
    source,
    source_hash: reviewHash(snapshot),
    snapshot,
    blockers,
    lines,
    setup,
    allocations: [],
  };
}
