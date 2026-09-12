/**
 * src/lib/qb-backfill/create-sales-credit-memo.ts
 *
 * CreditMemo de QB → `pos_credit_memo` + ítems, `status: 'completed'`,
 * enlazado a la factura del POS si QB lo aplica a una Invoice conocida
 * (`LinkedTxn` tipo Invoice → `findPosInvoiceByQbTxnId`); si no, suelto
 * (`order_id`/`invoice_id` null), que es legal en el modelo.
 * `refund_method`: `refund` si hay un cheque/reembolso a tarjeta enlazado,
 * `store_credit` si no. Un CM voideado en QB (total 0, líneas en 0) se
 * BLOQUEA (`voided_zero_total`): el modelo exige importes > 0.
 *
 * Molde: `scripts/sync/backfill-qb-only-docs-2026-06-07.ts` (rama CreditMemo).
 * NO toca inventario ni `customer_credit_ledger` (sólo lo escriben las rutas).
 */
import { businessInstant } from "./create-po";
import { resolveProductLines } from "./create-sales-invoice";
import { planSalesLines } from "./sales-lines";
import { deriveRefundMethod, isVoidedCreditMemo } from "./sales-derive";
import { allocateCreditMemoNumber } from "./sales-numbering";
import {
  BACKFILL_ACTOR,
  backdateChildren,
  backdateRows,
  backfillMarker,
  findPosInvoiceByQbTxnId,
  firstId,
  seedPipelineRow,
  type PosInvoiceRef,
  type SalesApplyContext,
} from "./sales-context";
import type { QbCreditMemo } from "./sales-types";

export type CreditMemoCreateResult =
  | { ok: true; credit_memo_id: string; credit_memo_number: string; linked_invoice: string | null }
  | { ok: false; reason: string; detail?: Record<string, unknown> };

/** Primera Invoice enlazada que el POS conoce (un CM puede aplicarse a varias; el modelo del POS enlaza UNA). */
export async function resolveLinkedInvoice(ctx: SalesApplyContext, cm: QbCreditMemo): Promise<PosInvoiceRef | null> {
  for (const l of cm.linked_txns) {
    if (l.txn_type !== "Invoice") continue;
    const found = await findPosInvoiceByQbTxnId(ctx.client, l.txn_id);
    if (found) return found;
  }
  return null;
}

export async function createCreditMemoFromQb(ctx: SalesApplyContext, cm: QbCreditMemo): Promise<CreditMemoCreateResult> {
  if (isVoidedCreditMemo(cm)) return { ok: false, reason: "voided_zero_total" };
  if (!cm.customer_ref) return { ok: false, reason: "no_customer" };
  const plan = planSalesLines(cm.lines, ctx.itemIndex, cm.sales_tax_total_cents, cm.total_amount_cents);
  if (!plan.ok) return { ok: false, reason: plan.reason, detail: { ...plan } };
  if (plan.lines.some((l) => (l.kind === "product" || l.kind === "unknown_item") && l.amount_cents < 0)) {
    return { ok: false, reason: "negative_line", detail: { lines: plan.lines.filter((l) => l.amount_cents < 0).map((l) => l.line.item_ref?.full_name) } };
  }

  const customerId = await ctx.ensureCustomer(cm.customer_ref);
  const target = await resolveLinkedInvoice(ctx, cm);
  const lines = await resolveProductLines(ctx, plan.lines);
  const at = businessInstant(cm.txn_date);
  const marker = backfillMarker(ctx.runId, cm.txn_id, "CreditMemo", cm.via_link);
  const number = await allocateCreditMemoNumber(ctx.client, cm.txn_date, ctx.goLiveDate);
  const t = plan.totals;

  const cmId = firstId(
    await ctx.services.creditMemoService.createPosCreditMemos({
      credit_memo_number: number,
      order_id: target?.order_id ?? null,
      invoice_id: target?.invoice_id ?? null,
      customer_id: customerId,
      status: "completed",
      subtotal: t.subtotal_cents,
      discount: t.discount_cents,
      shipping: t.shipping_cents,
      tax: t.tax_cents,
      total: t.total_cents,
      completed_at: at,
      notes: `Recreado desde QuickBooks CreditMemo ${cm.ref_number ?? ""} (TxnID ${cm.txn_id}).${cm.memo ? ` ${cm.memo}` : ""}`,
      created_by: BACKFILL_ACTOR,
      qb_txn_id: cm.txn_id,
      qb_edit_sequence: cm.edit_sequence,
      refund_method: deriveRefundMethod(cm.linked_txns),
      metadata: {
        qb_ref_number: cm.ref_number,
        qb_sync_status: "synced",
        qb_synced_at: marker.imported_at,
        qb_credit_remaining_cents: cm.credit_remaining_cents,
        qb_linked_txns: cm.linked_txns,
        manually_imported: true,
        qb_backfill: marker,
      },
    })
  );
  if (lines.length > 0) {
    await ctx.services.creditMemoService.createPosCreditMemoItems(
      lines.map((l, idx) => ({
        credit_memo_id: cmId,
        sort_order: idx,
        variant_id: l.variant_id,
        sku: l.sku,
        title: l.title,
        description: l.description,
        quantity: l.quantity,
        unit_price: l.unit_price_cents,
        line_total: l.total_cents,
        damaged_qty: 0,
        // Aproximación: costo promedio VIGENTE, no el del día (ver `loadAvgCostDollars`).
        average_unit_cost: l.average_unit_cost,
        average_unit_cost_synced_at: l.average_unit_cost != null ? marker.imported_at : null,
      }))
    );
  }
  await backdateRows(ctx.client, "pos_credit_memo", [cmId], at);
  await backdateChildren(ctx.client, "pos_credit_memo_item", "credit_memo_id", cmId, at);

  await seedPipelineRow(ctx.client, ctx.runId, {
    orderId: target?.order_id ?? null, referenceId: cmId, referenceType: "credit_memo", step: "credit_memo", status: "confirmed",
    qbTxnId: cm.txn_id, qbRefNumber: cm.ref_number, medusaRefNumber: number,
    payload: { txn_type: "CreditMemo", edit_sequence: cm.edit_sequence, source: `QB CreditMemo ${cm.ref_number ?? cm.txn_id}` },
  });
  return { ok: true, credit_memo_id: cmId, credit_memo_number: number, linked_invoice: target?.invoice_number ?? null };
}
