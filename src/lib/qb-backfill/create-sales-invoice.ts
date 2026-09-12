/**
 * src/lib/qb-backfill/create-sales-invoice.ts
 *
 * Plan 2 (`qb-sales-backfill-20260911`): crea en el POS la orden + la
 * `pos_invoice` de un `QbInvoice` que el POS no conoce, siguiendo el molde
 * `scripts/sync/backfill-qb-only-docs-2026-06-07.ts`:
 *
 *   - Orden MODULE-DIRECT (`createOrders`): sin ruta, sin evento, sin
 *     subscribers → sin reservas ni stock. `order_status: "Fulfilled"` va
 *     sólo en metadata; el fulfillment real lo pone después
 *     `scripts/fix/fulfill-backfilled-qb-orders.ts` (no es tarea de acá).
 *     Lleva tax lines / adjustments / shipping method como el POS nativo
 *     (`sales-order-money.ts`); el summary se parchea en `backdateOrder`.
 *   - `pos_invoice` + ítems por el module service, `created_at` backdateado.
 *     La ORDEN se backdatea al final (`backdateOrder`), nunca antes de un
 *     service que dispare `recompute_order_money` (lock sobre `"order"`).
 *   - Pipeline SEMBRADO en `confirmed` con el TxnID real: `QB_CREATE_STEPS`
 *     vuelve no-op cualquier encolado posterior y el GL importer reconoce el
 *     documento como del POS.
 *
 * Los module services escriben FUERA de la transacción `ctx.client` (cada
 * uno lleva su conexión); la idempotencia entre corridas es por TxnID y, si
 * algo falla a mitad, el orquestador limpia por marcador (`run_id` + `txn_id`).
 * `createSalesOrderAndInvoice` es compartido con el sales receipt.
 */
import { ensureItem } from "./ensure";
import { businessInstant } from "./create-po";
import { allocateInvoiceNumber, allocateOrderDocumentNumber } from "./sales-numbering";
import { planSalesLines, productLines, type ClassifiedSalesLine, type SalesTotals } from "./sales-lines";
import { deriveInvoiceStatus, invoiceTotalCents, type PosInvoicePaymentMethod } from "./sales-derive";
import {
  BACKFILL_ACTOR,
  backdateChildren,
  backdateRows,
  backfillMarker,
  loadAvgCostDollars,
  seedPipelineRow,
  type QbBackfillMarker,
  type SalesApplyContext,
} from "./sales-context";
import { isQbLineTaxable, patchOrderSummaryFromPosInvoice, planSalesOrderMoney, toMedusaItemMoney } from "./sales-order-money";
import type { QbInvoice, QbSalesReceipt } from "./sales-types";
import type { QbRef } from "./types";

export interface ResolvedSalesLine {
  variant_id: string;
  sku: string;
  title: string;
  product_title: string;
  description: string;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
  taxable: boolean; // `SalesTaxCodeRef` de la línea QB (`Non` = exenta): la verdad del documento, no del producto
  average_unit_cost: number | null;
}

/** Resuelve (o crea, descontinuado) la variante de cada línea de producto y le pega el costo promedio actual. */
export async function resolveProductLines(ctx: SalesApplyContext, lines: readonly ClassifiedSalesLine[]): Promise<ResolvedSalesLine[]> {
  const out: ResolvedSalesLine[] = [];
  for (const c of productLines(lines)) {
    const ref = c.line.item_ref as QbRef;
    let variantId = c.item?.variant_id ?? null;
    let sku = c.item?.sku ?? "";
    if (!variantId) {
      const created = await ensureItem(ctx.client, ref, ctx.runId, ctx.ensureLog);
      variantId = created.variantId;
      sku = ref.full_name.includes(":") ? ref.full_name.split(":").pop()! : ref.full_name;
    }
    out.push({
      variant_id: variantId, sku: sku || ref.full_name, title: sku || ref.full_name, product_title: ref.full_name,
      description: c.line.description ?? ref.full_name, quantity: c.quantity, unit_price_cents: c.unit_price_cents,
      total_cents: c.amount_cents, taxable: isQbLineTaxable(c.line.sales_tax_code_ref?.full_name), average_unit_cost: null,
    });
  }
  const costs = await loadAvgCostDollars(ctx.client, out.map((l) => l.variant_id));
  return out.map((l) => ({ ...l, average_unit_cost: costs.get(l.variant_id) ?? null }));
}

export interface SalesDocHeader {
  txn_id: string;
  txn_type: "Invoice" | "SalesReceipt";
  ref_number: string | null;
  edit_sequence: string;
  txn_date: string;
  customer_ref: QbRef;
  memo: string | null;
  via_link?: boolean;
}

export interface OrderAndInvoiceInput {
  header: SalesDocHeader;
  lines: ResolvedSalesLine[];
  totals: SalesTotals;
  status: "paid" | "partial" | "issued";
  amount_paid_cents: number;
  balance_due_cents: number;
  payment_method: PosInvoicePaymentMethod | null;
  card_brand: string | null;
  is_sales_receipt: boolean;
  /** Metadata extra de la orden (SR: `qb_sales_receipt_*`). */
  orderMetadata: Record<string, unknown>;
  invoiceMetadata: Record<string, unknown>;
}

export interface OrderAndInvoiceResult {
  order_id: string;
  document_number: string;
  invoice_id: string;
  invoice_number: string;
  customer_id: string;
  marker: QbBackfillMarker;
}

/** Orden + factura + ítems, backdateados. No siembra pipeline (cada tipo siembra lo suyo). */
export async function createSalesOrderAndInvoice(ctx: SalesApplyContext, input: OrderAndInvoiceInput): Promise<OrderAndInvoiceResult> {
  const { header, totals } = input;
  const customerId = await ctx.ensureCustomer(header.customer_ref);
  const email = ctx.customerIndex.get(header.customer_ref.list_id)?.email ?? null;
  const at = businessInstant(header.txn_date);
  const marker = backfillMarker(ctx.runId, header.txn_id, header.txn_type, header.via_link);
  const nowIso = marker.imported_at;
  const documentNumber = await allocateOrderDocumentNumber(ctx.client, header.txn_date, ctx.goLiveDate);
  const money = planSalesOrderMoney(input.lines.map((l, i) => ({ key: String(i), net_cents: l.total_cents, taxable: l.taxable })), totals);
  if (!money.ok) throw new Error(`${header.txn_id}: dinero no representable en Medusa (${money.reason}: ${money.detail})`); // fail-closed: ROLLBACK + cleanup

  const order = await ctx.services.orderModule.createOrders({
    region_id: ctx.regionId,
    sales_channel_id: ctx.salesChannelId,
    customer_id: customerId,
    email,
    currency_code: "usd",
    status: "completed",
    is_draft_order: false,
    items: input.lines.map((l, i) => ({
      variant_id: l.variant_id,
      variant_sku: l.sku,
      title: l.title,
      product_title: l.product_title,
      quantity: l.quantity,
      unit_price: l.unit_price_cents / 100,
      ...toMedusaItemMoney(money.lines[i]!),
    })),
    ...(money.shipping ? { shipping_methods: [{ name: money.shipping.name, amount: money.shipping.amount_cents / 100 }] } : {}),
    metadata: {
      document_number: documentNumber,
      pos_created: true,
      pos_created_by: BACKFILL_ACTOR,
      order_placed_at: at,
      confirmed_at: at,
      order_status: "Fulfilled",
      fully_invoiced: true,
      pos_total: totals.total_cents / 100,
      computed_total: totals.total_cents / 100,
      computed_subtotal: totals.subtotal_cents / 100,
      computed_tax_amount: totals.tax_cents / 100,
      ...(totals.discount_cents ? { computed_discount: totals.discount_cents / 100 } : {}),
      ...(totals.shipping_cents ? { computed_shipping: totals.shipping_cents / 100 } : {}),
      qb_skip: true,
      qb_sync_status: "synced",
      qb_synced_at: nowIso,
      qb_ref_number: header.ref_number,
      qb_list_id: header.customer_ref.list_id,
      manually_imported: true,
      manually_imported_source: "qb_backfill",
      qb_backfill: marker,
      ...(header.memo ? { pos_notes: header.memo } : {}),
      ...input.orderMetadata,
    },
  });
  const invoiceNumber = await allocateInvoiceNumber(ctx.client, header.txn_date, ctx.goLiveDate);
  const invoice = await ctx.services.invoiceService.createPosInvoices({
    invoice_number: invoiceNumber,
    order_id: order.id,
    fulfillment_id: null,
    customer_id: customerId,
    status: input.status,
    subtotal: totals.subtotal_cents,
    discount: totals.discount_cents,
    shipping: totals.shipping_cents,
    tax: totals.tax_cents,
    untaxed_total: totals.total_cents - totals.tax_cents,
    total: totals.total_cents,
    amount_paid: input.amount_paid_cents,
    balance_due: input.balance_due_cents,
    payment_method: input.payment_method,
    card_brand: input.card_brand,
    issued_at: at,
    paid_at: input.status === "paid" ? at : null,
    notes: `Recreado desde QuickBooks ${header.txn_type} ${header.ref_number ?? ""} (TxnID ${header.txn_id}).`,
    created_by: BACKFILL_ACTOR,
    shipping_address: null,
    metadata: {
      is_sales_receipt: input.is_sales_receipt,
      qb_txn_id: header.txn_id,
      qb_ref_number: header.ref_number,
      qb_edit_sequence: header.edit_sequence,
      qb_sync_status: "synced",
      qb_synced_at: nowIso,
      manually_imported: true,
      qb_backfill: marker,
      ...input.invoiceMetadata,
    },
  });
  if (input.lines.length > 0) {
    await ctx.services.invoiceService.createPosInvoiceItems(
      input.lines.map((l, idx) => ({
        invoice_id: invoice.id,
        sort_order: idx,
        variant_id: l.variant_id,
        sku: l.sku,
        description: l.description,
        quantity: l.quantity,
        unit_price: l.unit_price_cents,
        total: l.total_cents,
        net_total_cents: l.total_cents,
        taxable: l.taxable,
        // Aproximación: costo promedio VIGENTE, no el del día (ver `loadAvgCostDollars`).
        average_unit_cost: l.average_unit_cost,
        average_unit_cost_synced_at: l.average_unit_cost != null ? nowIso : null,
      }))
    );
  }
  await backdateRows(ctx.client, "pos_invoice", [invoice.id], at);
  await backdateChildren(ctx.client, "pos_invoice_item", "invoice_id", invoice.id, at);

  return { order_id: order.id, document_number: documentNumber, invoice_id: invoice.id, invoice_number: invoiceNumber, customer_id: customerId, marker };
}

/**
 * Backdatea la orden — SIEMPRE como ÚLTIMO paso del documento, después de
 * todo module service. Medido 2026-09-11: `customer_payment` y
 * `payment_application` disparan `recompute_order_money`, que hace
 * `UPDATE "order"`; con la fila de la orden ya bloqueada por esta transacción
 * el service espera el lock y la transacción espera al service → deadlock.
 */
export async function backdateOrder(ctx: SalesApplyContext, orderId: string, txnDate: string): Promise<void> {
  await patchOrderSummaryFromPosInvoice(ctx.client, orderId); // dispara recompute_order_money (UPDATE "order") → va acá, último
  const at = businessInstant(txnDate);
  await ctx.client.query(`UPDATE "order" SET created_at = $1::timestamptz, updated_at = $1::timestamptz WHERE id = $2`, [at, orderId]);
  await ctx.client.query(
    `UPDATE order_line_item SET created_at = $1::timestamptz, updated_at = $1::timestamptz
      WHERE id IN (SELECT item_id FROM order_item WHERE order_id = $2)`,
    [at, orderId]
  );
  await backdateChildren(ctx.client, "order_item", "order_id", orderId, at);
}

export type SalesCreateResult =
  | { ok: true; ids: OrderAndInvoiceResult }
  | { ok: false; reason: string; detail?: Record<string, unknown> };

export function requireCustomer(doc: { txn_id: string; customer_ref: QbRef | null }): QbRef {
  if (!doc.customer_ref) throw new Error(`${doc.txn_id}: sin CustomerRef — no se puede crear sin cliente`);
  return doc.customer_ref;
}

export async function createInvoiceFromQb(ctx: SalesApplyContext, inv: QbInvoice): Promise<SalesCreateResult> {
  const expected = invoiceTotalCents(inv);
  const plan = planSalesLines(inv.lines, ctx.itemIndex, inv.sales_tax_total_cents, expected);
  if (!plan.ok) return { ok: false, reason: plan.reason, detail: { ...plan } };
  const customerRef = requireCustomer(inv);
  const derived = deriveInvoiceStatus(inv, plan.totals.total_cents);
  const lines = await resolveProductLines(ctx, plan.lines);

  const ids = await createSalesOrderAndInvoice(ctx, {
    header: { ...inv, txn_type: "Invoice", customer_ref: customerRef },
    lines,
    totals: plan.totals,
    status: derived.status,
    amount_paid_cents: derived.amount_paid_cents,
    balance_due_cents: derived.balance_due_cents,
    payment_method: null,
    card_brand: null,
    is_sales_receipt: false,
    orderMetadata: {
      qb_invoice_txn_id: inv.txn_id,
      qb_invoice_ref_number: inv.ref_number,
      qb_invoice_edit_sequence: inv.edit_sequence,
      ...(inv.po_number ? { po_number: inv.po_number } : {}),
    },
    invoiceMetadata: {},
  });

  await seedPipelineRow(ctx.client, ctx.runId, {
    orderId: ids.order_id, referenceId: ids.customer_id, referenceType: "customer", step: "customer", status: "skipped",
    qbTxnId: customerRef.list_id, qbRefNumber: null, medusaRefNumber: null,
    payload: { txn_type: "Invoice" }, error: "backfill: el cliente ya existe en QuickBooks",
  });
  await seedPipelineRow(ctx.client, ctx.runId, {
    orderId: ids.order_id, referenceId: ids.invoice_id, referenceType: "pos_invoice", step: "invoice", status: "confirmed",
    qbTxnId: inv.txn_id, qbRefNumber: inv.ref_number, medusaRefNumber: `INV-${ids.invoice_number}`,
    payload: { txn_type: "Invoice", edit_sequence: inv.edit_sequence, source: `QB Invoice ${inv.ref_number ?? inv.txn_id}` },
  });
  await backdateOrder(ctx, ids.order_id, inv.txn_date);
  return { ok: true, ids };
}

/** Sólo para tipar el header compartido desde el sales receipt. */
export type SalesReceiptHeaderSource = Pick<QbSalesReceipt, "txn_id" | "ref_number" | "edit_sequence" | "txn_date" | "memo" | "via_link">;
