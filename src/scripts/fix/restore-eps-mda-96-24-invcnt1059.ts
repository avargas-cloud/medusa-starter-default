/**
 * src/scripts/fix/restore-eps-mda-96-24-invcnt1059.ts
 *
 * Remediation for INVCNT-1059: line EPS-MDA-96-24 was counted while 24 units
 * were on the "apartados" (reserved) shelf and were NOT counted. Those 24 units
 * got invoiced between count and approval, so the delta-invariant approve applied
 * a stale delta of -24 on top of the already-depleted live stock (0) -> Miami = -24.
 *
 * True physical Miami stock = 1 (operator confirmed). This adjusts Miami stock
 * to the correct value via the inventory module (raw_ + Meili trigger safe) and
 * annotates the count line so the audit trail reflects the manual override.
 *
 * QuickBooks side (adjustment 1C90B7-1783004606 posted the erroneous -24) is
 * handled separately.
 */

import { Modules } from "@medusajs/utils";
import type { ExecArgs } from "@medusajs/framework/types";

const INVENTORY_ITEM_ID = "iitem_01KFS1HFDZ8WP1N3GE9P6JJ3G7";
const MIAMI_LOCATION_ID = "sloc_01KFS2AV3TAKR141KC2D6JCGTR";
const LINE_ID = "invcnl_01KWEXBR1QAMH7WG4W47XB6BDQ";
const TARGET_STOCK = 1;

export default async function run({ container }: ExecArgs) {
  const inventory = container.resolve(Modules.INVENTORY);
  const knex = container.resolve("__pg_connection__");

  const levels = await inventory.listInventoryLevels(
    { inventory_item_id: INVENTORY_ITEM_ID, location_id: MIAMI_LOCATION_ID },
    { take: 1 }
  );
  const current = levels[0]?.stocked_quantity ?? 0;
  const adjustment = TARGET_STOCK - current;

  console.log(`[restore] EPS-MDA-96-24 Miami current=${current} target=${TARGET_STOCK} adjustment=${adjustment}`);

  if (adjustment === 0) {
    console.log("[restore] already at target, nothing to do");
  } else {
    await inventory.adjustInventory(INVENTORY_ITEM_ID, MIAMI_LOCATION_ID, adjustment);
    console.log("[restore] adjustInventory applied");
  }

  // Audit: annotate the count line as an operator override, clear the negative flag.
  await knex("inventory_count_line")
    .where({ id: LINE_ID })
    .update({
      status: "overridden",
      resulted_negative: false,
      override_note:
        "Manual restore: counted 1 while 24 units were on the reserved (apartados) shelf and later invoiced; " +
        "stale -24 delta drove Miami to -24. Physical = 1. Miami stock restored to 1. QB adj 1C90B7-1783004606 needs +24 compensation.",
      updated_at: knex.fn.now(),
    });
  console.log("[restore] count line annotated as overridden");

  // Verify
  const after = await inventory.listInventoryLevels(
    { inventory_item_id: INVENTORY_ITEM_ID, location_id: MIAMI_LOCATION_ID },
    { take: 1 }
  );
  const row = await knex("inventory_level")
    .where({ inventory_item_id: INVENTORY_ITEM_ID, location_id: MIAMI_LOCATION_ID })
    .first("stocked_quantity", "raw_stocked_quantity");
  console.log(
    `[restore] VERIFY Miami stocked=${after[0]?.stocked_quantity} raw=${JSON.stringify(row?.raw_stocked_quantity)}`
  );
}
