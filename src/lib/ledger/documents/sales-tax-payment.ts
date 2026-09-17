import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { buildSalesTaxPaymentLines, salesTaxPaymentTotal } from "../lines/sales-tax";
import { postDocumentJournal, reverseDocumentJournal, runInPostingTransaction } from "../post";
import { LedgerError } from "../types";
import { clientInTransactionAsKnex } from "../../quickbooks/gl-documents/db-adapters";
import { enqueueGlDocumentAdd, enqueueGlDocumentVoid } from "../../quickbooks/gl-documents/enqueue";
import { signedAdjustment } from "../../sales-tax/remittance";

import type { PostGlDocumentResult } from "./journal-entry";
import {
  allocateGlNumber,
  loadActiveAccounts,
  newGlId,
  reversalDay,
  toAccountSnapshot,
  type AccountSnapshot,
  type GlDocumentStatus,
} from "./manual-shared";
import { getSalesTaxAdjustment, type SalesTaxAdjustmentDto } from "./sales-tax-adjustment";

/**
 * `gl_sales_tax_payment` — "Pay Sales Tax" (sales-tax-center-20260917).
 * STP-####: create+post en UNA transacción (un pago no tiene borrador útil),
 * void = reversa + TxnVoid. Líneas: `tax` (el bruto del período, con el
 * ItemSalesTax de QB) y `adjustment` (cada STA aplicado, con signo). El asiento
 * es Dr payable / Cr banco por el NETO; QuickBooks recibe la forma de dos
 * líneas de la ventana Pay Sales Tax (ver `facts-sales-tax.ts`).
 */

export interface SalesTaxPaymentLineDto {
  id: string;
  sort_order: number;
  kind: "tax" | "adjustment";
  item_sales_tax_list_id: string | null;
  adjustment_id: string | null;
  amount_cents: string;
  memo: string | null;
}

export interface SalesTaxPaymentDto {
  id: string;
  doc_number: string;
  period: string;
  day: string;
  bank_account_list_id: string;
  bank_account_snapshot: AccountSnapshot;
  payable_list_id: string;
  vendor_list_id: string | null;
  vendor_name: string;
  tax_item_list_id: string | null;
  tax_item_name: string | null;
  tax_cents: string;
  adjustments_cents: string;
  total_cents: string;
  reference: string | null;
  memo: string | null;
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
  lines: SalesTaxPaymentLineDto[];
}

export interface SalesTaxPaymentInput {
  period: string;
  day: string;
  bank_account_list_id: string;
  payable_list_id: string;
  vendor_list_id: string | null;
  vendor_name: string;
  tax_item_list_id: string | null;
  tax_item_name: string | null;
  tax_cents: bigint;
  /** STA posteados del período que este pago aplica (la remesa los descuenta/suma). */
  adjustment_ids: string[];
  reference?: string | null;
  memo?: string | null;
}

const SELECT = `SELECT id, doc_number, period, day::text AS day, bank_account_list_id, bank_account_snapshot, payable_list_id,
  vendor_list_id, vendor_name, tax_item_list_id, tax_item_name, tax_cents::text AS tax_cents,
  adjustments_cents::text AS adjustments_cents, total_cents::text AS total_cents, reference, memo, status, entry_id,
  posted_at::text AS posted_at, voided_at::text AS voided_at, void_reason, created_by, created_at::text AS created_at,
  qb_txn_id, qb_synced_at::text AS qb_synced_at, qb_source FROM gl_sales_tax_payment`;

async function attachLines(client: PoolClient, docs: Omit<SalesTaxPaymentDto, "lines">[]): Promise<SalesTaxPaymentDto[]> {
  if (docs.length === 0) return [];
  const { rows } = await client.query<SalesTaxPaymentLineDto & { payment_id: string }>(
    `SELECT id, payment_id, sort_order, kind, item_sales_tax_list_id, adjustment_id, amount_cents::text AS amount_cents, memo
       FROM gl_sales_tax_payment_line WHERE payment_id = ANY($1::text[]) ORDER BY payment_id, sort_order`,
    [docs.map((d) => d.id)]
  );
  const byDoc = new Map<string, SalesTaxPaymentLineDto[]>();
  for (const { payment_id, ...line } of rows) {
    if (!byDoc.has(payment_id)) byDoc.set(payment_id, []);
    byDoc.get(payment_id)!.push(line);
  }
  return docs.map((d) => ({ ...d, lines: byDoc.get(d.id) ?? [] }));
}

export async function getSalesTaxPayment(client: PoolClient, id: string): Promise<SalesTaxPaymentDto | null> {
  const { rows } = await client.query<Omit<SalesTaxPaymentDto, "lines">>(`${SELECT} WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return (await attachLines(client, rows))[0] ?? null;
}

export async function listSalesTaxPayments(
  client: PoolClient,
  filter: { period?: string | null; limit?: number }
): Promise<SalesTaxPaymentDto[]> {
  const { rows } = await client.query<Omit<SalesTaxPaymentDto, "lines">>(
    `${SELECT} WHERE deleted_at IS NULL AND ($1::text IS NULL OR period = $1) ORDER BY day DESC, doc_number DESC LIMIT $2`,
    [filter.period ?? null, Math.min(Math.max(filter.limit ?? 200, 1), 500)]
  );
  return attachLines(client, rows);
}

async function loadApplicableAdjustments(client: PoolClient, input: SalesTaxPaymentInput): Promise<SalesTaxAdjustmentDto[]> {
  const out: SalesTaxAdjustmentDto[] = [];
  for (const id of [...new Set(input.adjustment_ids)]) {
    const adj = await getSalesTaxAdjustment(client, id);
    if (!adj) throw new LedgerError("GL_DOCUMENT_NOT_FOUND", { id });
    if (adj.status !== "posted" || adj.applied_payment_id || adj.period !== input.period)
      throw new LedgerError("GL_SOURCE_INVALID", {
        reason: "adjustment_not_applicable",
        adjustment_id: id,
        status: adj.status,
        applied_payment_id: adj.applied_payment_id,
        period: adj.period,
      });
    out.push(adj);
  }
  return out;
}

/** Crea Y postea; marca los STA como aplicados; encola el SalesTaxPaymentCheckAdd. */
export async function createSalesTaxPayment(
  client: PoolClient,
  input: SalesTaxPaymentInput,
  actorId: string
): Promise<{ payment: SalesTaxPaymentDto; post: PostGlDocumentResult }> {
  const id = newGlId("gstp");
  const post = await runInPostingTransaction(client, async () => {
    // Un solo pago vivo por período (índice parcial uq_gl_sales_tax_payment_period_live): se contesta
    // 409 con el número del que ya existe, no un error de unique del driver.
    const live = await client.query<{ doc_number: string }>(
      `SELECT doc_number FROM gl_sales_tax_payment WHERE period = $1 AND deleted_at IS NULL AND status <> 'voided' LIMIT 1`,
      [input.period]
    );
    if (live.rows[0]) throw new LedgerError("GL_ALREADY_POSTED", { period: input.period, doc_number: live.rows[0].doc_number });
    const accounts = await loadActiveAccounts(client, [input.bank_account_list_id, input.payable_list_id]);
    const bankAccount = accounts.get(input.bank_account_list_id)!;
    const payable = accounts.get(input.payable_list_id)!;
    const adjustments = await loadApplicableAdjustments(client, input);
    const adjustmentCents = adjustments.map((a) => signedAdjustment(a.direction, BigInt(a.amount_cents)));
    const ledgerLines = buildSalesTaxPaymentLines({ payable, bankAccount, tax_cents: input.tax_cents, adjustment_cents: adjustmentCents });
    const total = salesTaxPaymentTotal({ tax_cents: input.tax_cents, adjustment_cents: adjustmentCents });
    const adjustmentsTotal = adjustmentCents.reduce((acc, c) => acc + c, 0n);
    const docNumber = await allocateGlNumber(client, "gl_sales_tax_payment", "STP");
    await client.query(
      `INSERT INTO gl_sales_tax_payment (id, doc_number, period, day, bank_account_list_id, bank_account_snapshot, payable_list_id,
         payable_snapshot, vendor_list_id, vendor_name, tax_item_list_id, tax_item_name, tax_cents, adjustments_cents, total_cents,
         reference, memo, status, created_by)
       VALUES ($1,$2,$3,$4::date,$5,$6::jsonb,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,'draft',$18)`,
      [
        id, docNumber, input.period, input.day, input.bank_account_list_id, JSON.stringify(toAccountSnapshot(bankAccount)),
        input.payable_list_id, JSON.stringify(toAccountSnapshot(payable)), input.vendor_list_id, input.vendor_name,
        input.tax_item_list_id, input.tax_item_name, input.tax_cents.toString(), adjustmentsTotal.toString(), total.toString(),
        input.reference ?? null, input.memo ?? null, actorId,
      ]
    );
    await client.query(
      `INSERT INTO gl_sales_tax_payment_line (id, payment_id, sort_order, kind, item_sales_tax_list_id, amount_cents, memo)
       VALUES ($1,$2,1,'tax',$3,$4,$5)`,
      [newGlId("gstpl"), id, input.tax_item_list_id, input.tax_cents.toString(), input.tax_item_name]
    );
    for (const [i, adj] of adjustments.entries()) {
      await client.query(
        `INSERT INTO gl_sales_tax_payment_line (id, payment_id, sort_order, kind, adjustment_id, amount_cents, memo)
         VALUES ($1,$2,$3,'adjustment',$4,$5,$6)`,
        [newGlId("gstpl"), id, i + 2, adj.id, (adjustmentCents[i] ?? 0n).toString(), `${adj.doc_number} ${adj.type}`]
      );
      await client.query(`UPDATE gl_sales_tax_adjustment SET applied_payment_id = $2, updated_at = now() WHERE id = $1`, [adj.id, id]);
    }
    const header = (await getSalesTaxPayment(client, id))!;
    const sourceSnapshot = { header };
    const sourceHash = createHash("sha256").update(JSON.stringify(sourceSnapshot)).digest("hex");
    const result = await postDocumentJournal(client, {
      source_kind: "sales_tax_payment",
      source_id: id,
      document_number: docNumber,
      day: input.day,
      reference: input.reference ? `${docNumber} #${input.reference}` : docNumber,
      description: `Sales Tax Payment ${docNumber} — ${input.vendor_name} (${input.period})`,
      lines: ledgerLines,
      source_snapshot: sourceSnapshot,
      source_hash: sourceHash,
      actor_id: actorId,
    });
    if (result.status === "skipped") throw new LedgerError("GL_SOURCE_INVALID", { reason: result.reason });
    await client.query(
      `UPDATE gl_sales_tax_payment SET status = 'posted', entry_id = $2, posted_at = now(), updated_at = now() WHERE id = $1`,
      [id, result.entry_id]
    );
    const qb = await enqueueGlDocumentAdd(clientInTransactionAsKnex(client), "gl_sales_tax_payment", id);
    return { status: result.status, entry_id: result.entry_id, qb } as PostGlDocumentResult;
  });
  return { payment: (await getSalesTaxPayment(client, id))!, post };
}

/** Reversa + `voided` + libera los STA aplicados (vuelven a estar disponibles); encola el TxnVoid. */
export async function voidSalesTaxPayment(
  client: PoolClient,
  id: string,
  reason: string,
  actorId: string
): Promise<SalesTaxPaymentDto> {
  await runInPostingTransaction(client, async () => {
    const header = await getSalesTaxPayment(client, id);
    if (!header) throw new LedgerError("GL_DOCUMENT_NOT_FOUND", { id });
    if (header.status !== "posted") throw new LedgerError("GL_DOCUMENT_NOT_POSTED", { id, status: header.status });
    await reverseDocumentJournal(client, {
      source_kind: "sales_tax_payment",
      source_id: id,
      day: reversalDay(header.day),
      reason,
      actor_id: actorId,
    });
    await client.query(
      `UPDATE gl_sales_tax_payment SET status = 'voided', voided_at = now(), void_reason = $2, updated_at = now() WHERE id = $1`,
      [id, reason]
    );
    await client.query(
      `UPDATE gl_sales_tax_adjustment SET applied_payment_id = NULL, updated_at = now() WHERE applied_payment_id = $1`,
      [id]
    );
    await enqueueGlDocumentVoid(clientInTransactionAsKnex(client), "gl_sales_tax_payment", id);
  });
  return (await getSalesTaxPayment(client, id))!;
}
