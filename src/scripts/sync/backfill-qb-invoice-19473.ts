/**
 * Backfill phase 2 for QuickBooks Invoice #19473.
 *
 * Run AFTER the POS Order has been created (no invoice generated yet):
 *   yarn medusa exec ./src/scripts/sync/backfill-qb-invoice-19473.ts
 *
 * Context: Invoice 19473 was created directly in QuickBooks Desktop on 2026-04-30
 * for ELECTRICAL UNLIMITED USA (Carlos Salado). The order was reconstructed in
 * Medusa POS by hand so future Purchasing Analysis reflects the sale. This
 * script wires the POS Invoice snapshot + locks the QB pipeline as already
 * synced so the cron never re-pushes anything to QB.
 *
 * Idempotent: aborts if a pos_invoice already exists for this order.
 *
 * What this does:
 *   1. Creates a pos_invoice + items mirroring the QB Invoice totals exactly.
 *      Totals are HARDCODED from QB to bypass Medusa's per-line tax rounding
 *      (Medusa applies 7% per line, QB applies 7% on order subtotal — different
 *      rounding paths). pos_invoice is a snapshot; using QB numbers directly
 *      keeps the invoice print + Purchasing Analysis aligned with QB.
 *   2. NO payment is created — user will apply payments separately.
 *   3. qb_order_pipeline:
 *        - customer  → confirmed (QB customer already exists)
 *        - sales_order → 'skipped' (existing 'waiting' row is updated)
 *        - pos_invoice → 'confirmed' with TxnID 1C2581-1777589199 / EditSeq 1777733043
 *   4. Stamps order.metadata.qb_skip=true + QB refs so no cron retries.
 */

import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

import { INVOICE_MODULE } from "../../modules/invoices";

// ── Hard-coded backfill parameters ──────────────────────────────────────────
const ORDER_ID = "order_01KQMSZSWXFS3C9NDVNF1Q4GZN";
const QB_TXN_ID = "1C2581-1777589199";
const QB_REF_NUMBER = "19473";
const QB_EDIT_SEQUENCE = "1777733043";
const QB_DOC_DATE_ISO = "2026-04-30T17:00:00.000Z"; // 04/30/2026, midday EDT

// Totals in cents (exact match to QB Invoice 19473)
//   items pre-discount: $2,960.63
//   materials:          $30.00
//   subtotal discountable: $2,990.63
//   10% line discount:   -$299.06
//   subtotal after disc.: $2,691.57
//   services (no disc):  +$750.00
//   tax base:            $3,441.57
//   tax 7%:              +$240.91
//   install (no disc, no tax): +$1,300.00
//   total:               $4,982.48
const SUBTOTAL = 299063; // $2,990.63 — items + materials, pre-discount
const DISCOUNT = 29906;  // $299.06 — 10% on discountable subtotal
const SHIPPING = 0;
const TAX = 24091;       // $240.91 — 7% on (items+materials post-disc + services), excluding install
const TOTAL = 498248;    // $4,982.48
const AMOUNT_PAID = 0;   // No payment applied — user will apply separately

// Line items (cents) — match QB Invoice 19473 line-by-line
// Prices are in DOLLARS converted to cents at the end. quantity is integer.
type Line = {
  sku: string;
  description: string;
  quantity: number;
  unit_price: number; // cents — already line-discounted where applicable
  total: number;      // cents
};

const LINES: Line[] = [
  // SKU items — store ORIGINAL unit prices and PRE-discount line totals.
  // The pos_invoice carries `discount = 29906` ($299.06) at the document
  // level so the printed invoice matches QB's layout (line totals at
  // original prices + a single 10% discount line at the bottom).
  {
    sku: "EMSH4V160D30WRW3",
    description:
      "FPC LED Module, 24V DC 30W , 105LED SMD5050 with lens: 160 degree, Color: pure white RGBW (3000K) Size: 503.5 x 235 x 6.7 mm",
    quantity: 30,
    unit_price: 6999, // $69.99
    total: 209970,    // $2,099.70
  },
  {
    sku: "EPS-JNA-300-24",
    description:
      "J-Box Constant Voltage Power Supply, 300W, 100-277VAC, 12.5A. Output 24VDC. Potentiometer Included. Damp and Wet Rated. UL Listed. 5-year Warranty.",
    quantity: 3,
    unit_price: 17199, // $171.99
    total: 51597,      // $515.97
  },
  {
    sku: "ECNA-POC2P-6F-B",
    description:
      "6ft 18 AWG AC Power Cord NEMA 1-15P to IEC-60320-C7 18 AWG 2C 7A SPT-2 125V Black.",
    quantity: 3,
    unit_price: 699,  // $6.99
    total: 2097,      // $20.97
  },
  {
    sku: "ECTSK-AM3&4C8A",
    description:
      "SKY RGB/RGBW Amplifier, 3 or 4 channels, 8A/Channel, For RGB 12V/288W & 24V/576W, For RGBW 12V/384W & 24V/768W, compatible with SKY RF RGB/RGBW Remote Controllers. 2 year warranty.",
    quantity: 3,
    unit_price: 4975, // $49.75
    total: 14925,     // $149.25
  },
  {
    sku: "ECTSK-TWRC5C6A",
    description:
      "SKY TUYA WIFI RGB/RGBW/RGBCCT Receiver, 3/4/5 channels, 6A/Channel, For Dimming 12V/360W & 24V/720W, For CCT 12V/288W & 24V/576W,For RGB 12V/216W & 24V/432W, For RGBW 12V/288W & 24V/576W   compatible with SKY RF RGB/RGBW Remote Controllers, Tuya App, and Alexa/Google Home.. 2 year warranty.",
    quantity: 1,
    unit_price: 5225, // $52.25
    total: 5225,      // $52.25
  },
  {
    sku: "ECTSK-RM3&4C4ZB",
    description:
      "SKY RF RGB/RGBW Remote Controller, 4 zones, black model, compatible with SKY RF RGB/RGBW Receivers, Black Finish. 2 year warranty.",
    quantity: 1,
    unit_price: 3699, // $36.99
    total: 3699,      // $36.99
  },
  {
    sku: "ECB-22-6-STR-WH",
    description: "Wire AWG 22/6 Stranded White. Non returnable except complete roll.",
    quantity: 150,
    unit_price: 57,   // $0.57
    total: 8550,      // $85.50
  },
  // Materials (Special Item)
  {
    sku: "Special Item",
    description: "Materials",
    quantity: 1,
    unit_price: 3000, // $30.00
    total: 3000,
  },
  // Services — NOT discounted, taxable in QB
  {
    sku: "Services:Assembly-Panels",
    description:
      "ASSEMBLY SERVICE NOTES:\n- Covers the arrangement and electrical integration of LED module panels onto wooden bases, custom-fitted to exact measurements.\n- The lighting will be mounted and configured on the wooden base, designed for placement behind the translucent stone to streamline and expedite the on-site installation process.\n- Lead Time: A minimum of 1-2 business days is required after receiving the wooden bases. Lead times may vary depending on project complexity, volume, and current workload.",
    quantity: 1,
    unit_price: 75000,
    total: 75000,
  },
  // INSTALL — NOT discounted, NOT taxable in QB
  {
    sku: "INSTALL",
    description: "INSTALL\n- Lead Time: A minimum of 1-2 business days",
    quantity: 1,
    unit_price: 130000,
    total: 130000,
  },
];

export default async function backfillQbInvoice19473({ container }: ExecArgs) {
  const logger = container.resolve("logger");
  const orderModule = container.resolve(Modules.ORDER);
  const invoiceService = container.resolve(INVOICE_MODULE) as any;
  const pg = container.resolve("__pg_connection__") as any;

  // ── 1. Resolve order ───────────────────────────────────────────────────────
  const order = (await orderModule.retrieveOrder(ORDER_ID)) as any;
  if (!order) {
    logger.error(`❌ Order ${ORDER_ID} not found`);
    return;
  }
  const orderId: string = order.id;
  const customerId: string = order.customer_id;
  logger.info(
    `📦 Order ${orderId} (S${order.metadata?.document_number?.replace(/^S/, "") ?? order.display_id}) ` +
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

  // Validate totals add up
  const itemSum = LINES.reduce((s, l) => s + l.total, 0);
  const expectedItemSum = SUBTOTAL + 75000 + 130000; // items + materials + services + install
  if (itemSum !== expectedItemSum) {
    logger.error(
      `❌ Line items sum (${itemSum}) does not match expected (${expectedItemSum}). Aborting.`
    );
    return;
  }

  // ── 2. Sequence number for invoice (medusa internal seq) ───────────────────
  const medusaSeqRes = await pg.raw(
    `SELECT nextval('custom_medusa_invoice_seq') AS seq`
  );
  const invoiceNumber = String(
    medusaSeqRes.rows[0].seq || medusaSeqRes.rows[0].SEQ
  );
  logger.info(`🔢 invoice_number=${invoiceNumber}, qb_ref_number=${QB_REF_NUMBER}`);

  // ── 3. Create pos_invoice ──────────────────────────────────────────────────
  const issuedAt = new Date(QB_DOC_DATE_ISO);
  const balanceDue = TOTAL - AMOUNT_PAID;
  const invoice = await invoiceService.createPosInvoices({
    invoice_number: invoiceNumber,
    order_id: orderId,
    fulfillment_id: null,
    customer_id: customerId,
    status: "issued" as any, // unpaid — user applies payments separately
    subtotal: SUBTOTAL,
    discount: DISCOUNT,
    shipping: SHIPPING,
    tax: TAX,
    untaxed_total: TOTAL - TAX,
    total: TOTAL,
    amount_paid: AMOUNT_PAID,
    balance_due: balanceDue,
    payment_method: null, // null per nullable schema — populated on first payment
    card_brand: null,
    issued_at: issuedAt,
    paid_at: null,
    notes: "Backfilled from QuickBooks Invoice #19473 (manual entry, payments applied separately).",
    created_by: order.metadata?.pos_created_by ?? null,
    shipping_address: null,
    metadata: {
      is_sales_receipt: false,
      qb_ref_number: QB_REF_NUMBER,
      qb_txn_id: QB_TXN_ID,
      qb_edit_sequence: QB_EDIT_SEQUENCE,
      qb_sync_status: "synced",
      qb_synced_at: new Date().toISOString(),
      manually_imported: true,
      import_source: "QB Desktop Invoice 19473 (2026-04-30)",
    },
  });
  const invoiceId = (invoice as any).id;
  logger.info(`✅ pos_invoice ${invoiceId} created (INV-${invoiceNumber})`);

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

  // ── 5. qb_order_pipeline: customer (confirmed) ─────────────────────────────
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
      JSON.stringify({
        backfilled: true,
        source: "Invoice 19473 manual entry",
      }),
    ]
  );

  // ── 6. qb_order_pipeline: sales_order (UPDATE existing 'waiting' → skipped) ─
  // The POS create flow always enqueues a 'waiting' sales_order row. Convert it
  // to 'skipped' so the consolidator never picks it up.
  const updRes = await pg.raw(
    `UPDATE qb_order_pipeline
        SET status = 'skipped',
            error = ?,
            confirmed_at = NOW(),
            updated_at = NOW()
      WHERE order_id = ? AND step = 'sales_order'
      RETURNING id`,
    [
      "Superseded by Invoice 19473 (manual backfill from QB Desktop)",
      orderId,
    ]
  );
  if (updRes.rowCount === 0) {
    // No existing row — insert one
    await pg.raw(
      `INSERT INTO qb_order_pipeline
         (order_id, step, status, medusa_ref_number, error, confirmed_at)
       VALUES (?, 'sales_order', 'skipped', ?, ?, NOW())`,
      [
        orderId,
        `S${order.metadata?.document_number?.replace(/^S/, "") ?? order.display_id}`,
        "Superseded by Invoice 19473 (manual backfill from QB Desktop)",
      ]
    );
  }

  // ── 7. qb_order_pipeline: invoice (confirmed with QB metadata) ─────────────
  await pg.raw(
    `INSERT INTO qb_order_pipeline
       (order_id, reference_id, reference_type, step, status,
        qb_txn_id, qb_ref_number, medusa_ref_number, payload,
        submitted_at, confirmed_at)
     VALUES (?, ?, 'pos_invoice', 'invoice', 'confirmed',
             ?, ?, ?, ?::jsonb, NOW(), NOW())`,
    [
      orderId,
      invoiceId,
      QB_TXN_ID,
      QB_REF_NUMBER,
      `IN-${invoiceNumber}`,
      JSON.stringify({
        backfilled: true,
        edit_sequence: QB_EDIT_SEQUENCE,
        source: "Manual backfill — Invoice was created in QB Desktop on 2026-04-30",
      }),
    ]
  );
  logger.info(`✅ qb_order_pipeline rows written (customer/sales_order/invoice)`);

  // ── 8. Stamp order metadata so cron + UI see it as synced ──────────────────
  await orderModule.updateOrders(orderId, {
    metadata: {
      ...(order.metadata ?? {}),
      qb_skip: true,
      qb_sync_status: "synced",
      qb_invoice_txn_id: QB_TXN_ID,
      qb_invoice_ref_number: QB_REF_NUMBER,
      qb_invoice_edit_sequence: QB_EDIT_SEQUENCE,
      qb_ref_number: QB_REF_NUMBER,
      qb_synced_at: new Date().toISOString(),
      manually_imported: true,
      manually_imported_source: "QB Invoice 19473 (2026-04-30)",
    },
  });
  logger.info(`✅ order.metadata stamped (qb_skip=true, qb_sync_status=synced)`);

  logger.info(`\n${"=".repeat(60)}`);
  logger.info(`✅ DONE — order ${orderId} backfilled as QB-synced`);
  logger.info(`   pos_invoice:  ${invoiceId}  (INV-${invoiceNumber})`);
  logger.info(`   QB ref:       Invoice #${QB_REF_NUMBER}`);
  logger.info(`   QB TxnID:     ${QB_TXN_ID}`);
  logger.info(`   total:        $${(TOTAL / 100).toFixed(2)}  (balance_due: $${(balanceDue / 100).toFixed(2)})`);
  logger.info(`   payments:     none — user applies separately`);
  logger.info(`${"=".repeat(60)}`);
}
