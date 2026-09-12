import type { PoolClient } from "pg";

import { listDocuments, type ListFilters, type ListPage } from "./manual-list";
import { AccountSnapshot, GlDocumentStatus } from "./manual-shared";

/**
 * Lado de LECTURA de `gl_journal_entry` (DDL: `1789300000000-GlManualDocuments.ts`):
 * tipos del documento, DTO que viaja al POS, `get` y `list`. La escritura
 * (create/update/post/void) vive en `journal-entry.ts`.
 */
export interface JournalEntryLineInput {
  account_list_id: string;
  debit_cents: bigint;
  credit_cents: bigint;
  memo?: string | null;
  entity_type?: "customer" | "vendor" | null;
  entity_id?: string | null;
  entity_name?: string | null;
}

export interface JournalEntryWriteInput {
  day: string;
  memo?: string | null;
  evidence_id?: string | null;
  lines: JournalEntryLineInput[];
}

export interface JournalEntryLineDto {
  id: string;
  sort_order: number;
  account_list_id: string;
  account_snapshot: AccountSnapshot;
  debit_cents: number;
  credit_cents: number;
  memo: string | null;
  entity_type: "customer" | "vendor" | null;
  entity_id: string | null;
  entity_name: string | null;
}

export interface JournalEntryDto {
  id: string;
  number: string;
  day: string;
  memo: string | null;
  status: GlDocumentStatus;
  total_cents: number;
  entry_id: string | null;
  posted_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  evidence_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  lines: JournalEntryLineDto[];
}

export type HeaderRow = Omit<JournalEntryDto, "lines" | "total_cents">;
export type LineRow = Omit<
  JournalEntryLineDto,
  "debit_cents" | "credit_cents"
> & {
  journal_entry_id: string;
  debit_cents: string;
  credit_cents: string;
};

const HEADER_COLUMNS = `d.id, d.number, d.day::text AS day, d.memo, d.status, d.entry_id,
  d.posted_at::text AS posted_at, d.voided_at::text AS voided_at, d.void_reason, d.evidence_id,
  d.created_by, d.created_at::text AS created_at, d.updated_at::text AS updated_at`;

export async function loadLines(
  client: PoolClient,
  ids: string[]
): Promise<Map<string, LineRow[]>> {
  const byDoc = new Map<string, LineRow[]>();
  if (!ids.length) return byDoc;
  const { rows } = await client.query<LineRow>(
    `SELECT id, journal_entry_id, sort_order, account_list_id, account_snapshot,
            debit_cents::text, credit_cents::text, memo, entity_type, entity_id, entity_name
     FROM gl_journal_entry_line WHERE journal_entry_id = ANY($1::text[])
     ORDER BY journal_entry_id, sort_order`,
    [ids]
  );
  for (const row of rows) {
    const bucket = byDoc.get(row.journal_entry_id) ?? [];
    bucket.push(row);
    byDoc.set(row.journal_entry_id, bucket);
  }
  return byDoc;
}

function toDto(header: HeaderRow, lines: LineRow[]): JournalEntryDto {
  let total = 0n;
  const dtoLines = lines.map((l) => {
    total += BigInt(l.debit_cents);
    return {
      id: l.id,
      sort_order: l.sort_order,
      account_list_id: l.account_list_id,
      account_snapshot: l.account_snapshot,
      debit_cents: Number(l.debit_cents),
      credit_cents: Number(l.credit_cents),
      memo: l.memo,
      entity_type: l.entity_type,
      entity_id: l.entity_id,
      entity_name: l.entity_name,
    };
  });
  return { ...header, total_cents: Number(total), lines: dtoLines };
}

export async function loadHeader(
  client: PoolClient,
  id: string,
  forUpdate = false
): Promise<HeaderRow | null> {
  const { rows } = await client.query<HeaderRow>(
    `SELECT ${HEADER_COLUMNS} FROM gl_journal_entry d WHERE d.id = $1 AND d.deleted_at IS NULL${forUpdate ? " FOR UPDATE" : ""}`,
    [id]
  );
  return rows[0] ?? null;
}

export async function getJournalEntry(
  client: PoolClient,
  id: string
): Promise<JournalEntryDto | null> {
  const header = await loadHeader(client, id);
  if (!header) return null;
  const lines = await loadLines(client, [id]);
  return toDto(header, lines.get(id) ?? []);
}

export async function listJournalEntries(
  client: PoolClient,
  filters: ListFilters
): Promise<ListPage<JournalEntryDto>> {
  const page = await listDocuments<HeaderRow>(
    client,
    {
      table: "gl_journal_entry",
      columns: HEADER_COLUMNS,
      accountClause:
        "EXISTS (SELECT 1 FROM gl_journal_entry_line l WHERE l.journal_entry_id = d.id AND l.account_list_id = {{p}})",
      searchColumns: ["d.number", "d.memo"],
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
