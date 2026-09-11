import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { getBusinessDateString } from "../../date/et";
import { loadPurchaseAccountMap } from "../accounts";
import { buildVendorCreditLines, VendorCreditAccountLine } from "../lines/vendor-credit";
import { postDocumentJournal, reverseDocumentJournal } from "../post";
import { LedgerAccount, LedgerError, PostResult, ReverseResult } from "../types";

/**
 * DDL: `src/migrations/1783400000000-VendorCreditsAndBillPayments.ts`
 * (`vendor_credit` / `vendor_credit_line`, sibling F2). Este loader lee esas
 * tablas por NOMBRE de columna, tal como especifica el plan §3 — no crea ni
 * modifica ese módulo.
 */
type CreditHeader = {
  id: string;
  number: string | null;
  status: string;
  total_cents: string;
  credit_date: string;
  voided_at: string | null;
};

type CreditLineRow = {
  line_type: string;
  qb_account_list_id: string | null;
  amount_cents: string;
};

async function loadHeader(client: PoolClient, creditId: string): Promise<CreditHeader | null> {
  const { rows } = await client.query<CreditHeader>(
    `SELECT id, number, status, total_cents::text, credit_date::text, voided_at::text
     FROM vendor_credit WHERE id = $1 AND deleted_at IS NULL`,
    [creditId]
  );
  return rows[0] ?? null;
}

async function loadLines(client: PoolClient, creditId: string): Promise<CreditLineRow[]> {
  const { rows } = await client.query<CreditLineRow>(
    `SELECT line_type, qb_account_list_id, amount_cents::text
     FROM vendor_credit_line WHERE credit_id = $1 AND deleted_at IS NULL ORDER BY sort, id`,
    [creditId]
  );
  return rows;
}

async function resolveAccounts(
  client: PoolClient,
  listIds: string[]
): Promise<Map<string, LedgerAccount>> {
  const ids = [...new Set(listIds)].filter(Boolean);
  const result = new Map<string, LedgerAccount>();
  if (!ids.length) return result;
  const { rows } = await client.query<{
    qb_list_id: string;
    name: string;
    account_type: string;
    normal_balance: string | null;
  }>(
    `SELECT qb_list_id, name, account_type, normal_balance FROM qb_account WHERE qb_list_id = ANY($1::text[])`,
    [ids]
  );
  for (const r of rows) {
    result.set(r.qb_list_id, {
      id: r.qb_list_id,
      name: r.name,
      account_type: r.account_type,
      currency: "USD",
      normal_balance:
        r.normal_balance === "debit" || r.normal_balance === "credit" ? r.normal_balance : null,
    });
  }
  return result;
}

export async function postVendorCredit(
  client: PoolClient,
  creditId: string,
  actorId: string
): Promise<PostResult> {
  const header = await loadHeader(client, creditId);
  if (!header) throw new LedgerError("GL_SOURCE_INVALID", { creditId });
  if (header.status !== "posted")
    throw new LedgerError("GL_SOURCE_INVALID", { status: header.status });

  const lineRows = await loadLines(client, creditId);
  const map = await loadPurchaseAccountMap(client);
  const accountsByListId = await resolveAccounts(
    client,
    lineRows.map((r) => r.qb_account_list_id).filter((x): x is string => Boolean(x))
  );
  const productAmountCents = lineRows
    .filter((r) => r.line_type === "product")
    .reduce((sum, r) => sum + BigInt(r.amount_cents), 0n);
  const accountLines: VendorCreditAccountLine[] = lineRows
    .filter((r) => r.line_type === "qb_account" && r.qb_account_list_id)
    .map((r) => ({
      account: accountsByListId.get(r.qb_account_list_id as string) ?? map.income_default,
      amountCents: BigInt(r.amount_cents),
    }));

  const lines = buildVendorCreditLines(
    { totalCents: BigInt(header.total_cents), productAmountCents, accountLines },
    map
  );
  if (lines.length === 0) return { status: "skipped", reason: "zero_amount" };

  const day = getBusinessDateString(header.credit_date);
  const sourceSnapshot = { header, lineRows };
  const sourceHash = createHash("sha256").update(JSON.stringify(sourceSnapshot)).digest("hex");

  return postDocumentJournal(client, {
    source_kind: "vendor_credit",
    source_id: creditId,
    document_number: header.number ?? creditId,
    day,
    reference: header.number ?? creditId,
    description: `Vendor Credit ${header.number ?? creditId}`,
    lines,
    source_snapshot: sourceSnapshot,
    source_hash: sourceHash,
    actor_id: actorId,
  });
}

export async function reverseVendorCredit(
  client: PoolClient,
  creditId: string,
  actorId: string,
  reason = "vendor credit voided"
): Promise<ReverseResult> {
  const header = await loadHeader(client, creditId);
  if (!header) return { status: "nothing_to_reverse" };
  const day = getBusinessDateString(header.voided_at ?? header.credit_date);
  return reverseDocumentJournal(client, {
    source_kind: "vendor_credit",
    source_id: creditId,
    day,
    reason,
    actor_id: actorId,
  });
}
