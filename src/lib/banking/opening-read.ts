import type { PoolClient } from "pg";

import type { AccountingAccount } from "./accounting-types";
import { OPENING_EVIDENCE_COLUMNS } from "./opening-evidence";
import { openingReadItem } from "./opening-funding";
import type {
  OpeningBalance,
  OpeningContext,
  OpeningEvidence,
  OpeningItem,
} from "./opening-types";
import {
  receiptAccounts,
  receiptMapping,
  receiptRead,
  receiptSetup,
} from "./receipts-setup";
import type { ReceiptSetup } from "./receipts-types";
import { reviewHash } from "./review-common";
import { reviewToday } from "./review-date";
import { BankingError, bankingEnvSql } from "./security";

export function openingDifference(
  kind: "bank" | "clearing",
  book: number | null,
  statement: number | null,
  items: Array<{ kind: string; amount_cents: number }>
): number | null {
  if (book === null || (kind === "bank" && statement === null)) return null;
  const total = items.reduce(
    (sum, item) =>
      sum +
      item.amount_cents *
        (kind === "clearing" || item.kind === "deposit_in_transit" ? 1 : -1),
    0
  );
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- el guard de arriba retorna antes cuando kind==="bank" y statement===null
  return book - (kind === "bank" ? statement! + total : total);
}
export const OPENING_BALANCE_COLUMNS = `id,revision,kind,status,setup_id,cut_date,bank_account_id,account_list_id,currency,
  account_snapshot,book_balance_cents::float8 AS book_balance_cents,statement_balance_cents::float8 AS statement_balance_cents,
  statement_evidence_id,books_evidence_id,reference,adopted_by,adopted_at,revoked_by,revoked_at,revoke_reason`;
export async function openingRow(
  client: PoolClient,
  id: string
): Promise<OpeningBalance> {
  const row = (
    await client.query<OpeningBalance>(
      `SELECT ${OPENING_BALANCE_COLUMNS} FROM bank_opening_balance WHERE id=$1`,
      [id]
    )
  ).rows[0];
  if (!row) throw new BankingError("BANKING_OPENING_NOT_FOUND", 404);
  return row;
}
export async function openingMapping(
  client: PoolClient,
  kind: "bank" | "clearing",
  accountId: string | null
): Promise<{ setup: ReceiptSetup; account: AccountingAccount }> {
  const setup = await receiptSetup(client);
  if (!setup) throw new BankingError("BANKING_RECEIPT_SETUP_REQUIRED", 409);
  if (kind === "clearing") {
    if (accountId)
      throw new BankingError("BANKING_OPENING_ACCOUNT_INVALID", 409);
    const live = (
      await receiptAccounts(client, [setup.clearing_account.id])
    )[0];
    if (
      !live ||
      live.account_type !== "OtherCurrentAsset" ||
      receiptMapping(live, setup.attested).currency !== "USD"
    )
      throw new BankingError("BANKING_OPENING_ACCOUNT_INVALID", 409);
    return { setup, account: receiptMapping(live, setup.attested) };
  }
  const bank = (
    await client.query<{ qb_list_id: string }>(
      `SELECT a.qb_list_id FROM bank_account a JOIN bank_connection c ON c.id=a.connection_id
    WHERE a.id=$1 AND a.is_active AND a.is_selected AND a.currency='USD' AND a.type='depository'
      AND a.deleted_at IS NULL AND c.deleted_at IS NULL AND c.environment=${bankingEnvSql()} FOR SHARE OF a,c`,
      [accountId]
    )
  ).rows[0];
  const live = bank?.qb_list_id
    ? (await receiptAccounts(client, [bank.qb_list_id]))[0]
    : null;
  const account = live ? receiptMapping(live, setup.attested) : null;
  if (
    !account ||
    account.account_type !== "Bank" ||
    account.currency !== "USD"
  ) {
    throw new BankingError("BANKING_OPENING_ACCOUNT_INVALID", 409);
  }
  return { setup, account };
}
export async function openingContext(
  client: PoolClient,
  id: string
): Promise<OpeningContext> {
  const opening = await openingRow(client, id);
  const ids = (
    await client.query<{ id: string }>(
      "SELECT id FROM bank_opening_item WHERE opening_id=$1 ORDER BY original_day,id",
      [id]
    )
  ).rows;
  const items: OpeningItem[] = [];
  for (const row of ids) items.push(await openingReadItem(client, row.id));
  const evidenceIds = [
    ...new Set(
      [
        opening.statement_evidence_id,
        opening.books_evidence_id,
        ...items.map((item) => item.evidence_id),
      ].filter((value): value is string => Boolean(value))
    ),
  ];
  const evidence = (
    await client.query<OpeningEvidence>(
      `SELECT ${OPENING_EVIDENCE_COLUMNS} FROM bank_opening_evidence
    WHERE id=ANY($1::text[]) AND deleted_at IS NULL ORDER BY created_at,id`,
      [evidenceIds]
    )
  ).rows;
  const blockers: string[] = [];
  if (
    !opening.books_evidence_id ||
    (opening.kind === "bank" && !opening.statement_evidence_id) ||
    evidence.length !== evidenceIds.length ||
    items.some((item) => !item.evidence_id)
  )
    blockers.push("BANKING_OPENING_EVIDENCE_REQUIRED");
  const difference = openingDifference(
    opening.kind,
    opening.book_balance_cents,
    opening.statement_balance_cents,
    items
  );
  if (difference === null) blockers.push("BANKING_OPENING_BALANCE_UNKNOWN");
  else if (difference !== 0) blockers.push("BANKING_OPENING_UNBALANCED");
  if (opening.kind === "clearing" && (opening.book_balance_cents ?? 0) < 0)
    blockers.push("BANKING_OPENING_UF_NEGATIVE");
  if (
    items.some(
      (item) =>
        item.original_day >= opening.cut_date ||
        (opening.kind === "clearing") !== (item.kind === "uf_receipt")
    )
  )
    blockers.push("BANKING_OPENING_ITEM_INVALID");
  for (const item of items)
    blockers.push(
      ...item.blockers.filter((code) => code !== "BANKING_OPENING_NOT_ADOPTED")
    );
  const movementsRow = (
    await client.query<{ cents: string }>(
      `SELECT COALESCE(SUM(line.debit_cents-line.credit_cents),0)::text AS cents
    FROM bank_journal_line line JOIN bank_journal_entry entry ON entry.id=line.entry_id
    WHERE line.account_list_id=$1 AND entry.day>=$2 AND entry.day<=$3 AND line.role=$4`,
      [
        opening.account_list_id,
        opening.cut_date,
        reviewToday(),
        opening.kind === "bank" ? "bank" : "clearing",
      ]
    )
  ).rows[0];
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- SUM/COALESCE sin GROUP BY siempre devuelve exactamente una fila
  const movements = Number(movementsRow!.cents);
  const snapshot = {
    opening,
    items: items.map((item) => ({
      id: item.id,
      source_hash: item.source_hash,
    })),
    evidence,
  };
  return {
    opening,
    items,
    evidence,
    blockers: [...new Set(blockers)],
    difference_cents: difference,
    movements_cents: movements,
    current_book_balance_cents:
      opening.status === "adopted" && opening.book_balance_cents !== null
        ? opening.book_balance_cents + movements
        : null,
    source_hash: reviewHash(snapshot),
    coverage: "partial",
    zero_gl: true,
  };
}
export const readOpening = (id: string): Promise<OpeningContext> =>
  receiptRead((client) => openingContext(client, id));
export const listOpenings = (): Promise<{
  openings: OpeningContext[];
  count: number;
}> =>
  receiptRead(async (client) => {
    const ids = (
      await client.query<{ id: string }>(
        "SELECT id FROM bank_opening_balance ORDER BY created_at DESC,id DESC LIMIT 20"
      )
    ).rows;
    const openings: OpeningContext[] = [];
    for (const row of ids) openings.push(await openingContext(client, row.id));
    return { openings, count: openings.length };
  });
