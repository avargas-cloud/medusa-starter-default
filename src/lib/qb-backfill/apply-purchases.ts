/**
 * src/lib/qb-backfill/apply-purchases.ts
 *
 * Orquestación de fase 3, parte "documento" (receipt/bill) para
 * `backfill-qb-purchases.ts` — mantiene el script CLI como wiring/reporte y
 * concentra acá el loop transacción-por-documento, para que sea reusable
 * entre dry-run (clasificación) y `--apply`. La parte "dinero"
 * (credit/payment/de-adopt) vive en `apply-purchases-money.ts` — split por
 * el límite de 300 líneas del proyecto; ambos comparten `ApplyContext`,
 * `PoIndexEntry` y `resolveLocalPoByLinkedTxns` exportados de acá.
 */
import type { PoolClient } from "pg";

import type { EnsureLog } from "./ensure";
import { linkedTxnIdsOfType } from "./links";
import type { OpenPoLine } from "./links";
import type { ItemIndex, VendorIndexEntry } from "./resolve";
import { decideReceiptCreation, createReceiptFromQb, type LocalPurchaseOrder } from "./create-receipt";
import { decideBillCreation, createBillFromQb } from "./create-bill";
import type { QbAccountLookupFn } from "./create-bill";
import type { BankAccountLookupFn } from "./create-bill-payment";
import type { QbBill, QbItemReceipt, QbLinkedTxn } from "./types";

export interface PoIndexEntry {
  id: string;
  lines: OpenPoLine[];
}

/** Índice `qb_purchase_order_list_id → {id, líneas}` para resolver PO por TxnID de QB. Se recarga entre tipos (un PO creado por este mismo run debe verse). */
export async function loadPoIndex(client: PoolClient): Promise<Map<string, PoIndexEntry>> {
  const { rows } = await client.query(
    `SELECT po.id, po.qb_purchase_order_list_id, pol.id AS line_id, pol.product_variant_id, pol.qty_ordered
       FROM purchase_order po
       LEFT JOIN purchase_order_line pol ON pol.purchase_order_id = po.id AND pol.deleted_at IS NULL
      WHERE po.deleted_at IS NULL AND po.qb_purchase_order_list_id IS NOT NULL
      ORDER BY po.id, pol.line_order ASC NULLS LAST, pol.id ASC`
  );
  const map = new Map<string, PoIndexEntry>();
  for (const r of rows as { id: string; qb_purchase_order_list_id: string; line_id: string | null; product_variant_id: string | null; qty_ordered: string | number | null }[]) {
    let entry = map.get(r.qb_purchase_order_list_id);
    if (!entry) {
      entry = { id: r.id, lines: [] };
      map.set(r.qb_purchase_order_list_id, entry);
    }
    if (r.line_id) {
      entry.lines.push({
        id: r.line_id,
        product_variant_id: r.product_variant_id,
        qty_ordered: Number(r.qty_ordered ?? 0),
        already_matched: 0,
      });
    }
  }
  return map;
}

export function resolveLocalPoByLinkedTxns(
  linkedTxns: readonly QbLinkedTxn[],
  poIndex: Map<string, PoIndexEntry>
): PoIndexEntry | null {
  for (const txnId of linkedTxnIdsOfType(linkedTxns, "PurchaseOrder")) {
    const found = poIndex.get(txnId);
    if (found) return found;
  }
  return null;
}

export function makeQbAccountLookup(client: PoolClient): QbAccountLookupFn {
  return async (listId: string) => {
    const { rows } = await client.query(
      `SELECT full_name, account_type FROM qb_account WHERE qb_list_id = $1 AND deleted_at IS NULL AND is_active = true LIMIT 1`,
      [listId]
    );
    const r = rows[0] as { full_name: string; account_type: string } | undefined;
    return r ? { full_name: r.full_name, account_type: r.account_type } : null;
  };
}

export function makeBankAccountLookup(client: PoolClient): BankAccountLookupFn {
  return async (listId: string) => {
    const { rows } = await client.query(
      `SELECT qb_list_id, full_name, account_type, currency FROM qb_account
        WHERE qb_list_id = $1 AND deleted_at IS NULL AND is_active = true LIMIT 1`,
      [listId]
    );
    const r = rows[0] as { qb_list_id: string; full_name: string; account_type: string; currency: string | null } | undefined;
    return r ?? null;
  };
}

export interface DocOutcome {
  txn_id: string;
  created?: string; // id del documento creado
  blocked_reason?: string;
}

export interface TypeApplyReport {
  already: number;
  create: number;
  created: DocOutcome[];
  blocked: DocOutcome[];
}

function newReport(): TypeApplyReport {
  return { already: 0, create: 0, created: [], blocked: [] };
}

export interface ApplyContext {
  client: PoolClient;
  runId: string;
  itemIndex: ItemIndex;
  vendorIndex: Map<string, VendorIndexEntry>;
  ensureLog: EnsureLog;
  createdByUserId: string;
  stockLocationId: string;
}

export async function applyReceipts(
  receipts: QbItemReceipt[],
  known: ReadonlySet<string>,
  poIndex: Map<string, PoIndexEntry>,
  ctx: ApplyContext,
  apply: boolean
): Promise<TypeApplyReport> {
  const report = newReport();
  for (const receipt of receipts) {
    const decision = decideReceiptCreation(receipt, known);
    if (decision.reason === "already") { report.already++; continue; }
    report.create++;
    if (!apply) continue;
    const localPo = resolveLocalPoByLinkedTxns(receipt.linked_txns, poIndex);
    try {
      await ctx.client.query("BEGIN");
      const result = await createReceiptFromQb(ctx.client, receipt, {
        runId: ctx.runId,
        itemIndex: ctx.itemIndex,
        ensureLog: ctx.ensureLog,
        createdByUserId: ctx.createdByUserId,
        stockLocationId: ctx.stockLocationId,
        localPo: localPo as LocalPurchaseOrder | null,
      });
      await ctx.client.query("COMMIT");
      report.created.push({ txn_id: receipt.txn_id, created: result.purchase_order_receipt_id });
    } catch (err) {
      await ctx.client.query("ROLLBACK");
      report.blocked.push({ txn_id: receipt.txn_id, blocked_reason: (err as Error).message });
    }
  }
  return report;
}

/** Tras crear/tener bills, enlaza recibos ↔ bill por TxnID (conversión recibo→bill conserva el TxnID; o LinkedTxn tipo ItemReceipt). */
export async function linkReceiptsToBill(
  client: PoolClient,
  billId: string,
  billTxnId: string,
  linkedTxns: readonly QbLinkedTxn[]
): Promise<number> {
  const candidateIds = [billTxnId, ...linkedTxnIdsOfType(linkedTxns, "ItemReceipt")];
  const { rowCount } = await client.query(
    `UPDATE purchase_order_receipt SET vendor_bill_id = $1, updated_at = now()
      WHERE qb_item_receipt_list_id = ANY($2::text[]) AND deleted_at IS NULL AND vendor_bill_id IS NULL`,
    [billId, candidateIds]
  );
  return rowCount ?? 0;
}

/**
 * Bill de QB con líneas de ítem enlazadas a un PO local y SIN ningún recibo
 * propio (ni ya existente, ni recién enlazado) → recibo sintético, para que
 * el PO muestre su historial de recepción. `qb_item_receipt_list_id` = el
 * mismo TxnID del bill (documentado con `[synthetic from bill]` en notes).
 */
export async function maybeCreateSyntheticReceipt(
  bill: QbBill,
  billId: string,
  localPo: PoIndexEntry | null,
  ctx: ApplyContext
): Promise<string | null> {
  if (!localPo || bill.item_lines.length === 0) return null;
  const { rows } = await ctx.client.query(
    `SELECT id FROM purchase_order_receipt WHERE vendor_bill_id = $1 AND deleted_at IS NULL LIMIT 1`,
    [billId]
  );
  if (rows.length > 0) return null; // ya tiene recibo — no crear uno sintético

  const syntheticReceipt: QbItemReceipt = {
    txn_id: bill.txn_id,
    edit_sequence: bill.edit_sequence,
    ref_number: bill.ref_number,
    vendor_ref: bill.vendor_ref,
    txn_date: bill.txn_date,
    total_amount_cents: bill.item_lines.reduce((s, l) => s + l.amount_cents, 0),
    memo: "[synthetic from bill]" + (bill.memo ? ` ${bill.memo}` : ""),
    lines: bill.item_lines.map((l) => ({
      txn_line_id: l.txn_line_id,
      item_ref: l.item_ref,
      description: l.description,
      quantity: l.quantity ?? 1,
      rate_cents: l.rate_cents ?? l.amount_cents,
      amount_cents: l.amount_cents,
      linked_po_txn_id: null,
    })),
    linked_txns: [],
  };
  try {
    const result = await createReceiptFromQb(ctx.client, syntheticReceipt, {
      runId: ctx.runId,
      itemIndex: ctx.itemIndex,
      ensureLog: ctx.ensureLog,
      createdByUserId: ctx.createdByUserId,
      stockLocationId: ctx.stockLocationId,
      localPo,
    });
    await ctx.client.query(`UPDATE purchase_order_receipt SET vendor_bill_id = $1 WHERE id = $2`, [
      billId,
      result.purchase_order_receipt_id,
    ]);
    return result.purchase_order_receipt_id;
  } catch {
    // El bill se creó igual — un recibo sintético que no matchea líneas no debe
    // bloquear el bill (el documento de dinero ya está registrado); se pierde
    // sólo el historial de recepción visual del PO para este caso.
    return null;
  }
}

export interface BillApplyReport extends TypeApplyReport {
  receipts_linked: number;
  synthetic_receipts: number;
}

export async function applyBills(
  bills: QbBill[],
  known: ReadonlySet<string>,
  poIndex: Map<string, PoIndexEntry>,
  resolveQbAccount: QbAccountLookupFn,
  ctx: ApplyContext,
  apply: boolean
): Promise<BillApplyReport> {
  const report: BillApplyReport = { ...newReport(), receipts_linked: 0, synthetic_receipts: 0 };
  for (const bill of bills) {
    const decision = decideBillCreation(bill, known);
    if (decision.reason === "already") { report.already++; continue; }
    report.create++;
    if (!apply) continue;
    const localPo = resolveLocalPoByLinkedTxns(bill.linked_txns, poIndex);
    try {
      await ctx.client.query("BEGIN");
      const result = await createBillFromQb(ctx.client, bill, {
        runId: ctx.runId,
        itemIndex: ctx.itemIndex,
        ensureLog: ctx.ensureLog,
        resolveQbAccount,
        poLines: localPo?.lines ?? [],
        resolvedPoId: localPo?.id ?? null,
        vendorIndex: ctx.vendorIndex,
      });
      const linked = await linkReceiptsToBill(ctx.client, result.vendor_bill_id, bill.txn_id, bill.linked_txns);
      report.receipts_linked += linked;
      await ctx.client.query("COMMIT");
      if (linked === 0) {
        await ctx.client.query("BEGIN");
        const synthetic = await maybeCreateSyntheticReceipt(bill, result.vendor_bill_id, localPo, ctx);
        await ctx.client.query("COMMIT");
        if (synthetic) report.synthetic_receipts++;
      }
      report.created.push({ txn_id: bill.txn_id, created: result.vendor_bill_id });
    } catch (err) {
      await ctx.client.query("ROLLBACK");
      report.blocked.push({ txn_id: bill.txn_id, blocked_reason: (err as Error).message });
    }
  }
  return report;
}

