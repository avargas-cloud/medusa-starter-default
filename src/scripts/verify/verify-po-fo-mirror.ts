/**
 * verify-po-fo-mirror.ts — gate for the PO → FO mirror feature.
 *
 * Part A: in-process fixtures over computeMirrorDiff/isDiffEmpty — every diff
 *         bucket (missing / removed / qty / cost / extra) must fire from a
 *         fixture built to trip exactly it, and a clean pair must be in_sync.
 * Part B: DB invariants over live data:
 *   B1. columns exist (migration applied)
 *   B2. a non-null factory_order_line.purchase_order_line_id always points to
 *       a purchase_order_line of the PO its FO is linked to
 *   B3. no two live lines of one FO claim the same purchase_order_line_id
 *   B4. factory_order.linked_purchase_order_id always points to a live PO
 *
 * Run:  env DATABASE_URL=... ./node_modules/.bin/tsx src/scripts/verify/verify-po-fo-mirror.ts
 * (tsx-style script — NOT medusa exec.)
 */

import { Client } from "pg";

import {
  computeMirrorDiff,
  type FoLineRow,
  isDiffEmpty,
  type PoMirrorLine,
} from "../../api/admin/factory-orders/_lib/po-mirror";

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function poLine(over: Partial<PoMirrorLine> = {}): PoMirrorLine {
  return {
    po_line_id: "pol_A",
    product_variant_id: "variant_1",
    inventory_item_id: "iitem_1",
    sku: "SKU-1",
    description: "Item one",
    qty: 10,
    unit_cost_cents: 2497,
    line_order: 0,
    ...over,
  };
}

function foLine(over: Partial<FoLineRow> = {}): FoLineRow {
  return {
    id: "fol_A",
    purchase_order_line_id: "pol_A",
    product_variant_id: "variant_1",
    qty_ordered: 10,
    qty_received: 0,
    unit_cost_cents: 2497,
    sku_snapshot: "SKU-1",
    description_snapshot: "Item one",
    tax_cents: 0,
    line_order: 0,
    ...over,
  };
}

function partA() {
  console.log("Part A — computeMirrorDiff fixtures");

  const clean = computeMirrorDiff([poLine()], [foLine()]);
  check("A1 identical pair is in_sync", isDiffEmpty(clean));

  const missing = computeMirrorDiff(
    [poLine(), poLine({ po_line_id: "pol_B", sku: "SKU-2" })],
    [foLine()]
  );
  check(
    "A2 PO line absent from FO lands in missing",
    missing.missing.length === 1 && missing.missing[0].po_line_id === "pol_B"
  );

  const removed = computeMirrorDiff(
    [],
    [foLine()]
  );
  check(
    "A3 FO mirror line no longer on PO lands in removed",
    removed.removed.length === 1 && removed.removed[0].id === "fol_A"
  );

  const qty = computeMirrorDiff([poLine({ qty: 5 })], [foLine()]);
  check(
    "A4 qty drift detected (PO 5 vs FO 10)",
    qty.qty_changed.length === 1 &&
      qty.qty_changed[0].po_qty === 5 &&
      qty.qty_changed[0].fo_qty === 10 &&
      !isDiffEmpty(qty)
  );

  const cost = computeMirrorDiff([poLine({ unit_cost_cents: 2600 })], [foLine()]);
  check(
    "A5 cost drift detected",
    cost.cost_changed.length === 1 && cost.cost_changed[0].po_cost_cents === 2600
  );

  const extra = computeMirrorDiff(
    [poLine()],
    [foLine(), foLine({ id: "fol_X", purchase_order_line_id: null })]
  );
  check(
    "A6 hand-added FO line (null pol id) lands in extra",
    extra.extra.length === 1 && extra.extra[0].id === "fol_X" && !isDiffEmpty(extra)
  );

  // The Sample-Product trap: two PO lines sharing one variant must map to two
  // FO lines — keyed by pol id, never collapsed by variant.
  const sampleTwin = computeMirrorDiff(
    [
      poLine({ po_line_id: "pol_S1", product_variant_id: "variant_sample", qty: 5 }),
      poLine({ po_line_id: "pol_S2", product_variant_id: "variant_sample", qty: 2 }),
    ],
    [
      foLine({ id: "fol_S1", purchase_order_line_id: "pol_S1", product_variant_id: "variant_sample", qty_ordered: 5 }),
      foLine({ id: "fol_S2", purchase_order_line_id: "pol_S2", product_variant_id: "variant_sample", qty_ordered: 2 }),
    ]
  );
  check("A7 sibling lines sharing a variant stay separate and in_sync", isDiffEmpty(sampleTwin));
}

async function partB(db: Client) {
  console.log("Part B — DB invariants");

  const cols = await db.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name = 'factory_order' AND column_name = 'linked_purchase_order_id')
         OR (table_name = 'factory_order_line' AND column_name = 'purchase_order_line_id')`
  );
  check("B1 migration columns exist", cols.rows.length === 2, `found ${cols.rows.length}/2`);

  const orphanLines = await db.query(
    `SELECT fol.id
       FROM factory_order_line fol
       JOIN factory_order fo ON fo.id = fol.factory_order_id
      WHERE fol.purchase_order_line_id IS NOT NULL
        AND fol.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM purchase_order_line pol
           WHERE pol.id = fol.purchase_order_line_id
             AND pol.purchase_order_id = fo.linked_purchase_order_id
        )`
  );
  check(
    "B2 every mirrored FO line points into its linked PO",
    orphanLines.rows.length === 0,
    orphanLines.rows.map((r) => r.id).join(", ")
  );

  const dupClaims = await db.query(
    `SELECT factory_order_id, purchase_order_line_id, count(*) AS n
       FROM factory_order_line
      WHERE purchase_order_line_id IS NOT NULL AND deleted_at IS NULL
      GROUP BY factory_order_id, purchase_order_line_id
     HAVING count(*) > 1`
  );
  check(
    "B3 no FO claims the same PO line twice",
    dupClaims.rows.length === 0,
    JSON.stringify(dupClaims.rows)
  );

  const orphanFos = await db.query(
    `SELECT fo.id, fo.number
       FROM factory_order fo
      WHERE fo.linked_purchase_order_id IS NOT NULL
        AND fo.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM purchase_order po
           WHERE po.id = fo.linked_purchase_order_id AND po.deleted_at IS NULL
        )`
  );
  check(
    "B4 every linked FO points to a live PO",
    orphanFos.rows.length === 0,
    orphanFos.rows.map((r) => r.number ?? r.id).join(", ")
  );
}

async function main() {
  partA();

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("Part B skipped — DATABASE_URL not set");
  } else {
    const db = new Client({ connectionString: url });
    await db.connect();
    try {
      await partB(db);
    } finally {
      await db.end();
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("verify-po-fo-mirror crashed:", err);
  process.exit(1);
});
