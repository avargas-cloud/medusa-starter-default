import type { PoolClient } from "pg";

import type { BankCheckKind } from "../lines/bank-check";

import { listDocuments, type ListFilters, type ListPage } from "./manual-list";
import { AccountSnapshot, GlDocumentStatus } from "./manual-shared";

/**
 * Lado de LECTURA de `gl_check` / `gl_check_line` (DDL:
 * `1789300000000-GlManualDocuments.ts`): tipos, DTO, `get` y `list`. La
 * escritura (create/update/post/void) vive en `bank-check.ts`.
 */
export type CheckPayeeType = "vendor" | "customer" | "other";

export interface BankCheckLineInput {
  account_list_id: string;
  amount_cents: bigint;
  memo?: string | null;
  customer_id?: string | null;
  billable?: boolean;
}

export interface BankCheckWriteInput {
  day: string;
  bank_account_list_id: string;
  /** Número de cheque físico; su presencia decide `kind` (`check` vs `expense`). */
  number?: string | null;
  payee_type: CheckPayeeType;
  payee_id?: string | null;
  payee_name: string;
  memo?: string | null;
  to_be_printed?: boolean;
  evidence_id?: string | null;
  lines: BankCheckLineInput[];
}

export interface BankCheckLineDto {
  id: string;
  sort_order: number;
  account_list_id: string;
  account_snapshot: AccountSnapshot;
  amount_cents: number;
  memo: string | null;
  customer_id: string | null;
  billable: boolean;
}

export interface BankCheckDto {
  id: string;
  number: string | null;
  doc_number: string;
  kind: BankCheckKind;
  day: string;
  bank_account_list_id: string;
  bank_account_snapshot: AccountSnapshot;
  payee_type: CheckPayeeType;
  payee_id: string | null;
  payee_name: string;
  memo: string | null;
  total_cents: number;
  status: GlDocumentStatus;
  entry_id: string | null;
  posted_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  to_be_printed: boolean;
  evidence_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  lines: BankCheckLineDto[];
}

export type HeaderRow = Omit<BankCheckDto, "lines" | "total_cents"> & {
  total_cents: string;
};
export type LineRow = Omit<BankCheckLineDto, "amount_cents"> & {
  check_id: string;
  amount_cents: string;
};

const HEADER_COLUMNS = `d.id, d.number, d.doc_number, d.kind, d.day::text AS day, d.bank_account_list_id,
  d.bank_account_snapshot, d.payee_type, d.payee_id, d.payee_name, d.memo, d.total_cents::text AS total_cents,
  d.status, d.entry_id, d.posted_at::text AS posted_at, d.voided_at::text AS voided_at, d.void_reason,
  d.to_be_printed, d.evidence_id, d.created_by, d.created_at::text AS created_at, d.updated_at::text AS updated_at`;

export async function loadLines(
  client: PoolClient,
  ids: string[]
): Promise<Map<string, LineRow[]>> {
  const byDoc = new Map<string, LineRow[]>();
  if (!ids.length) return byDoc;
  const { rows } = await client.query<LineRow>(
    `SELECT id, check_id, sort_order, account_list_id, account_snapshot, amount_cents::text, memo, customer_id, billable
     FROM gl_check_line WHERE check_id = ANY($1::text[]) ORDER BY check_id, sort_order`,
    [ids]
  );
  for (const row of rows) {
    const bucket = byDoc.get(row.check_id) ?? [];
    bucket.push(row);
    byDoc.set(row.check_id, bucket);
  }
  return byDoc;
}

function toDto(header: HeaderRow, lines: LineRow[]): BankCheckDto {
  return {
    ...header,
    total_cents: Number(header.total_cents),
    lines: lines.map(({ check_id: _checkId, ...l }) => ({
      ...l,
      amount_cents: Number(l.amount_cents),
    })),
  };
}

export async function loadHeader(
  client: PoolClient,
  id: string,
  forUpdate = false
): Promise<HeaderRow | null> {
  const { rows } = await client.query<HeaderRow>(
    `SELECT ${HEADER_COLUMNS} FROM gl_check d WHERE d.id = $1 AND d.deleted_at IS NULL${forUpdate ? " FOR UPDATE" : ""}`,
    [id]
  );
  return rows[0] ?? null;
}

export async function getBankCheck(
  client: PoolClient,
  id: string
): Promise<BankCheckDto | null> {
  const header = await loadHeader(client, id);
  if (!header) return null;
  return toDto(header, (await loadLines(client, [id])).get(id) ?? []);
}

export async function listBankChecks(
  client: PoolClient,
  filters: ListFilters
): Promise<ListPage<BankCheckDto>> {
  const page = await listDocuments<HeaderRow>(
    client,
    {
      table: "gl_check",
      columns: HEADER_COLUMNS,
      accountClause:
        "(d.bank_account_list_id = {{p}} OR EXISTS (SELECT 1 FROM gl_check_line l WHERE l.check_id = d.id AND l.account_list_id = {{p}}))",
      searchColumns: ["d.doc_number", "d.number", "d.payee_name", "d.memo"],
    },
    filters
  );
  const lines = await loadLines(
    client,
    page.items.map((h) => h.id)
  );
  return {
    items: page.items.map((h) => toDto(h, lines.get(h.id) ?? [])),
    next_cursor: page.next_cursor,
  };
}
