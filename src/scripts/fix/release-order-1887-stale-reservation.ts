/**
 * One-off: release the stale reservation on order #1887 (completed via pickup).
 *
 * Root cause: order was fully invoiced Jun 3-4 with 6u of SUP-FC2R4N70W0860
 * pickup-pending; a POS edit-save on Jun 23 recreated the backorder reservation
 * for the unfulfilled remainder; the Mark-as-Picked-Up completion on Jun 26
 * fulfilled/delivered everything but never released that reservation.
 *
 * Deletes via the inventory module so inventory_level.reserved_quantity is
 * decremented and the Meili PG trigger fires (never raw SQL).
 *
 * Usage:
 *   npx medusa exec ./src/scripts/fix/release-order-1887-stale-reservation.ts [apply]
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

const RESERVATION_ID = "resitem_01KVTDAFF3YQ2H321ZAYS90JGJ";
const EXPECTED_LINE_ITEM = "ordli_01KT70Z29RTG2Y157K35WJ2CNH";
const EXPECTED_ORDER_ID = "order_01KS316CNW5C7A7M5NXQV1DGX2";

export default async function releaseOrder1887StaleReservation({
  container,
  args,
}: ExecArgs) {
  const apply = (args || []).includes("apply");

  const pg = container.resolve("__pg_connection__") as any;
  const inventoryModule = container.resolve(Modules.INVENTORY) as any;

  const [reservation] = await inventoryModule.listReservationItems({
    id: [RESERVATION_ID],
  });
  if (!reservation) {
    console.log(`${RESERVATION_ID} not found (already released?) — nothing to do`);
    return;
  }
  if (reservation.line_item_id !== EXPECTED_LINE_ITEM) {
    console.error(
      `Reservation line_item_id mismatch (${reservation.line_item_id}) — refusing`
    );
    return;
  }

  const { rows } = await pg.raw(
    `SELECT o.status, oi.quantity, oi.fulfilled_quantity, oi.delivered_quantity
       FROM "order" o
       JOIN order_item oi ON oi.order_id = o.id AND oi.version = o.version
      WHERE o.id = ? AND oi.item_id = ? AND oi.deleted_at IS NULL`,
    [EXPECTED_ORDER_ID, EXPECTED_LINE_ITEM]
  );
  const line = rows?.[0];
  if (!line) {
    console.error("Order/line not found — refusing");
    return;
  }
  if (
    line.status !== "completed" ||
    Number(line.fulfilled_quantity) < Number(line.quantity)
  ) {
    console.error(
      `Order not completed+fully-fulfilled (status=${line.status}, fulfilled=${line.fulfilled_quantity}/${line.quantity}) — refusing`
    );
    return;
  }

  console.log(
    `Reservation ${RESERVATION_ID}: qty=${reservation.quantity} inv_item=${reservation.inventory_item_id}`
  );
  console.log(
    `Order #1887 status=${line.status}, line ${line.fulfilled_quantity}/${line.quantity} fulfilled, ${line.delivered_quantity} delivered`
  );

  if (!apply) {
    console.log("DRY RUN — re-run with `apply` to release.");
    return;
  }

  await inventoryModule.deleteReservationItems([RESERVATION_ID]);
  console.log(`✅ Released ${RESERVATION_ID} (6u SUP-FC2R4N70W0860, order #1887)`);
}
