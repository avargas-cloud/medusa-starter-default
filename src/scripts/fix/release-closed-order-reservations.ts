/**
 * Release all open reservations of a POS-closed order.
 *
 * Companion to the toggle-close behavior change (pos_flag close now releases
 * remaining allocations instead of re-holding them): cleans up orders that
 * were closed BEFORE the change and still hold stock.
 *
 * Deletes via the inventory module so inventory_level.reserved_quantity is
 * decremented and the Meili PG trigger fires (never raw SQL).
 *
 * Usage:
 *   npx medusa exec ./src/scripts/fix/release-closed-order-reservations.ts <display_id> [apply]
 *
 * Dry-run by default; pass the word `apply` to actually delete (a --flag would
 * be swallowed by the medusa CLI parser).
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

export default async function releaseClosedOrderReservations({
  container,
  args,
}: ExecArgs) {
  const displayIdArg = (args || []).find((a) => /^\d+$/.test(a));
  const apply = (args || []).includes("apply");

  if (!displayIdArg) {
    console.error("Usage: medusa exec ... <display_id> [apply]");
    return;
  }

  const pg = container.resolve("__pg_connection__") as any;
  const inventoryModule = container.resolve(Modules.INVENTORY) as any;

  const { rows: orderRows } = await pg.raw(
    `SELECT id, display_id, status, metadata->>'pos_closed' AS pos_closed
       FROM "order" WHERE display_id = ? AND deleted_at IS NULL`,
    [Number(displayIdArg)]
  );
  const order = orderRows?.[0];
  if (!order) {
    console.error(`Order #${displayIdArg} not found`);
    return;
  }
  if (order.pos_closed !== "true") {
    console.error(
      `Order #${displayIdArg} is NOT pos_closed (pos_closed=${order.pos_closed}) — refusing to release`
    );
    return;
  }

  const { rows: lineRows } = await pg.raw(
    `SELECT DISTINCT oli.id
       FROM order_line_item oli
       JOIN order_item oi ON oi.item_id = oli.id AND oi.deleted_at IS NULL
      WHERE oi.order_id = ? AND oli.deleted_at IS NULL`,
    [order.id]
  );
  const lineItemIds: string[] = lineRows.map((r: any) => r.id);

  const reservations = await inventoryModule.listReservationItems({
    line_item_id: lineItemIds,
  });

  if (!reservations?.length) {
    console.log(`Order #${displayIdArg}: no open reservations — nothing to do`);
    return;
  }

  for (const r of reservations) {
    console.log(
      `  ${r.id} line_item=${r.line_item_id} qty=${r.quantity} inv_item=${r.inventory_item_id}`
    );
  }

  if (!apply) {
    console.log(
      `DRY RUN — would release ${reservations.length} reservation(s) for order #${displayIdArg}. Re-run with \`apply\`.`
    );
    return;
  }

  await inventoryModule.deleteReservationItems(
    reservations.map((r: any) => r.id)
  );
  console.log(
    `✅ Released ${reservations.length} reservation(s) for order #${displayIdArg} (status=${order.status})`
  );
}
