import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { buildSalesTaxAdjustmentLines } from "../lines/sales-tax";
import { postDocumentJournal, reverseDocumentJournal, runInPostingTransaction } from "../post";
import { LedgerError } from "../types";
import { clientInTransactionAsKnex } from "../../quickbooks/gl-documents/db-adapters";
import { enqueueGlDocumentAdd, enqueueGlDocumentVoid } from "../../quickbooks/gl-documents/enqueue";
import { fixedDirectionFor, type AdjustmentDirection, type AdjustmentType } from "../../sales-tax/remittance";

import type { PostGlDocumentResult } from "./journal-entry";
import {
  allocateGlNumber,
  assertStatus,
  loadActiveAccounts,
  newGlId,
  reversalDay,
  toAccountSnapshot,
  type AccountSnapshot,
  type GlDocumentStatus,
} from "./manual-shared";

/**
 * `gl_sales_tax_adjustment` — "Adjust Sales Tax Due" (sales-tax-center-20260917).
 * Documento GL propio (STA-####): create+post en UNA transacción, void = reversa.
 * En QuickBooks es un JournalEntry con el vendor (FL DOR) en la línea del
 * payable — exactamente lo que crea la ventana Adjust Sales Tax Due.
 */

export interface SalesTaxAdjustmentDto {
  id: string;
  doc_number: string;
  period: string;
  day: string;
  type: AdjustmentType;
  direction: AdjustmentDirection;
  amount_cents: string;
  payable_list_id: string;
  payable_snapshot: AccountSnapshot;
  offset_account_list_id: string;
  offset_snapshot: AccountSnapshot;
  vendor_list_id: string | null;
  vendor_name: string | null;
  reason: string | null;
  memo: string | null;
  applied_payment_id: string | null;
  status: GlDocumentStatus;
  entry_id: string | null;
  posted_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  created_by: string;
  created_at: string;
  qb_txn_id: string | null;
  qb_synced_at: string | null;
  qb_source: "adopted" | null;
}

export interface SalesTaxAdjustmentInput {
  period: string;
  day: string;
  type: AdjustmentType;
  /** Obligatoria sólo para `rounding` / `other`; los demás tipos la fijan. */
  direction?: AdjustmentDirection;
  amount_cents: bigint;
  payable_list_id: string;
  offset_account_list_id: string;
  vendor_list_id: string | null;
  vendor_name: string | null;
  reason?: string | null;
  memo?: string | null;
}

const SELECT = `SELECT id, doc_number, period, day::text AS day, type, direction, amount_cents::text AS amount_cents,
  payable_list_id, payable_snapshot, offset_account_list_id, offset_snapshot, vendor_list_id, vendor_name, reason, memo,
  applied_payment_id, status, entry_id, posted_at::text AS posted_at, voided_at::text AS voided_at, void_reason,
  created_by, created_at::text AS created_at, qb_txn_id, qb_synced_at::text AS qb_synced_at, qb_source
  FROM gl_sales_tax_adjustment`;

export async function getSalesTaxAdjustment(client: PoolClient, id: string): Promise<SalesTaxAdjustmentDto | null> {
  const { rows } = await client.query<SalesTaxAdjustmentDto>(`${SELECT} WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return rows[0] ?? null;
}

export async function listSalesTaxAdjustments(
  client: PoolClient,
  filter: { period?: string | null; limit?: number }
): Promise<SalesTaxAdjustmentDto[]> {
  const { rows } = await client.query<SalesTaxAdjustmentDto>(
    `${SELECT} WHERE deleted_at IS NULL AND ($1::text IS NULL OR period = $1)
      ORDER BY day DESC, doc_number DESC LIMIT $2`,
    [filter.period ?? null, Math.min(Math.max(filter.limit ?? 200, 1), 500)]
  );
  return rows;
}

/** Ajustes VIVOS (posted, no anulados) de un período que ningún pago aplicó todavía. */
export async function listUnappliedAdjustments(client: PoolClient, period: string): Promise<SalesTaxAdjustmentDto[]> {
  const { rows } = await client.query<SalesTaxAdjustmentDto>(
    `${SELECT} WHERE deleted_at IS NULL AND period = $1 AND status = 'posted' AND applied_payment_id IS NULL
      ORDER BY day ASC, doc_number ASC`,
    [period]
  );
  return rows;
}

function resolveDirection(input: SalesTaxAdjustmentInput): AdjustmentDirection {
  const fixed = fixedDirectionFor(input.type);
  if (fixed) return fixed;
  if (!input.direction) throw new LedgerError("GL_SOURCE_INVALID", { reason: "direction_required", type: input.type });
  return input.direction;
}

/** Crea Y postea (un ajuste no tiene estado borrador útil); encola el JournalEntry a QuickBooks. */
export async function createSalesTaxAdjustment(
  client: PoolClient,
  input: SalesTaxAdjustmentInput,
  actorId: string
): Promise<{ adjustment: SalesTaxAdjustmentDto; post: PostGlDocumentResult }> {
  const id = newGlId("gsta");
  const post = await runInPostingTransaction(client, async () => {
    const direction = resolveDirection(input);
    const accounts = await loadActiveAccounts(client, [input.payable_list_id, input.offset_account_list_id]);
    const payable = accounts.get(input.payable_list_id)!;
    const offset = accounts.get(input.offset_account_list_id)!;
    const lines = buildSalesTaxAdjustmentLines({ payable, offset, direction, amount_cents: input.amount_cents });
    const docNumber = await allocateGlNumber(client, "gl_sales_tax_adjustment", "STA");
    await client.query(
      `INSERT INTO gl_sales_tax_adjustment (id, doc_number, period, day, type, direction, amount_cents, payable_list_id,
         payable_snapshot, offset_account_list_id, offset_snapshot, vendor_list_id, vendor_name, reason, memo, status, created_by)
       VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12,$13,$14,$15,'draft',$16)`,
      [
        id, docNumber, input.period, input.day, input.type, direction, input.amount_cents.toString(),
        input.payable_list_id, JSON.stringify(toAccountSnapshot(payable)),
        input.offset_account_list_id, JSON.stringify(toAccountSnapshot(offset)),
        input.vendor_list_id, input.vendor_name, input.reason ?? null, input.memo ?? null, actorId,
      ]
    );
    const header = (await getSalesTaxAdjustment(client, id))!;
    const sourceSnapshot = { header };
    const sourceHash = createHash("sha256").update(JSON.stringify(sourceSnapshot)).digest("hex");
    const result = await postDocumentJournal(client, {
      source_kind: "sales_tax_adjustment",
      source_id: id,
      document_number: docNumber,
      day: input.day,
      reference: docNumber,
      description: `Sales Tax Adjustment ${docNumber} — ${input.type} ${input.period}`,
      lines,
      source_snapshot: sourceSnapshot,
      source_hash: sourceHash,
      actor_id: actorId,
    });
    if (result.status === "skipped") throw new LedgerError("GL_SOURCE_INVALID", { reason: result.reason });
    await client.query(
      `UPDATE gl_sales_tax_adjustment SET status = 'posted', entry_id = $2, posted_at = now(), updated_at = now() WHERE id = $1`,
      [id, result.entry_id]
    );
    const qb = await enqueueGlDocumentAdd(clientInTransactionAsKnex(client), "gl_sales_tax_adjustment", id);
    return { status: result.status, entry_id: result.entry_id, qb } as PostGlDocumentResult;
  });
  return { adjustment: (await getSalesTaxAdjustment(client, id))!, post };
}

/** Reversa + `voided`. Un ajuste ya APLICADO a un pago vivo no se anula: primero se anula el pago. */
export async function voidSalesTaxAdjustment(
  client: PoolClient,
  id: string,
  reason: string,
  actorId: string
): Promise<SalesTaxAdjustmentDto> {
  await runInPostingTransaction(client, async () => {
    const header = await getSalesTaxAdjustment(client, id);
    if (!header) throw new LedgerError("GL_DOCUMENT_NOT_FOUND", { id });
    if (header.status === "voided") throw new LedgerError("GL_DOCUMENT_NOT_POSTED", { id, status: header.status });
    if (header.applied_payment_id)
      throw new LedgerError("GL_SOURCE_INVALID", { reason: "adjustment_applied", payment_id: header.applied_payment_id });
    if (header.status === "posted")
      await reverseDocumentJournal(client, {
        source_kind: "sales_tax_adjustment",
        source_id: id,
        day: reversalDay(header.day),
        reason,
        actor_id: actorId,
      });
    else assertStatus(header.status, "draft", id);
    await client.query(
      `UPDATE gl_sales_tax_adjustment SET status = 'voided', voided_at = now(), void_reason = $2, updated_at = now() WHERE id = $1`,
      [id, reason]
    );
    await enqueueGlDocumentVoid(clientInTransactionAsKnex(client), "gl_sales_tax_adjustment", id);
  });
  return (await getSalesTaxAdjustment(client, id))!;
}
