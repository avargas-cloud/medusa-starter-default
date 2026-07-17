/**
 * src/scripts/fix/reconcile-received-po-it-lines-doconly.ts
 *
 * DOC-ONLY repair for the historical PO→IT drift on ALREADY-RECEIVED transfers.
 *
 * The main reconcile script (reconcile-po-it-lines.ts) deliberately SKIPS pairs
 * whose PO has received units (`needs_manual`) because it calls
 * rebuildTransferChinaReservations — rebuilding China reservations for goods
 * that already landed in Miami could create phantom reservations.
 *
 * This script repairs those skipped pairs SAFELY:
 *   - Inserts PO lines that are missing from the linked IT (doc-only).
 *   - Recomputes the IT header totals from its live lines.
 *   - Does NOT rebuild China reservations.
 *   - Does NOT touch inventory_level / stock / Meili.
 *
 * Why this is inventory-safe: the goods were received via the PO RECEIPT (which
 * carries every line), so China stock was decremented correctly at receive time
 * independent of the IT. There are no active China reservations left on a
 * received transfer, and inventory_transfer_line has no PG triggers — inserting
 * a document row moves no stock. It only makes the IT document match its PO.
 *
 * Scope: only INSERTs of missing lines. Qty changes and extra IT lines are
 * reported but NOT auto-applied (deleting/altering a line on a received transfer
 * is not safe to automate) — none exist in the current data anyway.
 *
 * USAGE (dry-run is the default — nothing is written):
 *   env DATABASE_URL=... npx medusa exec ./src/scripts/fix/reconcile-received-po-it-lines-doconly.ts
 * APPLY:
 *   APPLY=true env DATABASE_URL=... npx medusa exec ./src/scripts/fix/reconcile-received-po-it-lines-doconly.ts
 */

import { generateEntityId } from "@medusajs/utils";

type KnexRaw = {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount?: number }>;
};

interface PairRow {
  transfer_id: string;
  it_number: string | null;
  it_status: string;
  po_id: string;
  po_number: string | null;
  po_received: number;
}

interface LineRow {
  product_variant_id: string;
  sku: string;
  description: string;
  qty: number;
  unit_cost_cents: number;
}

export default async function reconcileReceivedPoItLinesDocOnly({
  container,
}: {
  container: { resolve: (k: string) => unknown };
}) {
  const APPLY = process.env.APPLY === "true";
  const knex = container.resolve("__pg_connection__") as KnexRaw;

  // Only pairs the main script SKIPS: linked IT (not deleted) whose PO has
  // received units. Any IT status is allowed here (received transfers are the
  // whole point). We still exclude voided ITs.
  const pairs = (
    await knex.raw(
      `SELECT it.id AS transfer_id, it.number AS it_number, it.status AS it_status,
              po.id AS po_id, po.number AS po_number,
              COALESCE((
                SELECT SUM(qty_received) FROM purchase_order_line
                 WHERE purchase_order_id = po.id AND deleted_at IS NULL
              ), 0) AS po_received
         FROM inventory_transfer it
         JOIN purchase_order po ON po.id = it.linked_purchase_order_id
        WHERE it.deleted_at IS NULL
          AND it.status <> 'voided'
        ORDER BY it.created_at ASC`
    )
  ).rows as PairRow[];

  const received = pairs.filter((p) => Number(p.po_received) > 0);

  console.log(
    `\n🔧 DOC-ONLY reconcile of received PO↔IT lines — ${APPLY ? "APPLY" : "DRY-RUN"} — ${received.length} received linked transfer(s)\n`
  );

  let clean = 0;
  let repaired = 0;
  let totalInserted = 0;

  for (const pair of received) {
    const itLines = (
      await knex.raw(
        `SELECT product_variant_id, sku, description, qty, unit_cost_cents
           FROM inventory_transfer_line
          WHERE transfer_id = ? AND deleted_at IS NULL`,
        [pair.transfer_id]
      )
    ).rows as LineRow[];
    const poLines = (
      await knex.raw(
        `SELECT product_variant_id, sku_snapshot AS sku, description_snapshot AS description,
                qty_ordered AS qty, unit_cost_cents
           FROM purchase_order_line
          WHERE purchase_order_id = ? AND deleted_at IS NULL`,
        [pair.po_id]
      )
    ).rows as LineRow[];

    const itByVariant = new Map(itLines.map((l) => [l.product_variant_id, l]));
    const poByVariant = new Map(poLines.map((l) => [l.product_variant_id, l]));

    const toInsert = poLines.filter((pl) => !itByVariant.has(pl.product_variant_id));
    const qtyDiff = poLines.filter((pl) => {
      const il = itByVariant.get(pl.product_variant_id);
      return il && Number(il.qty) !== Number(pl.qty);
    });
    const extraInIt = itLines.filter(
      (il) => !poByVariant.has(il.product_variant_id)
    );

    if (toInsert.length === 0) {
      clean++;
      if (qtyDiff.length > 0 || extraInIt.length > 0) {
        console.log(
          `• ${pair.it_number} ↔ ${pair.po_number}  (no missing lines, but note:)`
        );
        for (const u of qtyDiff)
          console.log(`    ! qty differs (NOT auto-fixed) ${u.sku}`);
        for (const e of extraInIt)
          console.log(`    ! IT line not in PO (NOT auto-removed) ${e.sku}`);
      }
      continue;
    }

    repaired++;
    console.log(`• ${pair.it_number} ↔ ${pair.po_number}  (status=${pair.it_status})`);
    for (const l of toInsert)
      console.log(`    + insert IT line (doc-only)  ${l.sku} qty=${l.qty}`);
    for (const u of qtyDiff)
      console.log(`    ! qty differs (NOT auto-fixed) ${u.sku}`);
    for (const e of extraInIt)
      console.log(`    ! IT line not in PO (NOT auto-removed) ${e.sku}`);

    if (APPLY) {
      for (const l of toInsert) {
        // Prefer reviving a soft-deleted row for the variant if one exists.
        const existing = (
          await knex.raw(
            `SELECT id FROM inventory_transfer_line
              WHERE transfer_id = ? AND product_variant_id = ?
              ORDER BY deleted_at IS NULL DESC, updated_at DESC LIMIT 1`,
            [pair.transfer_id, l.product_variant_id]
          )
        ).rows[0] as { id: string } | undefined;
        if (existing?.id) {
          await knex.raw(
            `UPDATE inventory_transfer_line
                SET qty = ?, unit_cost_cents = ?, sku = ?, description = ?,
                    deleted_at = NULL, updated_at = NOW()
              WHERE id = ?`,
            [l.qty, l.unit_cost_cents, l.sku, l.description ?? "", existing.id]
          );
        } else {
          await knex.raw(
            `INSERT INTO inventory_transfer_line (
                id, transfer_id, product_variant_id, sku, description,
                qty, unit_cost_cents, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [
              generateEntityId("", "itl"),
              pair.transfer_id,
              l.product_variant_id,
              l.sku,
              l.description ?? "",
              l.qty,
              l.unit_cost_cents,
            ]
          );
        }
        totalInserted++;
      }
      // Recompute IT header totals from live lines (no stock/reservation touch).
      await knex.raw(
        `UPDATE inventory_transfer AS it
            SET total_lines = agg.c, total_units = agg.u, subtotal_cents = agg.s,
                updated_at = NOW()
           FROM (
             SELECT COUNT(*) AS c, COALESCE(SUM(qty), 0) AS u,
                    COALESCE(SUM(qty * unit_cost_cents), 0) AS s
               FROM inventory_transfer_line
              WHERE transfer_id = ? AND deleted_at IS NULL
           ) AS agg
          WHERE it.id = ?`,
        [pair.transfer_id, pair.transfer_id]
      );
      console.log(`    ✅ applied (${toInsert.length} line(s), header totals recomputed)`);
    }
  }

  console.log(`\n──────── summary ────────`);
  console.log(`  received linked transfers : ${received.length}`);
  console.log(`  already in sync           : ${clean}`);
  console.log(`  ${APPLY ? "repaired" : "would repair"}   : ${repaired}`);
  console.log(`  lines inserted            : ${APPLY ? totalInserted : "(dry-run)"}`);
  console.log(
    `\n${APPLY ? "✅ APPLY complete." : "ℹ️  DRY-RUN only — re-run with APPLY=true to write."}\n`
  );
}
