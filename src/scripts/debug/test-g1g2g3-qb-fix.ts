/**
 * Standalone test — NO necesita Medusa running.
 * Corre con: env DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *            npx ts-node --project tsconfig.json src/scripts/debug/test-g1g2g3-qb-fix.ts
 *
 * Invoice 20514 en sandbox:
 *   - 3 líneas de producto, todas con 20% descuento por línea
 *   - LUX-LR23467: taxable=false  → G1
 *   - pos_invoice.discount = 64526 cents = suma exacta de per-line → G3 debe dar $0
 *
 * Expected:
 *   G1: QB payload de LUX-LR23467 tiene taxable:false
 *   G2: Precios en QB = precio descontado (no gross)
 *   G3: orderDiscountTotal = 0 → sin líneas Subtotal/Discount en QB
 */
import "reflect-metadata";
import { Pool } from "pg";
import {
  buildQbItems,
  buildQbOrderDiscountLines,
  getEffectiveOrderDiscount,
} from "../../lib/quickbooks/order-flow-core";
import { invoiceLineDiscountCents } from "../../lib/quickbooks/force-sync-doc-payload";

const INVOICE_ID             = "01KSR6VCYBSEYK9NZA70H2A3NN";
const ORDER_ID               = "01KQZM932T9490QN9D8RF2XXST";
const INVOICE_DISCOUNT_CENTS = 64526; // pos_invoice.discount snapshot

function getFloat(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function main() {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ||
      "postgresql://postgres:sandbox@localhost:5499/medusa",
  });

  // ── 1. Load pos_invoice_item snapshot (net_total_cents + taxable) ──────────
  const { rows: invItems } = await pool.query<{
    variant_id: string | null;
    sku: string | null;
    description: string;
    quantity: number;
    unit_price: number;
    total: number;
    net_total_cents: number | null;
    discount_type: string | null;
    discount_value: number | null;
    taxable: boolean;
  }>(
    `SELECT variant_id, sku, description, quantity, unit_price, total,
            net_total_cents, discount_type, discount_value, taxable
       FROM pos_invoice_item
      WHERE invoice_id = $1 AND deleted_at IS NULL
      ORDER BY id`,
    [INVOICE_ID]
  );

  console.log(`\n── pos_invoice_item rows (${invItems.length}) ──`);
  invItems.forEach((r) => {
    if (!r.variant_id) return; // skip comment lines
    console.log(
      `  ${r.sku ?? r.variant_id} | unit_price=${r.unit_price} | total=${r.total} | net=${r.net_total_cents} | discount=${r.discount_type} ${r.discount_value} | taxable=${r.taxable}`
    );
  });

  // ── 2. Load order items with metadata from DB directly ────────────────────
  // (replaces Medusa query.graph)
  const { rows: orderItems } = await pool.query<{
    id: string;
    variant_id: string | null;
    product_id: string | null;
    sku: string | null;
    title: string | null;
    unit_price: number;
    quantity: number;
    subtotal: number | null;
    metadata: any;
    qb_id: string | null;
  }>(
    `SELECT
       oli.id,
       oli.variant_id,
       pv.product_id,
       pv.sku,
       oli.title,
       oli.unit_price,
       oli.quantity,
       oli.raw_subtotal->>'value' AS subtotal,
       oli.metadata,
       pv.metadata->>'quickbooks_id' AS qb_id
     FROM order_line_item oli
     LEFT JOIN product_variant pv ON pv.id = oli.variant_id
     WHERE oli.order_id = $1 AND oli.deleted_at IS NULL`,
    [ORDER_ID]
  );

  // Also load product.taxable for each variant
  const productIds = orderItems.map((i) => i.product_id).filter(Boolean) as string[];
  let dbTaxableMap: Record<string, boolean> = {};
  if (productIds.length) {
    const { rows: taxRows } = await pool.query<{ id: string; taxable: boolean }>(
      `SELECT id, taxable FROM product WHERE id = ANY($1)`,
      [productIds]
    );
    dbTaxableMap = Object.fromEntries(taxRows.map((r) => [r.id, r.taxable]));
  }

  // ── 3. Build netByLine + snapshotTaxableByVariantId ───────────────────────
  let lineDiscountTotalCents = 0;
  const netByLine = new Map<string, number>();
  const snapshotTaxableByVariantId = new Map<string, boolean>();

  for (const r of invItems) {
    if (!r.variant_id || r.net_total_cents == null) continue;
    const grossCents = Math.round(Number(r.total));
    const key = `${r.variant_id}|${grossCents}`;
    netByLine.set(key, Number(r.net_total_cents));
    snapshotTaxableByVariantId.set(r.variant_id, r.taxable === true);
  }

  // ── 4. Build activeItems with per-line discounts baked ────────────────────
  const activeItems = orderItems
    .filter((item) => (item.quantity ?? 0) > 0 && item.qb_id)
    .map((item) => {
      const quantity = item.quantity;
      const grossUnitPrice = getFloat(item.unit_price);
      const grossTotalCents = Math.round(grossUnitPrice * quantity * 100);
      const lineDiscount = item.metadata?.line_discount as
        | { type?: string | null; value?: number | string | null }
        | null | undefined;

      const lineDiscountCentsComputed = invoiceLineDiscountCents(
        { discount_type: lineDiscount?.type ?? null, discount_value: lineDiscount?.value ?? null, quantity },
        null,
        grossTotalCents
      );

      const netKey = `${item.variant_id ?? item.sku ?? "custom"}|${grossTotalCents}`;
      const storedNet = netByLine.get(netKey);
      const hasStoredNet = storedNet != null && Number.isFinite(storedNet);
      const lineDiscountCents = hasStoredNet
        ? Math.max(0, grossTotalCents - Math.max(0, storedNet as number))
        : lineDiscountCentsComputed;

      lineDiscountTotalCents += lineDiscountCents;

      // Build a Medusa-shaped item for buildQbItems
      const medusaItem: any = {
        id: item.id,
        variant_id: item.variant_id,
        product_id: item.product_id,
        quantity,
        unit_price: grossUnitPrice,
        title: item.title,
        metadata: item.metadata,
        variant: {
          id: item.variant_id,
          sku: item.sku,
          product_id: item.product_id,
          metadata: { quickbooks_id: item.qb_id },
        },
      };

      if (lineDiscountCents > 0) {
        medusaItem.subtotal = Math.max(0, grossTotalCents - lineDiscountCents) / 100;
      }
      return medusaItem;
    });

  // ── 5. Build productTaxableMap + snapshot override ────────────────────────
  const productTaxableMap: Record<string, any> = {};
  for (const item of activeItems) {
    const pid = item.product_id;
    if (pid) productTaxableMap[pid] = { taxable: dbTaxableMap[pid] !== false };
  }
  // Snapshot override
  for (const item of activeItems) {
    const variantId = item.variant_id;
    const productId = item.product_id;
    if (variantId && productId && snapshotTaxableByVariantId.has(variantId)) {
      const snap = snapshotTaxableByVariantId.get(variantId)!;
      const existing = productTaxableMap[productId];
      productTaxableMap[productId] =
        typeof existing === "object" && existing !== null
          ? { ...existing, taxable: snap }
          : { taxable: snap };
    }
  }

  // ── 6. Build QB items ─────────────────────────────────────────────────────
  const prebuiltItems: any[] = buildQbItems(activeItems, {}, productTaxableMap);

  // ── 7. Order-level discount (G3) ──────────────────────────────────────────
  const invoiceDiscountAmount = INVOICE_DISCOUNT_CENTS / 100;
  const orderDiscountTotal    = Math.max(0, invoiceDiscountAmount - lineDiscountTotalCents / 100);

  if (orderDiscountTotal > 0) {
    buildQbOrderDiscountLines(orderDiscountTotal, null).forEach((l: any) =>
      prebuiltItems.push(l)
    );
  }

  await pool.end();

  // ── 8. Report ─────────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════");
  console.log("G1 / G2 / G3 — QB FIX TEST (Invoice 20514)");
  console.log("══════════════════════════════════════════════");

  // G2 — per-line discount totals
  console.log(`\n[G2] lineDiscountTotalCents = ${lineDiscountTotalCents}  (expected 64526)`);
  const g2 = lineDiscountTotalCents === 64526;
  console.log(`     ${g2 ? "✅ PASS" : "❌ FAIL"}`);

  // G3 — no order-level discount lines
  console.log(`\n[G3] invoiceDiscountAmount = $${invoiceDiscountAmount.toFixed(2)}`);
  console.log(`     lineDiscountTotal      = $${(lineDiscountTotalCents / 100).toFixed(2)}`);
  console.log(`     orderDiscountTotal     = $${orderDiscountTotal.toFixed(2)}  (expected $0.00)`);
  const discountQbLines = prebuiltItems.filter(
    (i) => i.productName === "Subtotal" || i.productName === "Discount"
  );
  const g3a = orderDiscountTotal === 0;
  const g3b = discountQbLines.length === 0;
  console.log(`     ${g3a ? "✅ PASS" : "❌ FAIL"}: orderDiscountTotal === 0`);
  console.log(`     ${g3b ? "✅ PASS" : "❌ FAIL"}: 0 Subtotal/Discount QB lines (got ${discountQbLines.length})`);

  // G1 — taxable snapshot
  console.log(`\n[G1] QB lines taxable flags:`);
  let g1 = true;
  for (const qbItem of prebuiltItems.filter((i) => i.productId)) {
    const srcItem = activeItems.find(
      (a) => a.variant?.metadata?.quickbooks_id === qbItem.productId
    );
    const sku     = srcItem?.variant?.sku ?? qbItem.productId;
    const snapshotTaxable = srcItem?.variant_id
      ? snapshotTaxableByVariantId.get(srcItem.variant_id)
      : undefined;
    const isLR23467 = sku?.includes("LR23467");
    if (isLR23467 && qbItem.taxable !== false) g1 = false;
    console.log(
      `     ${sku} | price=$${qbItem.price?.toFixed(2)} | amount=$${qbItem.amount?.toFixed(2)} | taxable=${qbItem.taxable ?? "(default true)"} ${isLR23467 ? (qbItem.taxable === false ? "✅" : "❌ expected false!") : ""}`
    );
  }
  console.log(`     ${g1 ? "✅ PASS" : "❌ FAIL"}: LUX-LR23467 taxable === false`);

  // Summary
  const allPass = g2 && g3a && g3b && g1;
  console.log(`\n══ ${allPass ? "✅ ALL PASS" : "❌ SOME FAILURES — see above"} ══\n`);

  if (!allPass) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
