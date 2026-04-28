/**
 * Backfill phase 2 for QuickBooks Sales Receipt #27925.
 *
 * Run AFTER the Order has been created in the POS (no invoice generated):
 *   yarn medusa exec ./src/scripts/sync/backfill-qb-sales-receipt-27925.ts
 *
 * What this does (idempotent on the order):
 *   1. Creates a pos_invoice + items mirroring the QB Sales Receipt totals.
 *   2. Creates a customer_payment + payment_application (Debit Card, status=applied).
 *   3. Writes qb_order_pipeline rows already in 'confirmed'/'skipped' state with the
 *      real QB TxnID + RefNumber so the UI shows the order as fully synced.
 *   4. Stamps order.metadata.qb_skip=true + QB refs so no cron will retry.
 *
 * The order is never re-pushed to QB — the entire sync row is reconstructed locally.
 */

import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

import { INVOICE_MODULE } from "../../modules/invoices";
import { FINANCE_MODULE } from "../../modules/finance";

// ── Hard-coded backfill parameters ──────────────────────────────────────────
const ORDER_DISPLAY_ID = 1567;
const QB_TXN_ID = "1C1A27-1777061321";
const QB_REF_NUMBER = "27925";
const QB_EDIT_SEQUENCE = "1777061321";
const QB_DOC_DATE_ISO = "2026-04-24T17:00:00.000Z"; // 04/24/2026, midday EDT
const PAYMENT_METHOD = "debit_card" as const;
const CARD_BRAND: string | null = null;

// Totals in cents (matches Sales Receipt 27925)
const SUBTOTAL = 21750;
const TAX = 1523;
const SHIPPING = 0;
const DISCOUNT = 0;
const TOTAL = 23273;
const AMOUNT_PAID = TOTAL;

// Line items (cents)
const LINES = [
  {
    sku: "ECLDLE-34R8WS3CT",
    description:
      '3/4" LED DOWNLIGHT MODULE 8W, DIM. 3000K/4000K/6000K, Brush Nickel Frame, AC110V. 730 Lm. It requires a Trim (ECLDL-3/4R-S3 or ECLDL-3/4R-S4). 3 year warranty.',
    quantity: 10,
    unit_price: 1999,
    total: 19990,
  },
  {
    sku: "ECLDLE-34-3RDBN",
    description: '3" Round Brush Nickel Trim for ECLDLE-34R8WS3CT',
    quantity: 10,
    unit_price: 176,
    total: 1760,
  },
];

export default async function backfillQbSalesReceipt27925({
  container,
}: ExecArgs) {
  const logger = container.resolve("logger");
  const orderModule = container.resolve(Modules.ORDER);
  const invoiceService = container.resolve(INVOICE_MODULE) as any;
  const financeService = container.resolve(FINANCE_MODULE) as any;
  const pg = container.resolve("__pg_connection__") as any;

  // ── 1. Resolve order ───────────────────────────────────────────────────────
  const orders = await orderModule.listOrders(
    { display_id: ORDER_DISPLAY_ID } as any,
    { take: 1 }
  );
  if (!orders.length) {
    logger.error(`❌ Order display_id=${ORDER_DISPLAY_ID} not found`);
    return;
  }
  const order = orders[0] as any;
  const orderId: string = order.id;
  const customerId: string = order.customer_id;
  logger.info(
    `📦 Order ${orderId} (S${order.metadata?.document_number ?? order.display_id}) ` +
      `customer=${customerId}`
  );

  // Guard: ensure no invoice exists for this order yet
  const existingInvoices = await invoiceService.listPosInvoices(
    { order_id: orderId },
    { take: 1 }
  );
  if (existingInvoices.length) {
    logger.error(
      `❌ pos_invoice already exists (${existingInvoices[0].id}) for this order. Aborting.`
    );
    return;
  }

  // ── 2. Sequence numbers ────────────────────────────────────────────────────
  // Burn the medusa internal sequence (so future invoices stay monotonic).
  // Skip burning custom_sales_receipt_seq — the QB ref 27925 was assigned externally.
  const medusaSeqRes = await pg.raw(
    `SELECT nextval('custom_medusa_invoice_seq') AS seq`
  );
  const invoiceNumber = String(
    medusaSeqRes.rows[0].seq || medusaSeqRes.rows[0].SEQ
  );
  logger.info(`🔢 invoice_number=${invoiceNumber}, qb_ref_number=${QB_REF_NUMBER}`);

  // ── 3. Create pos_invoice ──────────────────────────────────────────────────
  const issuedAt = new Date(QB_DOC_DATE_ISO);
  const invoice = await invoiceService.createPosInvoices({
    invoice_number: invoiceNumber,
    order_id: orderId,
    fulfillment_id: null,
    customer_id: customerId,
    status: "paid" as any,
    subtotal: SUBTOTAL,
    discount: DISCOUNT,
    shipping: SHIPPING,
    tax: TAX,
    untaxed_total: TOTAL - TAX,
    total: TOTAL,
    amount_paid: AMOUNT_PAID,
    balance_due: 0,
    payment_method: PAYMENT_METHOD,
    card_brand: CARD_BRAND,
    issued_at: issuedAt,
    paid_at: issuedAt,
    notes: "Backfilled from QuickBooks Sales Receipt #27925 (manual entry).",
    created_by: order.metadata?.pos_created_by ?? null,
    shipping_address: null,
    metadata: {
      is_sales_receipt: true,
      qb_ref_number: QB_REF_NUMBER,
      qb_txn_id: QB_TXN_ID,
      qb_edit_sequence: QB_EDIT_SEQUENCE,
      qb_sync_status: "synced",
      qb_synced_at: new Date().toISOString(),
      manually_imported: true,
      import_source: "QB Desktop Sales Receipt 27925 (2026-04-24)",
    },
  });
  const invoiceId = (invoice as any).id;
  logger.info(`✅ pos_invoice ${invoiceId} created`);

  // ── 4. Create line items ───────────────────────────────────────────────────
  // Match SKUs to variants on the order so we can populate variant_id correctly.
  const orderItems = (
    await pg.raw(
      `SELECT oli.id, oli.variant_sku, oli.variant_id
         FROM order_line_item oli
         JOIN order_item oi ON oi.item_id = oli.id
        WHERE oi.order_id = ?`,
      [orderId]
    )
  ).rows as Array<{ id: string; variant_sku: string; variant_id: string }>;
  const skuToVariant = new Map(
    orderItems.map((r) => [r.variant_sku, r.variant_id])
  );

  await invoiceService.createPosInvoiceItems(
    LINES.map((l) => ({
      invoice_id: invoiceId,
      variant_id: skuToVariant.get(l.sku) ?? null,
      sku: l.sku,
      description: l.description,
      quantity: l.quantity,
      unit_price: l.unit_price,
      total: l.total,
    }))
  );
  logger.info(`✅ ${LINES.length} pos_invoice_item rows created`);

  // ── 5. Internal invoice_payment record (mirrors what /admin/invoices does) ─
  await invoiceService.createInvoicePayments({
    invoice_id: invoiceId,
    amount: AMOUNT_PAID,
    payment_method: PAYMENT_METHOD,
    notes: "Backfilled — payment embedded in QB Sales Receipt 27925",
    created_by: order.metadata?.pos_created_by ?? null,
    paid_at: issuedAt,
  });

  // ── 6. customer_payment via finance module ─────────────────────────────────
  const seqPgRes = await pg.raw(
    `SELECT nextval('custom_payment_seq') AS seq`
  );
  const nextPayNum = Number(seqPgRes.rows[0].seq || seqPgRes.rows[0].SEQ);

  const payment = await financeService.createCustomerPayments({
    customer_id: customerId,
    display_id: nextPayNum,
    amount: TOTAL,
    method: PAYMENT_METHOD,
    card_brand: CARD_BRAND,
    reference: "Deposit",
    notes: "Backfill of QB Sales Receipt 27925 — payment embedded in SR.",
    received_at: issuedAt,
    created_by: order.metadata?.pos_created_by ?? null,
    source: "pos",
    type: "payment",
    status: "applied",
    medusa_payment_synced: false,
    metadata: {
      deposit_type: "INVOICE",
      order_id: orderId,
      order_display_id: order.display_id,
      pos_payment_method: PAYMENT_METHOD,
      card_brand: CARD_BRAND,
      invoices_affected: [invoiceId],
      invoices_affected_friendly: [`SR-${QB_REF_NUMBER}`],
      order_document_number: order.metadata?.document_number ?? null,
      // SR-embedded marker so it never gets a separate ReceivePayment in QB.
      qb_source: "sales_receipt",
      qb_sync_status: "synced",
      qb_txn_id: "SYNCED_VIA_RECEIPT",
      qb_parent_txn_id: QB_TXN_ID,
      qb_parent_ref_number: QB_REF_NUMBER,
      is_sales_receipt_payment: true,
      manually_imported: true,
    },
  });
  const paymentId = Array.isArray(payment) ? payment[0].id : payment.id;
  logger.info(`✅ customer_payment ${paymentId} (PAY-${nextPayNum}) created`);

  // ── 7. payment_application linking payment ↔ invoice ───────────────────────
  await financeService.createPaymentApplications({
    payment_id: paymentId,
    invoice_id: invoiceId,
    invoice_number: invoiceNumber,
    order_id: orderId,
    amount_applied: TOTAL,
    applied_at: issuedAt,
    applied_by: order.metadata?.pos_created_by ?? null,
  });
  logger.info(`✅ payment_application linked`);

  // ── 8. qb_order_pipeline rows (confirmed + skipped SO) ─────────────────────
  // Customer row — confirmed (QB customer already exists)
  await pg.raw(
    `INSERT INTO qb_order_pipeline
       (order_id, reference_id, reference_type, step, status,
        qb_txn_id, qb_ref_number, medusa_ref_number, payload,
        confirmed_at, submitted_at)
     VALUES (?, ?, 'customer', 'customer', 'confirmed',
             ?, ?, NULL, ?::jsonb, NOW(), NOW())`,
    [
      orderId,
      customerId,
      order.metadata?.qb_list_id ?? null,
      null,
      JSON.stringify({ backfilled: true, source: "SR 27925 manual entry" }),
    ]
  );

  // Sales Order row — skipped (a Sales Receipt supersedes the SO)
  await pg.raw(
    `INSERT INTO qb_order_pipeline
       (order_id, step, status, medusa_ref_number, error,
        confirmed_at)
     VALUES (?, 'sales_order', 'skipped', ?, ?, NOW())`,
    [
      orderId,
      `S${order.metadata?.document_number?.replace(/^S/, "") ?? order.display_id}`,
      "Superseded by Sales Receipt 27925 (manual backfill from QB)",
    ]
  );

  // Sales Receipt row — confirmed with the real QB TxnID + RefNumber
  await pg.raw(
    `INSERT INTO qb_order_pipeline
       (order_id, reference_id, reference_type, step, status,
        qb_txn_id, qb_ref_number, medusa_ref_number, payload,
        submitted_at, confirmed_at)
     VALUES (?, ?, 'pos_invoice', 'sales_receipt', 'confirmed',
             ?, ?, ?, ?::jsonb, NOW(), NOW())`,
    [
      orderId,
      invoiceId,
      QB_TXN_ID,
      QB_REF_NUMBER,
      `SR-${invoiceNumber}`,
      JSON.stringify({
        backfilled: true,
        edit_sequence: QB_EDIT_SEQUENCE,
        source: "Manual backfill — Sales Receipt was created in QB Desktop on 2026-04-24",
      }),
    ]
  );
  logger.info(`✅ qb_order_pipeline rows written (customer/sales_order/sales_receipt)`);

  // ── 9. Stamp order metadata so cron + UI see it as synced ──────────────────
  await orderModule.updateOrders(orderId, {
    metadata: {
      ...(order.metadata ?? {}),
      qb_skip: true,
      qb_sync_status: "synced",
      qb_sales_receipt_txn_id: QB_TXN_ID,
      qb_sales_receipt_ref_number: QB_REF_NUMBER,
      qb_sales_receipt_edit_sequence: QB_EDIT_SEQUENCE,
      qb_ref_number: QB_REF_NUMBER,
      qb_synced_at: new Date().toISOString(),
      manually_imported: true,
      manually_imported_source: "QB Sales Receipt 27925 (2026-04-24)",
      referential_deposit: TOTAL / 100,
    },
  });
  logger.info(`✅ order.metadata stamped (qb_skip=true, qb_sync_status=synced)`);

  logger.info(`\n${"=".repeat(60)}`);
  logger.info(`✅ DONE — order ${orderId} backfilled as QB-synced`);
  logger.info(`   pos_invoice:  ${invoiceId}  (INV-${invoiceNumber})`);
  logger.info(`   QB ref:       SalesReceipt #${QB_REF_NUMBER}`);
  logger.info(`   QB TxnID:     ${QB_TXN_ID}`);
  logger.info(`   payment:      ${paymentId}  (PAY-${nextPayNum})`);
  logger.info(`${"=".repeat(60)}`);
}
