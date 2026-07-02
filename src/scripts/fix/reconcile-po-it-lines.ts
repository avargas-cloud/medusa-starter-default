/**
 * src/scripts/fix/reconcile-po-it-lines.ts
 *
 * Reconciles line divergences between a Purchase Order and its linked
 * Inventory Transfer (IT). This repairs historical drift caused by the old
 * PO PATCH handler, which propagated line DELETES and QTY changes to the IT
 * but NOT line ADDS — so a variant added to a PO after the IT was created
 * never got a matching IT line (and therefore no China reservation → phantom
 * inventory). It also fixes IT header totals that drifted because the PO→IT
 * sync never recomputed them.
 *
 * The PO is treated as the source of truth for what is ordered (its lines are
 * what the operator edits and what QuickBooks/receiving see). For each linked
 * IT this script makes the IT lines match the PO lines by product_variant_id:
 *   - PO line variant missing from IT   → INSERT IT line
 *   - qty differs                       → UPDATE IT line qty
 *   - IT line variant missing from PO   → SOFT-DELETE IT line
 * then recomputes IT header totals and rebuilds China reservations + Meili.
 *
 * SAFETY: pairs whose PO already has any received units (qty_received > 0) are
 * SKIPPED — touching reservations after receiving could corrupt stock. Those
 * are reported as `needs_manual` for human review. Only ITs in status
 * draft/confirmed/shipped are considered (received/voided are terminal).
 *
 * USAGE (dry-run is the default — nothing is written):
 *   env DATABASE_URL=... npx medusa exec ./src/scripts/fix/reconcile-po-it-lines.ts
 * APPLY:
 *   APPLY=true env DATABASE_URL=... npx medusa exec ./src/scripts/fix/reconcile-po-it-lines.ts
 */

import { rebuildTransferChinaReservations } from "../../lib/inventory-transfer-reservations";
import { syncInventoryItemToMeiliSearchWorkflow } from "../../workflows/sync-inventory-item-meilisearch";
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

interface Divergence {
  it: string;
  po: string;
  toInsert: LineRow[];
  toUpdateQty: Array<{ variant: string; sku: string; from: number; to: number }>;
  toSoftDelete: Array<{ variant: string; sku: string; qty: number }>;
}

export default async function reconcilePoItLines({
  container,
}: {
  container: { resolve: (k: string) => unknown };
}) {
  const APPLY = process.env.APPLY === "true";
  const knex = container.resolve("__pg_connection__") as KnexRaw;

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
          AND it.status IN ('draft', 'confirmed', 'shipped')
        ORDER BY it.created_at ASC`
    )
  ).rows as PairRow[];

  console.log(
    `\n🔎 Reconcile PO↔IT lines — ${APPLY ? "APPLY" : "DRY-RUN"} — ${pairs.length} linked transfer(s)\n`
  );

  const divergences: Divergence[] = [];
  const needsManual: PairRow[] = [];
  let clean = 0;

  for (const pair of pairs) {
    if (Number(pair.po_received) > 0) {
      needsManual.push(pair);
      continue;
    }

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

    const div: Divergence = {
      it: pair.it_number ?? pair.transfer_id,
      po: pair.po_number ?? pair.po_id,
      toInsert: [],
      toUpdateQty: [],
      toSoftDelete: [],
    };

    for (const pl of poLines) {
      const il = itByVariant.get(pl.product_variant_id);
      if (!il) {
        div.toInsert.push(pl);
      } else if (Number(il.qty) !== Number(pl.qty)) {
        div.toUpdateQty.push({
          variant: pl.product_variant_id,
          sku: pl.sku,
          from: Number(il.qty),
          to: Number(pl.qty),
        });
      }
    }
    for (const il of itLines) {
      if (!poByVariant.has(il.product_variant_id)) {
        div.toSoftDelete.push({
          variant: il.product_variant_id,
          sku: il.sku,
          qty: Number(il.qty),
        });
      }
    }

    const dirty =
      div.toInsert.length > 0 ||
      div.toUpdateQty.length > 0 ||
      div.toSoftDelete.length > 0;
    if (!dirty) {
      clean++;
      continue;
    }
    divergences.push(div);

    console.log(`• ${div.it} ↔ ${div.po}`);
    for (const l of div.toInsert)
      console.log(`    + insert IT line   ${l.sku} qty=${l.qty}`);
    for (const u of div.toUpdateQty)
      console.log(`    ~ fix qty          ${u.sku} ${u.from} → ${u.to}`);
    for (const d of div.toSoftDelete)
      console.log(`    - soft-delete IT   ${d.sku} qty=${d.qty}`);

    if (APPLY) {
      for (const l of div.toInsert) {
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
      }
      for (const u of div.toUpdateQty) {
        await knex.raw(
          `UPDATE inventory_transfer_line SET qty = ?, updated_at = NOW()
            WHERE transfer_id = ? AND product_variant_id = ? AND deleted_at IS NULL`,
          [u.to, pair.transfer_id, u.variant]
        );
      }
      for (const d of div.toSoftDelete) {
        await knex.raw(
          `UPDATE inventory_transfer_line SET deleted_at = NOW(), updated_at = NOW()
            WHERE transfer_id = ? AND product_variant_id = ? AND deleted_at IS NULL`,
          [pair.transfer_id, d.variant]
        );
      }
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
      const touched = await rebuildTransferChinaReservations(
        knex,
        pair.transfer_id,
        pair.po_id
      );
      await Promise.allSettled(
        touched.map((inventoryItemId) =>
          syncInventoryItemToMeiliSearchWorkflow(
            container as never
          ).run({ input: { inventoryItemId } })
        )
      );
      console.log(`    ✅ applied (rebuilt ${touched.length} reservation item(s))`);
    }
  }

  console.log(`\n──────── summary ────────`);
  console.log(`  linked transfers scanned : ${pairs.length}`);
  console.log(`  already in sync          : ${clean}`);
  console.log(`  diverged                 : ${divergences.length}`);
  console.log(`  skipped (PO received)    : ${needsManual.length}`);
  if (needsManual.length > 0) {
    console.log(`\n  ⚠️  needs_manual (PO has received units — review by hand):`);
    for (const p of needsManual)
      console.log(
        `     ${p.it_number ?? p.transfer_id} ↔ ${p.po_number ?? p.po_id} (received=${p.po_received})`
      );
  }
  console.log(
    `\n${APPLY ? "✅ APPLY complete." : "ℹ️  DRY-RUN only — re-run with APPLY=true to write."}\n`
  );
}
