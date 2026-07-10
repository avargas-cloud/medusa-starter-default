/**
 * Release stale reservations on a COMPLETED order.
 *
 * Root-cause family: complete-pickup / completeOrderWorkflow paths don't
 * release reservations that were (re)created after invoicing (POS edit-save,
 * void-reopen remediation, etc.). A completed order must not hold stock.
 *
 * Guards:
 *  - order.status must be 'completed'
 *  - only releases reservations whose line (CURRENT order version) is fully
 *    fulfilled (fulfilled_quantity >= quantity) — anything else is skipped
 *    and reported.
 *
 * Deletes via the inventory module so inventory_level.reserved_quantity is
 * decremented and the Meili PG trigger fires (never raw SQL).
 *
 * Usage:
 *   npx medusa exec ./src/scripts/fix/release-completed-order-stale-reservations.ts <display_id> [apply]
 *
 * Dry-run by default; pass the word `apply` to actually delete (a --flag
 * would be swallowed by the medusa CLI parser).
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

export default async function releaseCompletedOrderStaleReservations({
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
    `SELECT id, display_id, status, version
       FROM "order" WHERE display_id = ? AND deleted_at IS NULL`,
    [Number(displayIdArg)]
  );
  const order = orderRows?.[0];
  if (!order) {
    console.error(`Order #${displayIdArg} not found`);
    return;
  }
  if (order.status !== "completed") {
    console.error(
      `Order #${displayIdArg} status=${order.status} (not completed) — refusing`
    );
    return;
  }

  // Current-version lines with their fulfillment state
  const { rows: lineRows } = await pg.raw(
    `SELECT oli.id, oi.quantity, oi.fulfilled_quantity
       FROM order_line_item oli
       JOIN order_item oi ON oi.item_id = oli.id AND oi.deleted_at IS NULL
      WHERE oi.order_id = ? AND oi.version = ? AND oli.deleted_at IS NULL`,
    [order.id, order.version]
  );
  const fullyFulfilled = new Set<string>(
    lineRows
      .filter((r: any) => Number(r.fulfilled_quantity) >= Number(r.quantity))
      .map((r: any) => r.id)
  );
  const allLineIds: string[] = lineRows.map((r: any) => r.id);

  const reservations = await inventoryModule.listReservationItems({
    line_item_id: allLineIds,
  });
  if (!reservations?.length) {
    console.log(`Order #${displayIdArg}: no open reservations — nothing to do`);
    return;
  }

  const releasable = reservations.filter((r: any) =>
    fullyFulfilled.has(r.line_item_id)
  );
  const skipped = reservations.filter(
    (r: any) => !fullyFulfilled.has(r.line_item_id)
  );

  for (const r of releasable) {
    console.log(
      `  RELEASE ${r.id} line_item=${r.line_item_id} qty=${r.quantity} inv_item=${r.inventory_item_id}`
    );
  }
  for (const r of skipped) {
    console.log(
      `  SKIP (line not fully fulfilled) ${r.id} line_item=${r.line_item_id} qty=${r.quantity}`
    );
  }

  if (!releasable.length) {
    console.log("Nothing releasable — all reservations skipped");
    return;
  }

  if (!apply) {
    console.log(
      `DRY RUN — would release ${releasable.length} reservation(s) for order #${displayIdArg} (${skipped.length} skipped). Re-run with \`apply\`.`
    );
    return;
  }

  await inventoryModule.deleteReservationItems(
    releasable.map((r: any) => r.id)
  );
  console.log(
    `✅ Released ${releasable.length} reservation(s) for order #${displayIdArg} (${skipped.length} skipped)`
  );
}
