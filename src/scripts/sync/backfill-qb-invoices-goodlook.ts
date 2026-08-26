/**
 * Backfill: 5 historical QB Desktop invoices for Good Look Optical Inc.
 * (07202, 07204, 08675, 18965, 18968) recreated in Medusa POS so payments
 * can be received through the POS and applied against the EXISTING QB docs.
 *
 * Run (dry-run default):
 *   env DATABASE_URL=... DISABLE_SCHEDULED_JOBS=true npx medusa exec ./src/scripts/sync/backfill-qb-invoices-goodlook.ts
 * Apply:
 *   env APPLY=true DATABASE_URL=... DISABLE_SCHEDULED_JOBS=true npx medusa exec ./src/scripts/sync/backfill-qb-invoices-goodlook.ts
 *
 * Model: src/scripts/sync/backfill-qb-invoice-19473.ts, extended to also create
 * the order (module-direct — no draft/convert path, so NO reservations and no
 * events are ever created; nothing is enqueued to the QB pipeline).
 *
 * Anti-duplicate contract:
 *   - pos_invoice created via module service (no route → no pos.invoice.created
 *     event → subscribers never fire).
 *   - qb_order_pipeline seeded with step='invoice' status='confirmed' carrying
 *     the real QB TxnID: the QB_CREATE_STEPS guard in row-mutations.ts makes
 *     any later enqueue a no-op, and handle-pos-payment-applied resolves the
 *     apply_payment target TxnID from pos_invoice.metadata.qb_txn_id.
 *
 * Known divergence (accepted): invoice 08675 carries a $62.95 document-level
 * discount. Order lines store ORIGINAL prices, so order_summary reads $419.65
 * while metadata.pos_total/computed_total carry the true $356.70 — POS readers
 * and the Meili orders index give pos_total precedence.
 *
 * Idempotent & resumable: each step guards by qb_txn_id before writing.
 * Audit trail: appends created ids to backfill-qb-invoices-goodlook.audit.jsonl
 * next to this file (input for the rollback script).
 */

import { appendFileSync } from "fs";
import { join } from "path";

import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

import { INVOICE_MODULE } from "../../modules/invoices";

const APPLY = process.env.APPLY === "true";
const AUDIT_FILE = join(__dirname, "backfill-qb-invoices-goodlook.audit.jsonl");

const CUSTOMER_ID = "cus_01KG0QPVZDSCZ04DDA2ZKQM3BD"; // Good Look Optical Inc.
const QB_CUSTOMER_LIST_ID = "800000C7-1360776729";
// Same region/sales-channel as order 2029 (the existing invoice 21075 order).
const REGION_ID = "reg_01KFS28SNF1MT1MRHRAFQ6ZGK1";
const SALES_CHANNEL_ID = "sc_15154EAF0D194265ADD21AAD2D";

type QbLine = {
  sku: string;
  description: string;
  quantity: number;
  unit_price_cents: number; // original QB rate
  total_cents: number; // pre-discount line total
};

type QbInvoice = {
  qb_ref_number: string;
  qb_txn_id: string;
  txn_date_iso: string; // midday ET
  subtotal_cents: number; // pre-discount item sum
  discount_cents: number; // document-level discount (positive)
  total_cents: number; // final QB total (tax exempt → tax 0)
  memo?: string;
  lines: QbLine[];
};

// Captured from QB Desktop via bridge InvoiceQuery on 2026-08-26.
const INVOICES: QbInvoice[] = [
  {
    qb_ref_number: "07202",
    qb_txn_id: "185234-1736523736",
    txn_date_iso: "2025-01-10T17:00:00.000Z",
    subtotal_cents: 750,
    discount_cents: 0,
    total_cents: 750,
    lines: [
      {
        sku: "SUN-80693",
        description:
          "Sunlite A19/LED/10W/ES/D/50K LED A19 Household 10W (60W Equivalent) Light Bulb",
        quantity: 3,
        unit_price_cents: 250,
        total_cents: 750,
      },
    ],
  },
  {
    qb_ref_number: "07204",
    qb_txn_id: "1852F2-1736529915",
    txn_date_iso: "2025-01-10T17:00:00.000Z",
    subtotal_cents: 9799,
    discount_cents: 0,
    total_cents: 9799,
    lines: [
      {
        sku: "NV-FLBT4-25RCW",
        description:
          "4-Pack 25W RGBCW Bluetooth Mesh Smart Flood Lights. 2-year Warranty.",
        quantity: 1,
        unit_price_cents: 9799,
        total_cents: 9799,
      },
    ],
  },
  {
    qb_ref_number: "08675",
    qb_txn_id: "1AE8E4-1764009443",
    txn_date_iso: "2025-11-24T17:00:00.000Z",
    subtotal_cents: 41965,
    discount_cents: 6295,
    total_cents: 35670,
    memo: "Estimate E18023764:",
    lines: [
      {
        sku: "SAT-65-571R1",
        description:
          "LED Panel, 2x2FT, 120-277V, Power Selectable 20W/30W/40W, Color Selectable 3500K/4000K/5000K",
        quantity: 7,
        unit_price_cents: 5995,
        total_cents: 41965,
      },
    ],
  },
  {
    qb_ref_number: "18965",
    qb_txn_id: "1B67D3-1769531407",
    txn_date_iso: "2026-01-27T17:00:00.000Z",
    subtotal_cents: 7570,
    discount_cents: 0,
    total_cents: 7570,
    lines: [
      {
        sku: "SAT-67-138",
        description:
          "Emergency Light Dual Head White 0.8 W 120/277 Volts 210L 5700K Indoor",
        quantity: 2,
        unit_price_cents: 3785,
        total_cents: 7570,
      },
    ],
  },
  {
    qb_ref_number: "18968",
    qb_txn_id: "1B698D-1769615205",
    txn_date_iso: "2026-01-28T17:00:00.000Z",
    subtotal_cents: 35592,
    discount_cents: 0,
    total_cents: 35592,
    lines: [
      {
        sku: "SAT-67-130",
        description:
          "EMERGENCY LIGHT DH Emergency Light, 90min Ni-Cad backup, 120/277V, Dual Head",
        quantity: 5,
        unit_price_cents: 3999,
        total_cents: 19995,
      },
      {
        sku: "SAT-67/121",
        description:
          "EXIT/LIGHT DH - RED Combination Red Exit Sign/Emergency Light, 90min Ni-Cad backup",
        quantity: 2,
        unit_price_cents: 6799,
        total_cents: 13598,
      },
      {
        sku: "SAT-S11401",
        description:
          "9W A19 Clear LED Dimmable E26 Medium 760lm 5000k 120V, 10 Pack",
        quantity: 1,
        unit_price_cents: 1999,
        total_cents: 1999,
      },
    ],
  },
];

function audit(entry: Record<string, unknown>) {
  appendFileSync(
    AUDIT_FILE,
    JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n"
  );
}

export default async function backfillGoodlookInvoices({ container }: ExecArgs) {
  const logger = container.resolve("logger");
  const orderModule = container.resolve(Modules.ORDER) as any;
  const customerModule = container.resolve(Modules.CUSTOMER) as any;
  const invoiceService = container.resolve(INVOICE_MODULE) as any;
  const pg = container.resolve("__pg_connection__") as any;

  logger.info(`Mode: ${APPLY ? "APPLY" : "DRY_RUN"}`);

  // Integrity: line sums must match QB totals exactly.
  for (const inv of INVOICES) {
    const sum = inv.lines.reduce((s, l) => s + l.total_cents, 0);
    if (sum !== inv.subtotal_cents) {
      throw new Error(`[${inv.qb_ref_number}] line sum ${sum} ≠ subtotal ${inv.subtotal_cents}`);
    }
    if (inv.subtotal_cents - inv.discount_cents !== inv.total_cents) {
      throw new Error(`[${inv.qb_ref_number}] subtotal−discount ≠ total`);
    }
  }

  const customer = await customerModule.retrieveCustomer(CUSTOMER_ID);
  if (!customer) throw new Error(`Customer ${CUSTOMER_ID} not found`);

  // Resolve variant ids for every SKU up front — abort if any is missing.
  const allSkus = INVOICES.flatMap((i) => i.lines.map((l) => l.sku));
  const variantRows = (
    await pg.raw(
      `SELECT pv.sku, pv.id, pv.title, p.title AS product_title
         FROM product_variant pv JOIN product p ON p.id = pv.product_id
        WHERE pv.sku = ANY(?) AND pv.deleted_at IS NULL`,
      [allSkus]
    )
  ).rows as Array<{ sku: string; id: string; title: string; product_title: string }>;
  const bySku = new Map(variantRows.map((r) => [r.sku, r]));
  const missing = allSkus.filter((s) => !bySku.has(s));
  if (missing.length) throw new Error(`Variants missing for SKUs: ${missing.join(", ")}`);

  for (const inv of INVOICES) {
    const tag = `[${inv.qb_ref_number}]`;
    const totalDollars = (inv.total_cents / 100).toFixed(2);

    // ── Guard: invoice already backfilled? ─────────────────────────────────
    const existingInv = (
      await pg.raw(
        `SELECT id FROM pos_invoice WHERE metadata->>'qb_txn_id' = ? AND deleted_at IS NULL`,
        [inv.qb_txn_id]
      )
    ).rows;
    if (existingInv.length) {
      logger.info(`${tag} pos_invoice ${existingInv[0].id} already exists — skipping`);
      continue;
    }

    logger.info(
      `${tag} will create order + invoice — total $${totalDollars}, ${inv.lines.length} line(s)` +
        (inv.discount_cents ? `, discount $${(inv.discount_cents / 100).toFixed(2)}` : "")
    );
    if (!APPLY) continue;

    // ── 1. Order (reuse if a prior partial run created it) ─────────────────
    let orderId: string;
    let documentNumber: string;
    const existingOrder = (
      await pg.raw(
        `SELECT id, metadata->>'document_number' AS docnum FROM "order"
          WHERE metadata->>'qb_invoice_txn_id' = ? AND deleted_at IS NULL`,
        [inv.qb_txn_id]
      )
    ).rows;
    if (existingOrder.length) {
      orderId = existingOrder[0].id;
      documentNumber = existingOrder[0].docnum;
      logger.info(`${tag} reusing order ${orderId} (${documentNumber})`);
    } else {
      const seqRes = await pg.raw(`SELECT nextval('custom_order_seq') AS seq`);
      documentNumber = `S${seqRes.rows[0].seq || seqRes.rows[0].SEQ}`;
      const nowIso = new Date().toISOString();
      const subtotalD = inv.subtotal_cents / 100;
      const discountD = inv.discount_cents / 100;
      const totalD = inv.total_cents / 100;

      const created = await orderModule.createOrders({
        region_id: REGION_ID,
        sales_channel_id: SALES_CHANNEL_ID,
        customer_id: CUSTOMER_ID,
        email: customer.email,
        currency_code: "usd",
        status: "pending",
        is_draft_order: false,
        items: inv.lines.map((l) => {
          const v = bySku.get(l.sku)!;
          return {
            variant_id: v.id,
            variant_sku: l.sku,
            title: v.title || l.sku,
            product_title: v.product_title,
            quantity: l.quantity,
            unit_price: l.unit_price_cents / 100,
          };
        }),
        metadata: {
          document_number: documentNumber,
          pos_created: true,
          pos_created_at: nowIso,
          pos_created_by: "QB Backfill",
          order_placed_at: inv.txn_date_iso,
          confirmed_at: inv.txn_date_iso,
          order_status: "Fulfilled",
          fully_invoiced: true,
          tax_mode: "exempt",
          qb_list_id: QB_CUSTOMER_LIST_ID,
          pos_total: totalD,
          computed_total: totalD,
          computed_subtotal: subtotalD,
          computed_discount: discountD,
          computed_tax_amount: 0,
          ...(inv.discount_cents
            ? { discount_type: "fixed", discount_value: discountD }
            : {}),
          qb_skip: true,
          qb_sync_status: "synced",
          qb_synced_at: nowIso,
          qb_invoice_txn_id: inv.qb_txn_id,
          qb_invoice_ref_number: inv.qb_ref_number,
          qb_ref_number: inv.qb_ref_number,
          manually_imported: true,
          manually_imported_source: `QB Desktop Invoice ${inv.qb_ref_number} (backfill 2026-08-26)`,
          ...(inv.memo ? { pos_notes: inv.memo } : {}),
        },
      });
      orderId = created.id;
      // Backdate so lists sort the order at its real business date.
      await pg.raw(`UPDATE "order" SET created_at = ?::timestamptz WHERE id = ?`, [
        inv.txn_date_iso,
        orderId,
      ]);
      audit({ step: "order_created", qb_ref: inv.qb_ref_number, order_id: orderId, document_number: documentNumber });
      logger.info(`${tag} ✅ order ${orderId} (${documentNumber}) created`);
    }

    // ── 2. Invoice number (gapless counter, same as the live route) ────────
    const numRes = await pg.raw(
      `UPDATE document_number_counter SET value = value + 1, updated_at = now()
        WHERE name = 'medusa_invoice' RETURNING value`
    );
    const invoiceNumber = String(numRes.rows[0].value);

    // ── 3. pos_invoice + items ─────────────────────────────────────────────
    const invoice = await invoiceService.createPosInvoices({
      invoice_number: invoiceNumber,
      order_id: orderId,
      fulfillment_id: null,
      customer_id: CUSTOMER_ID,
      status: "issued",
      subtotal: inv.subtotal_cents,
      discount: inv.discount_cents,
      shipping: 0,
      tax: 0,
      untaxed_total: inv.total_cents,
      total: inv.total_cents,
      amount_paid: 0,
      balance_due: inv.total_cents,
      payment_method: null,
      card_brand: null,
      issued_at: new Date(inv.txn_date_iso),
      paid_at: null,
      notes: `Backfilled from QuickBooks Invoice #${inv.qb_ref_number} (payments applied separately).`,
      created_by: "QB Backfill",
      shipping_address: null,
      metadata: {
        is_sales_receipt: false,
        qb_ref_number: inv.qb_ref_number,
        qb_txn_id: inv.qb_txn_id,
        qb_sync_status: "synced",
        qb_synced_at: new Date().toISOString(),
        manually_imported: true,
        import_source: `QB Desktop Invoice ${inv.qb_ref_number} (backfill 2026-08-26)`,
      },
    });
    const invoiceId = invoice.id;
    await invoiceService.createPosInvoiceItems(
      inv.lines.map((l, idx) => ({
        invoice_id: invoiceId,
        variant_id: bySku.get(l.sku)!.id,
        sku: l.sku,
        description: l.description,
        quantity: l.quantity,
        unit_price: l.unit_price_cents,
        total: l.total_cents,
        taxable: false,
        sort_order: idx,
      }))
    );
    audit({ step: "invoice_created", qb_ref: inv.qb_ref_number, invoice_id: invoiceId, invoice_number: invoiceNumber, order_id: orderId });
    logger.info(`${tag} ✅ pos_invoice ${invoiceId} (INV-${invoiceNumber}) + ${inv.lines.length} item(s)`);

    // ── 4. Pipeline rows: lock as already-synced ───────────────────────────
    await pg.raw(
      `INSERT INTO qb_order_pipeline
         (order_id, reference_id, reference_type, step, status, qb_txn_id, qb_ref_number, medusa_ref_number, payload, submitted_at, confirmed_at)
       VALUES
         (?, ?, 'customer', 'customer', 'confirmed', ?, NULL, NULL, ?::jsonb, NOW(), NOW()),
         (?, NULL, NULL, 'sales_order', 'skipped', NULL, NULL, ?, ?::jsonb, NOW(), NOW()),
         (?, ?, 'pos_invoice', 'invoice', 'confirmed', ?, ?, ?, ?::jsonb, NOW(), NOW())`,
      [
        orderId, CUSTOMER_ID, QB_CUSTOMER_LIST_ID,
        JSON.stringify({ backfilled: true, source: `Invoice ${inv.qb_ref_number} backfill` }),
        orderId, documentNumber,
        JSON.stringify({ backfilled: true, reason: `No QB Sales Order — invoice ${inv.qb_ref_number} pre-exists in QB` }),
        orderId, invoiceId, inv.qb_txn_id, inv.qb_ref_number, `IN-${invoiceNumber}`,
        JSON.stringify({ backfilled: true, source: `Invoice ${inv.qb_ref_number} pre-exists in QB Desktop` }),
      ]
    );
    // Deep-merge is fine here: only ADDING the qb_invoices key.
    await orderModule.updateOrders(orderId, {
      metadata: {
        qb_invoices: [
          { txn_id: inv.qb_txn_id, ref_number: inv.qb_ref_number, invoice_id: invoiceId, synced_at: new Date().toISOString(), fulfillment_id: null, operation_id: null, edit_sequence: null },
        ],
      },
    });
    audit({ step: "pipeline_seeded", qb_ref: inv.qb_ref_number, order_id: orderId, invoice_id: invoiceId, qb_txn_id: inv.qb_txn_id });
    logger.info(`${tag} ✅ pipeline seeded (customer confirmed / sales_order skipped / invoice confirmed ${inv.qb_txn_id})`);
  }

  logger.info(`${"=".repeat(60)}`);
  logger.info(APPLY ? "✅ APPLY complete" : "DRY_RUN complete — re-run with APPLY=true to write");
}
