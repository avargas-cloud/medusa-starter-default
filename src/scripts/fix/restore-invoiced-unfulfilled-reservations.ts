/**
 * Restore "apartado" (reservations) for orders that were invoiced but NOT yet
 * fulfilled, whose reservations were wrongly hard-released by the old Step 2B
 * of POST /admin/invoices (removed 2026-07-10 — invoicing no longer releases
 * reservations; only the real fulfillment consumes them).
 *
 * Selection (conservative, Codex-reviewed):
 *   - order.status = 'pending', not deleted, NOT pos_closed
 *   - order has >= 1 non-voided pos_invoice
 *   - line's variant appears in a non-voided invoice of that order
 *     (that's exactly what old Step 2B released — per invoiced VARIANT)
 *   - current order version lines only (oi.version = o.version)
 *   - target qty = order_item.quantity - fulfilled_quantity (> 0)
 *   - SKIP any line that already has an active reservation (report, no top-up)
 *   - SKIP + report lines with no variant→inventory_item link or no Miami level
 *
 * Creates via createReservationsWorkflow (allow_backorder=true) keyed by
 * order_line_item id, at the explicit Miami location (USA_LOC) — never
 * "first location". Meili freshness: PG trigger on reservation_item (~1min).
 *
 * Usage:
 *   npx medusa exec ./src/scripts/fix/restore-invoiced-unfulfilled-reservations.ts [apply]
 *
 * Dry-run by default; pass the word `apply` to create (a --flag would be
 * swallowed by the medusa CLI parser).
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { createReservationsWorkflow } from "@medusajs/core-flows";
import { USA_LOC } from "../../lib/locations";

interface CandidateLine {
  order_id: string;
  display_id: number;
  line_item_id: string;
  variant_id: string;
  variant_sku: string | null;
  quantity: string | number;
  fulfilled_quantity: string | number | null;
}

export default async function restoreInvoicedUnfulfilledReservations({
  container,
  args,
}: ExecArgs) {
  const apply = (args || []).includes("apply");
  const pg = container.resolve("__pg_connection__") as any;

  // Fail closed on the location — with Miami + China both live, never guess.
  const { rows: locRows } = await pg.raw(
    `SELECT id, name FROM stock_location WHERE id = ? AND deleted_at IS NULL`,
    [USA_LOC]
  );
  if (!locRows?.length) {
    console.error(`Miami location ${USA_LOC} not found — aborting`);
    return;
  }
  console.log(`Location: ${locRows[0].name} (${USA_LOC})`);
  console.log(apply ? "MODE: APPLY" : "MODE: DRY RUN (pass `apply` to write)");

  const { rows: candidates } = (await pg.raw(
    `SELECT o.id AS order_id, o.display_id, oli.id AS line_item_id,
            oli.variant_id, oli.variant_sku,
            oi.quantity, oi.fulfilled_quantity
       FROM "order" o
       JOIN order_item oi
         ON oi.order_id = o.id AND oi.deleted_at IS NULL AND oi.version = o.version
       JOIN order_line_item oli
         ON oli.id = oi.item_id AND oli.deleted_at IS NULL
      WHERE o.deleted_at IS NULL
        AND o.status = 'pending'
        AND COALESCE(o.metadata->>'pos_closed', 'false') <> 'true'
        AND oli.variant_id IS NOT NULL
        AND (oi.quantity - COALESCE(oi.fulfilled_quantity, 0)) > 0
        AND EXISTS (
              SELECT 1 FROM pos_invoice pi
               WHERE pi.order_id = o.id AND pi.status <> 'voided'
                 AND pi.deleted_at IS NULL)
        AND EXISTS (
              SELECT 1
                FROM pos_invoice pi2
                JOIN pos_invoice_item pii
                  ON pii.invoice_id = pi2.id AND pii.deleted_at IS NULL
               WHERE pi2.order_id = o.id AND pi2.status <> 'voided'
                 AND pi2.deleted_at IS NULL
                 AND pii.variant_id = oli.variant_id)
      ORDER BY o.display_id, oli.id`
  )) as { rows: CandidateLine[] };

  console.log(`Candidate lines: ${candidates.length}\n`);

  let created = 0;
  let skippedActiveRes = 0;
  let skippedNoLink = 0;
  let skippedNoLevel = 0;
  let failed = 0;
  const affectedInventoryItems = new Set<string>();

  for (const c of candidates) {
    const target =
      Math.max(0, Number(c.quantity) - Number(c.fulfilled_quantity || 0));
    if (target === 0) continue;
    const label = `#${c.display_id} ${c.variant_sku ?? c.variant_id} line=${c.line_item_id}`;

    // Raw SQL — inventoryModule.listReservationItems({ line_item_id }) is
    // documented unreliable in this codebase (see invoices/[id]/void).
    const { rows: resRows } = await pg.raw(
      `SELECT id, quantity FROM reservation_item
        WHERE line_item_id = ? AND deleted_at IS NULL`,
      [c.line_item_id]
    );
    if (resRows?.length) {
      skippedActiveRes++;
      console.log(
        `  SKIP (active reservation exists: ${resRows
          .map((r: any) => `${r.id}×${r.quantity}`)
          .join(", ")}) — ${label}`
      );
      continue;
    }

    const { rows: linkRows } = await pg.raw(
      `SELECT inventory_item_id FROM product_variant_inventory_item
        WHERE variant_id = ? AND deleted_at IS NULL LIMIT 1`,
      [c.variant_id]
    );
    const inventoryItemId = linkRows?.[0]?.inventory_item_id;
    if (!inventoryItemId) {
      skippedNoLink++;
      console.log(`  SKIP (no variant→inventory_item link) — ${label}`);
      continue;
    }

    const { rows: levelRows } = await pg.raw(
      `SELECT id FROM inventory_level
        WHERE inventory_item_id = ? AND location_id = ? AND deleted_at IS NULL`,
      [inventoryItemId, USA_LOC]
    );
    if (!levelRows?.length) {
      skippedNoLevel++;
      console.log(`  SKIP (no Miami inventory_level) — ${label}`);
      continue;
    }

    if (!apply) {
      created++;
      affectedInventoryItems.add(inventoryItemId);
      console.log(`  WOULD RESERVE ${target}× — ${label}`);
      continue;
    }

    try {
      await createReservationsWorkflow(container).run({
        input: {
          reservations: [
            {
              inventory_item_id: inventoryItemId,
              location_id: USA_LOC,
              quantity: target,
              line_item_id: c.line_item_id,
              allow_backorder: true,
              description: "restored: invoiced-unfulfilled apartado (fix 2026-07-10)",
            },
          ],
        },
      });
      created++;
      affectedInventoryItems.add(inventoryItemId);
      console.log(`  ✅ RESERVED ${target}× — ${label}`);
    } catch (err: any) {
      failed++;
      console.error(
        `  ❌ FAILED — ${label}: ${err?.message?.slice(0, 120)}`
      );
    }
  }

  console.log(`\n──── Summary ────`);
  console.log(
    `${apply ? "created" : "would create"}: ${created} · skipped(active res): ${skippedActiveRes} · skipped(no link): ${skippedNoLink} · skipped(no level): ${skippedNoLevel} · failed: ${failed}`
  );
  if (affectedInventoryItems.size) {
    console.log(
      `affected inventory_item_ids (Meili PG trigger will resync ~1min):\n  ${[...affectedInventoryItems].join("\n  ")}`
    );
  }
}
