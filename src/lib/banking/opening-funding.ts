import type { PoolClient } from "pg";

import {
  OPENING_ITEM_COLUMNS_SQL,
  OPENING_PAYMENT_FINGERPRINT_SQL,
  openingFundingReservedSql,
} from "./opening-sql";
import type { OpeningItem } from "./opening-types";
import { receiptRead } from "./receipts-setup";
import { paymentReceiptSource } from "./receipts-source";
import { BankingError } from "./security";

export async function openingPaymentSnapshot(
  client: PoolClient,
  id: string,
  cut: string
): Promise<{
  snapshot: {
    payment_fingerprint: string | null;
    original_amount_cents: number | null;
    payment: Record<string, unknown> | null;
  };
  blockers: string[];
  amount_cents: number | null;
}> {
  const exists = (
    await client.query("SELECT id FROM customer_payment WHERE id=$1", [id])
  ).rowCount;
  if (!exists)
    return {
      snapshot: {
        payment_fingerprint: null,
        original_amount_cents: null,
        payment: null,
      },
      blockers: ["BANKING_OPENING_SOURCE_DRIFT"],
      amount_cents: null,
    };
  const payment = await paymentReceiptSource(client, id);
  const blockers = payment.blockers.filter(
    (code) =>
      ![
        "BANKING_RECEIPT_BEFORE_CUT",
        "BANKING_OPENING_PAYMENT_CLAIMED",
      ].includes(code)
  );
  if (!payment.source.day || payment.source.day >= cut)
    blockers.push("BANKING_OPENING_PAYMENT_DATE_INVALID");
  const fingerprint =
    (
      await client.query<{ hash: string }>(
        `SELECT ${OPENING_PAYMENT_FINGERPRINT_SQL} AS hash
    FROM customer_payment mp WHERE mp.id=$1 FOR SHARE`,
        [id]
      )
    ).rows[0]?.hash ?? null;
  return {
    snapshot: {
      payment_fingerprint: fingerprint,
      original_amount_cents: payment.source.amount_cents,
      payment: payment.snapshot,
    },
    blockers,
    amount_cents: payment.source.amount_cents,
  };
}
export async function openingReadItem(
  client: PoolClient,
  id: string,
  excludeDeposit: string | null = null
): Promise<OpeningItem> {
  const item = (
    await client.query<
      OpeningItem & {
        opening_status: string;
        cut_date: string;
        reserved: string;
      }
    >(
      `SELECT ${OPENING_ITEM_COLUMNS_SQL},
    parent.status AS opening_status,parent.cut_date,${openingFundingReservedSql("$2::text")} AS reserved,
    (SELECT COALESCE(SUM(c.amount_cents),0)::float8 FROM bank_receipt_consumption c WHERE c.opening_item_id=oi.id
      AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=c.entry_id)) AS consumed_cents
    FROM bank_opening_item oi JOIN bank_opening_balance parent ON parent.id=oi.opening_id WHERE oi.id=$1`,
      [id, excludeDeposit]
    )
  ).rows[0];
  if (!item) throw new BankingError("BANKING_OPENING_ITEM_NOT_FOUND", 404);
  const blockers: string[] = [];
  if (item.opening_status !== "adopted")
    blockers.push("BANKING_OPENING_NOT_ADOPTED");
  if (item.stale) blockers.push("BANKING_OPENING_SOURCE_DRIFT");
  if (item.clear_id) {
    const drift = await client.query(
      `SELECT c.id FROM bank_opening_clear c LEFT JOIN bank_transaction t ON t.id=c.transaction_id
      WHERE c.id=$1 AND (t.id IS NULL OR t.deleted_at IS NOT NULL OR t.status<>'posted'
        OR t.source_version<>c.source_version OR t.account_id IS DISTINCT FROM c.source_snapshot->>'account_id'
        OR t.transaction_date IS DISTINCT FROM c.source_snapshot->>'transaction_date'
        OR t.currency IS DISTINCT FROM c.source_snapshot->>'currency'
        OR t.amount::numeric IS DISTINCT FROM (c.source_snapshot->>'amount')::numeric)`,
      [item.clear_id]
    );
    if (drift.rowCount) blockers.push("BANKING_OPENING_SOURCE_DRIFT");
  }
  if (item.payment_id && item.opening_status === "adopted") {
    const current = await openingPaymentSnapshot(
      client,
      item.payment_id,
      item.cut_date
    );
    blockers.push(...current.blockers);
    if (
      current.snapshot.payment_fingerprint !==
      item.source_snapshot.payment_fingerprint
    )
      blockers.push("BANKING_OPENING_SOURCE_DRIFT");
  }
  return {
    ...item,
    blockers: [...new Set(blockers)],
    stale: item.stale || blockers.includes("BANKING_OPENING_SOURCE_DRIFT"),
    available_cents:
      blockers.length || item.kind !== "uf_receipt"
        ? 0
        : Math.max(0, item.amount_cents - Number(item.reserved)),
  };
}
export async function validateOpeningFunding(
  client: PoolClient,
  id: string,
  depositId: string | null,
  cents: bigint,
  day: string
): Promise<OpeningItem> {
  const item = await openingReadItem(client, id, depositId);
  if (item.blockers.length)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by item.blockers.length above
    throw new BankingError(item.blockers[0]!, 409);
  if (item.kind !== "uf_receipt")
    throw new BankingError("BANKING_OPENING_FUNDING_INVALID", 409);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- item was loaded via a JOIN against bank_opening_balance on this same opening_id, so the row must exist
  const parent = (
    await client.query<{ cut_date: string }>(
      "SELECT cut_date FROM bank_opening_balance WHERE id=$1 FOR SHARE",
      [item.opening_id]
    )
  ).rows[0]!;
  if (day < parent.cut_date || day <= item.original_day)
    throw new BankingError("BANKING_OPENING_FUNDING_DATE_INVALID", 409);
  if (cents <= 0n || cents > BigInt(item.available_cents))
    throw new BankingError("BANKING_DEPOSIT_OVER_RESERVED", 409);
  return item;
}
export const listOpeningFunding = (): Promise<{ items: OpeningItem[] }> =>
  receiptRead(async (client) => {
    const ids = (
      await client.query<{
        id: string;
      }>(`SELECT oi.id FROM bank_opening_item oi JOIN bank_opening_balance b ON b.id=oi.opening_id
    WHERE b.status='adopted' AND oi.kind='uf_receipt' ORDER BY oi.original_day,oi.id LIMIT 200`)
    ).rows;
    const items: OpeningItem[] = [];
    for (const row of ids) items.push(await openingReadItem(client, row.id));
    return { items };
  });
