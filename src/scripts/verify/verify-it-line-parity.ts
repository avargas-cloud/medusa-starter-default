/**
 * verify-it-line-parity
 *
 * Gate for the PO↔IT line mirror (purchase_order_line_id identity).
 *
 * WHAT IT PROVES
 * That no linked inventory transfer has COLLAPSED lines: a (transfer, variant)
 * pair backed by MORE live PO lines than live IT lines. That is the exact
 * signature of the variant-keyed mirror bug (PO-1138/IT-1045, PO-1087/IT-1036):
 * two PO lines sharing the Sample-Product placeholder variant were upserted
 * into one IT row, silently dropping units from the transfer and from the
 * China reservation rebuild.
 *
 * Also proves FK integrity: every non-null purchase_order_line_id on a live IT
 * line resolves to a live PO line of the linked PO with the same variant.
 *
 * FAIL (exit 1): any collapse row, or any dangling/mismatched FK.
 * WARN (exit 0): qty drift on open ITs and unclaimed (NULL-FK) lines — reported
 * for the operator, non-fatal: legacy drift predates the fix and received ITs
 * are frozen history.
 *
 * Run: ./node_modules/.bin/tsx src/scripts/verify/verify-it-line-parity.ts
 */

import { Client } from "pg";

interface CollapseRow {
  po_number: string;
  it_number: string;
  it_status: string;
  product_variant_id: string;
  po_lines: number;
  po_units: number;
  it_lines: number;
  it_units: number;
}

interface FkRow {
  it_number: string;
  itl_id: string;
  purchase_order_line_id: string;
  problem: string;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const client = new Client({ connectionString: url });
  await client.connect();

  let failures = 0;

  try {
    // ── 1. Collapse detector ──────────────────────────────────────────────
    const collapse = await client.query<CollapseRow>(
      `WITH po_side AS (
         SELECT it.id AS it_id, it.number AS it_number, it.status AS it_status,
                po.number AS po_number, pol.product_variant_id,
                COUNT(*)::int AS po_lines,
                SUM(pol.qty_ordered - pol.qty_cancelled)::int AS po_units
           FROM inventory_transfer it
           JOIN purchase_order po ON po.id = it.linked_purchase_order_id
           JOIN purchase_order_line pol
             ON pol.purchase_order_id = po.id AND pol.deleted_at IS NULL
          WHERE it.deleted_at IS NULL AND it.status <> 'voided'
            AND pol.status <> 'cancelled'
            AND (pol.qty_ordered - pol.qty_cancelled) > 0
          GROUP BY it.id, it.number, it.status, po.number, pol.product_variant_id
       ),
       it_side AS (
         SELECT itl.transfer_id, itl.product_variant_id,
                COUNT(*)::int AS it_lines, SUM(itl.qty)::int AS it_units
           FROM inventory_transfer_line itl
          WHERE itl.deleted_at IS NULL
          GROUP BY itl.transfer_id, itl.product_variant_id
       )
       SELECT p.po_number, p.it_number, p.it_status, p.product_variant_id,
              p.po_lines, p.po_units,
              COALESCE(i.it_lines, 0) AS it_lines,
              COALESCE(i.it_units, 0) AS it_units
         FROM po_side p
         LEFT JOIN it_side i
           ON i.transfer_id = p.it_id
          AND i.product_variant_id = p.product_variant_id
        WHERE COALESCE(i.it_lines, 0) < p.po_lines
        ORDER BY p.it_number`
    );

    if (collapse.rows.length > 0) {
      failures += collapse.rows.length;
      console.error(`✗ COLLAPSED lines (${collapse.rows.length}):`);
      for (const r of collapse.rows) {
        console.error(
          `  ${r.it_number} (${r.it_status}) ← ${r.po_number}: variant ${r.product_variant_id} has ${r.po_lines} PO lines (${r.po_units} u) but ${r.it_lines} IT lines (${r.it_units} u)`
        );
      }
    } else {
      console.log("✓ No collapsed (transfer, variant) pairs");
    }

    // ── 2. FK integrity (skipped gracefully before the migration lands) ───
    const colProbe = await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'inventory_transfer_line'
          AND column_name = 'purchase_order_line_id'`
    );
    if (colProbe.rows.length === 0) {
      console.warn(
        "⚠ purchase_order_line_id column not present yet (pre-migration DB) — FK/qty checks skipped"
      );
      if (failures > 0) {
        console.error(`\nFAIL — ${failures} problem(s)`);
        process.exit(1);
      }
      console.log("\nPASS (pre-migration: collapse detector only)");
      return;
    }
    const fk = await client.query<FkRow>(
      `SELECT it.number AS it_number, itl.id AS itl_id,
              itl.purchase_order_line_id,
              CASE
                WHEN pol.id IS NULL THEN 'dangling: PO line missing or deleted'
                WHEN pol.purchase_order_id <> it.linked_purchase_order_id
                  THEN 'wrong PO: line belongs to another purchase order'
                WHEN pol.product_variant_id <> itl.product_variant_id
                  THEN 'variant mismatch between IT line and PO line'
              END AS problem
         FROM inventory_transfer_line itl
         JOIN inventory_transfer it
           ON it.id = itl.transfer_id AND it.deleted_at IS NULL
         LEFT JOIN purchase_order_line pol
           ON pol.id = itl.purchase_order_line_id AND pol.deleted_at IS NULL
        WHERE itl.deleted_at IS NULL
          AND itl.purchase_order_line_id IS NOT NULL
          AND (
            pol.id IS NULL
            OR pol.purchase_order_id <> it.linked_purchase_order_id
            OR pol.product_variant_id <> itl.product_variant_id
          )
        ORDER BY it.number`
    );

    if (fk.rows.length > 0) {
      failures += fk.rows.length;
      console.error(`✗ FK integrity problems (${fk.rows.length}):`);
      for (const r of fk.rows) {
        console.error(`  ${r.it_number} ${r.itl_id} → ${r.purchase_order_line_id}: ${r.problem}`);
      }
    } else {
      console.log("✓ Every purchase_order_line_id resolves to a live, matching PO line");
    }

    // ── 3. WARN: unclaimed lines on linked ITs ────────────────────────────
    const unclaimed = await client.query(
      `SELECT it.number AS it_number, COUNT(*)::int AS lines
         FROM inventory_transfer_line itl
         JOIN inventory_transfer it
           ON it.id = itl.transfer_id AND it.deleted_at IS NULL
        WHERE itl.deleted_at IS NULL
          AND itl.purchase_order_line_id IS NULL
          AND it.linked_purchase_order_id IS NOT NULL
        GROUP BY it.number ORDER BY it.number`
    );
    if (unclaimed.rows.length > 0) {
      console.warn(
        `⚠ Unclaimed (NULL-FK) lines on linked ITs: ${unclaimed.rows
          .map((r) => `${r.it_number}×${r.lines}`)
          .join(", ")}`
      );
    } else {
      console.log("✓ No unclaimed lines on linked transfers");
    }

    // ── 4. FAIL: qty drift between a PO line and its IT line ──────────────
    //
    // This was a WARN scoped to draft/confirmed/shipped, on the reasoning that
    // "received ITs are frozen history". That is the same premise the mirror's
    // status filter encoded, and it is what let PO-1129 through: its transfer
    // had closed, so a 10→20 raise never reached the IT and this check was not
    // even looking. A received transfer is not frozen — the PO can still change
    // under it, and the mirror now follows. Scope is every live, non-voided
    // linked transfer, and drift is a failure, not a note.
    const drift = await client.query(
      `SELECT it.number AS it_number, it.status AS it_status, itl.id AS itl_id,
              itl.sku, itl.qty AS it_qty,
              (pol.qty_ordered - pol.qty_cancelled) AS po_qty
         FROM inventory_transfer_line itl
         JOIN inventory_transfer it
           ON it.id = itl.transfer_id AND it.deleted_at IS NULL
          AND it.voided_at IS NULL
          AND it.status IN ('draft', 'confirmed', 'shipped', 'received')
         JOIN purchase_order_line pol
           ON pol.id = itl.purchase_order_line_id AND pol.deleted_at IS NULL
        WHERE itl.deleted_at IS NULL
          AND itl.qty <> (pol.qty_ordered - pol.qty_cancelled)
        ORDER BY it.number`
    );
    if (drift.rows.length > 0) {
      failures += drift.rows.length;
      console.error(`✗ Qty drift between PO lines and their IT lines (${drift.rows.length}):`);
      for (const r of drift.rows) {
        console.error(
          `  ${r.it_number} [${r.it_status}] ${r.sku} ${r.itl_id}: IT qty ${r.it_qty} vs PO ${r.po_qty}`
        );
      }
    } else {
      console.log("✓ No qty drift between PO lines and their IT lines");
    }

    // ── 5. FAIL: a live PO line with no line on the linked transfer ───────
    //
    // The other half of the same mirror. A line ADDED to a PO whose IT had
    // closed produced no IT line at all, so the units carry no China
    // reservation and no transfer record — PO-1129's ECTSK-RFRC1C5A, 30 units,
    // invisible to every check that only compared lines that exist.
    const missing = await client.query(
      `SELECT it.number AS it_number, it.status AS it_status,
              po.number AS po_number, pol.sku_snapshot AS sku,
              (pol.qty_ordered - pol.qty_cancelled) AS po_qty
         FROM purchase_order po
         JOIN inventory_transfer it
           ON it.linked_purchase_order_id = po.id
          AND it.deleted_at IS NULL AND it.voided_at IS NULL
         JOIN purchase_order_line pol
           ON pol.purchase_order_id = po.id AND pol.deleted_at IS NULL
        WHERE NOT EXISTS (
          SELECT 1 FROM inventory_transfer_line itl
           WHERE itl.transfer_id = it.id
             AND itl.deleted_at IS NULL
             AND (
               itl.purchase_order_line_id = pol.id
               OR (itl.purchase_order_line_id IS NULL
                   AND itl.product_variant_id = pol.product_variant_id)
             )
        )
        ORDER BY it.number, pol.sku_snapshot`
    );
    if (missing.rows.length > 0) {
      failures += missing.rows.length;
      console.error(`✗ PO lines with no line on the linked transfer (${missing.rows.length}):`);
      for (const r of missing.rows) {
        console.error(
          `  ${r.it_number} [${r.it_status}] ${r.po_number} ${r.sku}: ${r.po_qty} units unmirrored`
        );
      }
    } else {
      console.log("✓ Every live PO line has a line on its linked transfer");
    }
  } finally {
    await client.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL — ${failures} problem(s)`);
    process.exit(1);
  }
  console.log("\nPASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
