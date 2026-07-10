import { createReservationsWorkflow } from "@medusajs/core-flows";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { Modules } from "@medusajs/utils";

import { USA_LOC } from "../../../../../lib/locations";
import { listActiveReservationsRaw } from "../../../../../lib/reservations";

/**
 * POST /admin/orders/:id/allocate-items
 *
 * Creates stock reservations for POS order items that don't have them.
 * Called at ORDER SAVE / EDIT time (and as safety net during invoice creation).
 *
 * Uses ONLY Medusa module APIs — NO raw pg.Pool (which competes with
 * Railway DB connection limits). All queries go through Medusa's shared ORM.
 *
 * Body:
 *   location_id?: string  — explicit override; if omitted, uses the Miami POS
 *   location (USA_LOC), fail-closed. Reservations succeed even at 0 stock
 *   (allow_backorder=true) — apartado policy.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { id: orderId } = req.params;
  let { location_id } = req.body as { location_id?: string };

  const base = `http://localhost:${process.env.PORT ?? 9000}`;
  const authHeaders = {
    Cookie: String(req.headers["cookie"] ?? ""),
    Authorization: String(req.headers["authorization"] ?? ""),
  };

  const results: {
    line_item_id: string;
    status: string;
    reservation_id?: string;
    reason?: string;
  }[] = [];

  try {
    const inventoryModule = req.scope.resolve(Modules.INVENTORY) as any;
    const remoteQuery = req.scope.resolve("remoteQuery") as any;

    // 1. Get location_id from request body, else the EXPLICIT Miami location.
    // Never "first row" — with Miami + China Warehouse both live, take:1 could
    // create the apartado in China depending on DB ordering. Fail closed.
    if (!location_id) {
      const stockLocationModule = req.scope.resolve(
        Modules.STOCK_LOCATION
      ) as any;
      const locs = await stockLocationModule.listStockLocations(
        { id: USA_LOC },
        { take: 1, select: ["id"] }
      );
      location_id = locs?.[0]?.id;
      if (!location_id) {
        console.warn(
          `[allocate-items] Miami location ${USA_LOC} not found — refusing to guess`
        );
        return res
          .status(200)
          .json({ allocated: [], message: "Miami stock location not found" });
      }
    }

    // 2. Get order items via Medusa admin API (internal HTTP — uses Medusa ORM, not new Pool)
    //    order.items[].id = order_line_item.id (correct line_item_id for reservations)
    const orderRes = await fetch(
      `${base}/admin/orders/${orderId}?fields=id,*items,*items.detail`,
      { headers: authHeaders }
    );
    if (!orderRes.ok) {
      return res
        .status(400)
        .json({ error: `Cannot fetch order: ${orderRes.status}` });
    }
    const { order } = await orderRes.json();
    const orderItems: any[] = order?.items ?? [];

    if (!orderItems.length) {
      return res.status(200).json({ allocated: [], message: "No items found" });
    }

    // 3. For each order item, look up inventory_item_id and create reservation.
    //    Per-item lookup so a single DB error doesn't silently skip other items.
    for (const item of orderItems) {
      const lineItemId = item.id; // order_line_item.id ✅
      const fulfilledQty = Number(item.detail?.fulfilled_quantity || 0);
      const quantity = Math.max(0, Number(item.quantity) - fulfilledQty);
      const variantId = item.variant_id;

      if (!variantId) {
        results.push({
          line_item_id: lineItemId,
          status: "skipped",
          reason: "no variant_id (custom item?)",
        });
        continue;
      }

      try {
        // Idempotent check by order_line_item.id — RAW SQL (the module's
        // { line_item_id } filter is unreliable in Medusa v2; a false-negative
        // here would mint a DUPLICATE reservation, and native fulfillment
        // decrements stock once per reservation) + LOCATION-AWARE (a
        // wrong-location reservation with the right qty must not pass as
        // "already allocated").
        const knex = req.scope.resolve("__pg_connection__") as any;
        const actives = await listActiveReservationsRaw(knex, lineItemId);

        if (quantity === 0) {
          if (actives.length) {
            await inventoryModule.deleteReservationItems(
              actives.map((r) => r.id)
            );
            results.push({
              line_item_id: lineItemId,
              status: "deleted_allocation",
              reservation_id: actives[0]?.id,
            });
            console.log(
              `[allocate-items] 🗑️ Deleted ${actives.length} reservation(s) (pending qty=0)`
            );
          }
          continue;
        }

        const misplaced = actives.some((r) => r.location_id !== location_id);
        const single = actives.length === 1 ? actives[0] : undefined;
        const needsConsolidation = actives.length > 1 || misplaced;

        if (!needsConsolidation && single) {
          if (single.quantity === quantity) {
            results.push({
              line_item_id: lineItemId,
              status: "already_allocated",
              reservation_id: single.id,
            });
            continue;
          }
          // Qty-only change on a healthy single reservation → update in place.
          // Needs only the reservation id — NOT gated behind the inventory
          // lookup (a lookup failure must not leave a stale qty).
          try {
            const {
              updateReservationsWorkflow,
            } = require("@medusajs/core-flows");
            if (updateReservationsWorkflow) {
              await updateReservationsWorkflow(req.scope).run({
                input: { updates: [{ id: single.id, quantity }] },
              });
            } else {
              // Module API takes an ARRAY of update objects.
              await inventoryModule.updateReservationItems([
                { id: single.id, quantity },
              ]);
            }
          } catch (e) {
            // Last-resort retry via the module API. If this ALSO fails, let it
            // throw to the per-line catch → status "error" (never report a
            // fake "updated_allocation" while the stale qty survives).
            await inventoryModule.updateReservationItems([
              { id: single.id, quantity },
            ]);
          }
          results.push({
            line_item_id: lineItemId,
            status: "updated_allocation",
            reservation_id: single.id,
          });
          console.log(
            `[allocate-items] 🔄 Updated reservation ${single.id}: ${single.quantity} -> ${quantity}×`
          );
          continue;
        }

        // From here: create a fresh reservation — either the line has none, or
        // it has duplicates/wrong-location ones to consolidate. CREATE FIRST,
        // delete stale ones only AFTER the replacement exists (never strip the
        // apartado and then fail to recreate it).

        // inventory_item_id: prefer the one already on the raw reservation
        // rows; fall back to remoteQuery per variant.
        let inventoryItemId: string | undefined =
          actives[0]?.inventory_item_id;
        if (!inventoryItemId) {
          try {
            const variantData = await remoteQuery({
              variant: {
                fields: ["id", "manage_inventory"],
                __args: { filters: { id: variantId } },
                inventory_items: { fields: ["inventory_item_id"] },
              },
            });
            inventoryItemId =
              variantData?.[0]?.inventory_items?.[0]?.inventory_item_id;
          } catch (qErr: any) {
            console.warn(
              `[allocate-items] remoteQuery lookup failed for variant ${variantId}: ${qErr.message?.slice(0, 80)}`
            );
          }
        }

        if (!inventoryItemId) {
          results.push({
            line_item_id: lineItemId,
            status: "skipped",
            reason: needsConsolidation
              ? "no inventory_item — stale reservations left in place"
              : "no inventory_item (unmanaged product)",
          });
          continue;
        }

        // Guard 1: Ensure allow_backorder=true (POS items must reserve regardless of stock).
        // Does NOT change stocked_quantity — only the backorder policy.
        try {
          const [invItem] = await inventoryModule.listInventoryItems(
            { id: inventoryItemId },
            { select: ["id", "allow_backorder"] }
          );
          if (invItem && !invItem.allow_backorder) {
            await inventoryModule.updateInventoryItems([
              { id: inventoryItemId, allow_backorder: true },
            ]);
            console.log(
              `[allocate-items] ✅ Enabled allow_backorder for ${inventoryItemId}`
            );
          }
        } catch (boErr: any) {
          console.warn(
            `[allocate-items] allow_backorder check failed: ${boErr.message?.slice(0, 80)}`
          );
        }

        // Guard 2: Ensure an inventory level exists at this location.
        // createReservationsWorkflow needs a level row to update reserved_quantity,
        // even when allow_backorder=true. Creates level (stocked_quantity=0) if missing.
        try {
          const levels = await inventoryModule.listInventoryLevels(
            { inventory_item_id: inventoryItemId, location_id },
            { select: ["id"] }
          );
          if (!levels?.length) {
            await inventoryModule.createInventoryLevels([
              {
                inventory_item_id: inventoryItemId,
                location_id,
                stocked_quantity: 0,
              },
            ]);
            console.log(
              `[allocate-items] ➕ Created inventory level (stock=0) for ${inventoryItemId} at ${location_id}`
            );
          }
        } catch (levelErr: any) {
          console.warn(
            `[allocate-items] Level check failed for ${inventoryItemId}: ${levelErr.message?.slice(0, 80)}`
          );
        }

        // Create reservation — succeeds even at 0 stock (allow_backorder=true + level exists)
        const { result } = await createReservationsWorkflow(req.scope).run({
          input: {
            reservations: [
              {
                inventory_item_id: inventoryItemId,
                location_id,
                quantity,
                line_item_id: lineItemId,
                allow_backorder: true, // Bypass 0 stock validation
              },
            ],
          },
        });
        const reservation = result?.[0];

        // Replacement exists — NOW retire the stale duplicates/wrong-location
        // rows. If this delete fails, the next allocate-items run consolidates
        // again (temporary over-reserve beats losing the apartado).
        if (needsConsolidation && actives.length) {
          try {
            await inventoryModule.deleteReservationItems(
              actives.map((r) => r.id)
            );
            console.log(
              `[allocate-items] ♻️ Consolidated ${actives.length} stale reservation(s) for ${lineItemId} → ${reservation?.id} @ ${location_id}`
            );
          } catch (delErr: any) {
            console.warn(
              `[allocate-items] stale reservation cleanup failed for ${lineItemId} (will re-consolidate next run): ${delErr?.message?.slice(0, 80)}`
            );
          }
        }

        results.push({
          line_item_id: lineItemId,
          status: needsConsolidation ? "reallocated" : "allocated",
          reservation_id: reservation?.id,
        });
        console.log(
          `[allocate-items] ✅ Reserved ${quantity}× variant=${variantId} → ${reservation?.id}`
        );
      } catch (err: any) {
        console.warn(
          `[allocate-items] Failed for ${lineItemId}: ${err?.message?.slice(0, 120)}`
        );
        results.push({
          line_item_id: lineItemId,
          status: "error",
          reason: err?.message?.slice(0, 120),
        });
      }
    }

    return res.status(200).json({ allocated: results });
  } catch (err: any) {
    console.error(`[allocate-items] Fatal: ${err?.message}`);
    return res.status(500).json({ error: err?.message });
  }
}
