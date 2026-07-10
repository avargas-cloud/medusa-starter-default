/**
 * ⛔ DEPRECATED 2026-07-10 — DO NOT RUN. Encodes the OLD policy ("a paid
 * invoice should have no reservations"), REVERSED by the apartado policy:
 * reservations now deliberately SURVIVE invoicing until the real fulfillment
 * (pickup/dispatch) consumes them. Running APPLY=1 would strip the apartado
 * from every invoiced-but-undispatched order.
 *
 * For genuinely stale reservations use instead:
 *   - scripts/fix/release-closed-order-reservations.ts (closed orders)
 *   - scripts/fix/release-completed-order-stale-reservations.ts (completed)
 *
 * Detail: memoria project_invoice_reservation_policy.md.
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

export default async function fixLeakedReservations({ container }: ExecArgs) {
  console.error(
    "⛔ DEPRECATED (2026-07-10): reservations now survive invoicing by design " +
      "(apartado policy). Running this would strip apartado from open orders. " +
      "Use release-closed-order-reservations.ts / " +
      "release-completed-order-stale-reservations.ts instead."
  );
  const DEPRECATED = true;
  if (DEPRECATED) return;

  const apply = process.env.APPLY === "1";
  const logger = container.resolve("logger");
  const pg = container.resolve("__pg_connection__") as any;
  const inventoryModule = container.resolve(Modules.INVENTORY) as any;

  logger.info(
    apply
      ? "APPLY — will delete leaked reservations"
      : "DRY-RUN — no changes will be made"
  );

  // Orders that have at least one paid invoice but NO active issued invoice —
  // these are effectively "done" orders that should have no reservations.
  const { rows: leakedRows } = await pg.raw(`
    SELECT
      o.display_id,
      o.id            AS order_id,
      oli.id          AS line_item_id,
      pv.sku,
      ri.id           AS reservation_id,
      ri.quantity
    FROM reservation_item ri
    JOIN order_line_item oli  ON oli.id = ri.line_item_id
    JOIN order_item      oi   ON oi.item_id = oli.id
    JOIN "order"         o    ON o.id = oi.order_id
    LEFT JOIN product_variant pv ON pv.id = oli.variant_id
    WHERE ri.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM pos_invoice pi
        WHERE pi.order_id = o.id
          AND pi.status = 'paid'
          AND pi.deleted_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM pos_invoice pi
        WHERE pi.order_id = o.id
          AND pi.status = 'issued'
          AND pi.deleted_at IS NULL
      )
    ORDER BY o.display_id, pv.sku
  `);

  // Deduplicate: the JOIN can fan-out one reservation_item into multiple rows
  const seen = new Set<string>();
  const uniqueRows = leakedRows.filter((r: any) => {
    if (seen.has(r.reservation_id)) return false;
    seen.add(r.reservation_id);
    return true;
  });

  if (uniqueRows.length === 0) {
    logger.info("No leaked reservations found. Nothing to do.");
    return;
  }

  logger.info(`Found ${uniqueRows.length} leaked reservation(s):`);
  for (const row of uniqueRows) {
    logger.info(
      `  Order #${row.display_id} | ${row.sku ?? "(no sku)"} | qty ${row.quantity} | ${row.reservation_id}`
    );
  }

  if (!apply) {
    logger.info("Dry-run complete. Re-run with APPLY=1 to delete.");
    return;
  }

  const reservationIds = uniqueRows.map((r: any) => r.reservation_id);
  await inventoryModule.deleteReservationItems(reservationIds);
  logger.info(`Deleted ${reservationIds.length} reservation(s).`);

  // Verify: count remaining active reservations on those orders
  const orderIds = [...new Set(leakedRows.map((r: any) => r.order_id))];
  const { rows: remaining } = await pg.raw(
    `SELECT COUNT(*) AS cnt
     FROM reservation_item ri
     JOIN order_line_item oli ON oli.id = ri.line_item_id
     JOIN order_item oi ON oi.item_id = oli.id
     WHERE ri.deleted_at IS NULL
       AND oi.order_id = ANY(?::text[])`,
    [orderIds]
  );
  const remaining_count = Number(remaining[0]?.cnt ?? 0);
  logger.info(
    remaining_count === 0
      ? "Verified: 0 active reservations remain on those orders."
      : `WARNING: ${remaining_count} reservation(s) still active on those orders — investigate.`
  );
}
