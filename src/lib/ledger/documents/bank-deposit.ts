import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { loadAccountMapByKeys } from "../accounts";
import { buildBankDepositLines, type BankDepositLineInput } from "../lines/bank-deposit";
import { depositSignedCents } from "../../banking/deposit-types";
import { activeDocumentEntry, postDocumentJournal, reverseDocumentJournal } from "../post";
import { LedgerAccount, LedgerError, LedgerLine, PostResult, ReverseResult } from "../types";

import { allocateGlNumber, loadActiveAccounts } from "./manual-shared";

/**
 * record-deposits-gl-20260915 — `bank_deposit` como documento del GL.
 *
 * El depósito (header + líneas) vive en las tablas de Banking; acá vive lo
 * que lo convierte en asiento: Dr cuenta destino por el neto, Cr Undeposited
 * Funds por cada cobro (`customer_payment` ya reconoció UF al cobrar) o la
 * cuenta declarada por una línea manual, Dr comisión. `source_kind =
 * 'bank_deposit'`, `source_id = bank_deposit.id`, número `DEP-####`.
 *
 * Los depósitos ADOPTADOS de QuickBooks (adopt-qb-deposits.ts) no pasan por
 * acá: su asiento ya existía como `qb_import` y sólo se re-parenta.
 */

export type DepositHeaderRow = {
  id: string;
  number: string | null;
  status: string;
  account_id: string | null;
  account_list_id: string | null;
  bank_qb_list_id: string | null;
  deposit_date: string;
  reference: string;
  memo: string;
  gross_amount: string;
  fee_amount: string;
  net_amount: string;
  fee_account_list_id: string | null;
  fee_reference: string | null;
};

export type DepositLineRow = {
  id: string;
  payment_id: string | null;
  manual_reference: string | null;
  manual_description: string | null;
  manual_account_list_id: string | null;
  opening_item_id: string | null;
  amount: string;
  payment_display_id: number | null;
  customer_name: string | null;
};

export interface ResolvedBankDeposit {
  header: DepositHeaderRow;
  lines: DepositLineRow[];
  bankAccount: LedgerAccount;
  ledgerLines: LedgerLine[];
  /** ListID de la cuenta destino efectivamente usada (`account_list_id`, o el espejo de la cuenta Plaid). */
  targetListId: string;
}

/** "123.45" → 12345n — los montos de `bank_deposit` son texto en dólares con
 * 2 decimales (NO cents como `customer_payment.amount`); `centsFromNumeric`
 * los truncaría a "123". */
export function depositMajorToCents(value: string): bigint {
  return depositSignedCents(value);
}

export async function loadDepositHeader(
  client: PoolClient,
  id: string,
  forUpdate = false
): Promise<DepositHeaderRow | null> {
  const { rows } = await client.query<DepositHeaderRow>(
    `SELECT d.id, d.number, d.status, d.account_id, d.account_list_id, a.qb_list_id AS bank_qb_list_id,
            d.deposit_date, d.reference, d.memo, d.gross_amount, d.fee_amount, d.net_amount,
            d.fee_account_list_id, d.fee_reference
       FROM bank_deposit d LEFT JOIN bank_account a ON a.id = d.account_id
      WHERE d.id = $1 AND d.deleted_at IS NULL${forUpdate ? " FOR UPDATE OF d" : ""}`,
    [id]
  );
  return rows[0] ?? null;
}

export async function loadDepositLines(
  client: PoolClient,
  id: string
): Promise<DepositLineRow[]> {
  const { rows } = await client.query<DepositLineRow>(
    `SELECT l.id, l.payment_id, l.manual_reference, l.manual_description, l.manual_account_list_id,
            l.opening_item_id, l.amount,
            (l.payment_snapshot->>'display_id')::int AS payment_display_id,
            l.payment_snapshot->>'customer_name' AS customer_name
       FROM bank_deposit_line l
      WHERE l.deposit_id = $1 AND l.deleted_at IS NULL
      ORDER BY l.created_at ASC, l.id ASC`,
    [id]
  );
  return rows;
}

function lineMemo(line: DepositLineRow): string {
  if (line.payment_id) {
    const who = line.customer_name?.trim();
    return `Payment ${line.payment_display_id ?? line.payment_id}${who ? ` · ${who}` : ""}`;
  }
  return [line.manual_reference?.trim(), line.manual_description?.trim()]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Resuelve el depósito contra cuentas ACTIVAS y arma las líneas del asiento.
 * Falla cerrado (`GL_SOURCE_INVALID`) si el destino no resuelve, si una línea
 * manual apunta a una cuenta inactiva, o si el depósito no tiene líneas.
 */
export async function resolveBankDeposit(
  client: PoolClient,
  id: string
): Promise<ResolvedBankDeposit> {
  const header = await loadDepositHeader(client, id);
  if (!header) throw new LedgerError("GL_DOCUMENT_NOT_FOUND", { id });
  const lines = await loadDepositLines(client, id);
  if (lines.length === 0)
    throw new LedgerError("GL_SOURCE_INVALID", { reason: "deposit_without_lines", id });
  if (lines.some((l) => l.opening_item_id))
    throw new LedgerError("GL_SOURCE_INVALID", { reason: "opening_item_line", id });

  const targetListId = header.account_list_id ?? header.bank_qb_list_id;
  if (!targetListId)
    throw new LedgerError("GL_SOURCE_INVALID", { reason: "deposit_target_not_in_quickbooks", id });

  const uf = (await loadAccountMapByKeys(client, ["undeposited_funds"])).undeposited_funds!;
  const accounts = await loadActiveAccounts(client, [
    targetListId,
    ...lines.flatMap((l) => (l.manual_account_list_id ? [l.manual_account_list_id] : [])),
    ...(header.fee_account_list_id ? [header.fee_account_list_id] : []),
  ]);
  const bankAccount = accounts.get(targetListId)!;

  const lineInputs: BankDepositLineInput[] = lines.map((line) => ({
    account: line.manual_account_list_id ? accounts.get(line.manual_account_list_id)! : uf,
    amount_cents: depositMajorToCents(line.amount),
    memo: lineMemo(line),
  }));
  const feeCents = depositMajorToCents(header.fee_amount || "0");
  const fee =
    feeCents > 0n && header.fee_account_list_id
      ? {
          account: accounts.get(header.fee_account_list_id)!,
          amount_cents: feeCents,
          memo: header.fee_reference ? `Fee ${header.fee_reference}` : "Fee",
        }
      : null;
  const ledgerLines = buildBankDepositLines({ bankAccount, lines: lineInputs, fee });
  return { header, lines, bankAccount, ledgerLines, targetListId };
}

export async function ensureDepositNumber(
  client: PoolClient,
  id: string
): Promise<string> {
  const { rows } = await client.query<{ number: string | null }>(
    `SELECT number FROM bank_deposit WHERE id = $1 FOR UPDATE`,
    [id]
  );
  if (rows[0]?.number) return rows[0].number;
  const number = await allocateGlNumber(client, "bank_deposit", "DEP");
  await client.query(`UPDATE bank_deposit SET number = $2, updated_at = now() WHERE id = $1`, [id, number]);
  return number;
}

/**
 * Postea el documento. Idempotente por `(bank_deposit, id)` como todo
 * documento del GL. El caller (Banking) ya validó la evidencia y sostiene la
 * transacción; acá no se abre otra.
 */
export async function postBankDepositDocument(
  client: PoolClient,
  resolved: ResolvedBankDeposit,
  actorId: string
): Promise<PostResult> {
  const { header, lines, ledgerLines } = resolved;
  const number = header.number ?? (await ensureDepositNumber(client, header.id));
  const sourceSnapshot = { header: { ...header, number }, lines };
  const sourceHash = createHash("sha256")
    .update(JSON.stringify(sourceSnapshot))
    .digest("hex");
  const label = header.reference?.trim() ? `Deposit ${header.reference.trim()}` : `Deposit ${header.deposit_date}`;
  return postDocumentJournal(client, {
    source_kind: "bank_deposit",
    source_id: header.id,
    document_number: number,
    day: header.deposit_date,
    reference: header.reference?.trim() ? `${number} · ${header.reference.trim()}` : number,
    description: `${label} → ${resolved.bankAccount.name}`,
    lines: ledgerLines,
    source_snapshot: sourceSnapshot,
    source_hash: sourceHash,
    actor_id: actorId,
  });
}

export async function reverseBankDepositDocument(
  client: PoolClient,
  id: string,
  day: string,
  reason: string,
  actorId: string
): Promise<ReverseResult> {
  return reverseDocumentJournal(client, {
    source_kind: "bank_deposit",
    source_id: id,
    day,
    reason,
    actor_id: actorId,
  });
}

export const activeBankDepositEntry = (client: PoolClient, id: string) =>
  activeDocumentEntry(client, "bank_deposit", id);
