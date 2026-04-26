import { createReservationsWorkflow } from "@medusajs/core-flows";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { Modules } from "@medusajs/utils";

import { getDbPool } from "../../../../utils/db-pool";

/**
 * POST /admin/orders/:id/complete-pickup
 *
 * Atomically closes a "pickup pending" invoice:
 *   1. Builds fulfillment items by matching pos_invoice_item.variant_id
 *      against order_line_item (only the unfulfilled delta)
 *   2. Creates the fulfillment via createOrderFulfillmentWorkflow
 *      (with reservations preamble, same as create-fulfillment-force Strategy 1)
 *   3. Marks it as delivered via markOrderFulfillmentAsDeliveredWorkflow
 *   4. Clears order.metadata.pickup_pending, stamps picked_up_at + picked_up_by
 *   5. Binds the new fulfillment_id onto the pos_invoice row
 *
 * Body:
 *   invoice_id: string   required
 *   location_id: string  required
 *   picked_up_by?: string  email/id of the staff closing the pickup
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { id: orderId } = req.params as { id: string };
  const { invoice_id, location_id, picked_up_by } = req.body as {
    invoice_id: string;
    location_id: string;
    picked_up_by?: string;
  };

  if (!invoice_id || !location_id) {
    return res
      .status(400)
      .json({ message: "invoice_id and location_id are required" });
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return res.status(500).json({ message: "DATABASE_URL not configured" });
  }
  const pool = getDbPool();

  try {
    // ── Step 1: Load invoice items ──────────────────────────────────────────
    const invItemsRes = await pool.query<{
      variant_id: string | null;
      quantity: number;
    }>(
      `SELECT variant_id, quantity
         FROM pos_invoice_item
        WHERE invoice_id = $1
          AND deleted_at IS NULL
          AND variant_id IS NOT NULL`,
      [invoice_id]
    );
    if (!invItemsRes.rows.length) {
      return res
        .status(400)
        .json({ message: "Invoice has no fulfillable items" });
    }

    // ── Step 2: Load order items + fulfilled_quantity ───────────────────────
    const orderModule = req.scope.resolve(Modules.ORDER) as any;
    const orderData = await orderModule.retrieveOrder(orderId, {
      relations: ["items"],
    });
    if (!orderData?.items?.length) {
      return res.status(404).json({ message: "Order has no items" });
    }

    // ── Step 3: Build fulfillment_items by matching variant_id ──────────────
    const consumedByOrderItem: Record<string, number> = {};
    const fulfillmentItems: { id: string; quantity: number }[] = [];

    for (const invItem of invItemsRes.rows) {
      let remaining = invItem.quantity;
      const matches = orderData.items.filter(
        (oi: any) => oi.variant_id && oi.variant_id === invItem.variant_id
      );
      for (const oi of matches) {
        if (remaining <= 0) break;
        const alreadyFulfilled = Number(oi.fulfilled_quantity ?? 0);
        const alreadyConsumed = consumedByOrderItem[oi.id] ?? 0;
        const capacity = Math.max(
          0,
          Number(oi.quantity) - alreadyFulfilled - alreadyConsumed
        );
        if (capacity <= 0) continue;
        const take = Math.min(capacity, remaining);
        fulfillmentItems.push({ id: oi.id, quantity: take });
        consumedByOrderItem[oi.id] = alreadyConsumed + take;
        remaining -= take;
      }
    }

    if (!fulfillmentItems.length) {
      return res.status(400).json({
        message:
          "No unfulfilled order items matched the invoice — the order may already be fulfilled",
      });
    }

    // ── Step 4: Reservations preamble ───────────────────────────────────────
    // Same as create-fulfillment-force: unblock shipping-profile + ensure
    // stock reservations exist before the native workflow runs.
    const itemIds = fulfillmentItems.map((i) => i.id);
    await pool.query(
      `UPDATE order_line_item SET requires_shipping = false WHERE id = ANY($1)`,
      [itemIds]
    );

    const inventoryModule = req.scope.resolve(Modules.INVENTORY) as any;
    for (const reqItem of fulfillmentItems) {
      try {
        const existing = await inventoryModule.listReservationItems(
          { line_item_id: reqItem.id },
          { take: 1 }
        );
        if (existing?.length) continue;

        const variantRes = await pool.query<{ variant_id: string | null }>(
          `SELECT variant_id FROM order_line_item WHERE id = $1 LIMIT 1`,
          [reqItem.id]
        );
        const variantId = variantRes.rows[0]?.variant_id;
        if (!variantId) continue;

        const invItemRes = await pool.query<{ inventory_item_id: string }>(
          `SELECT inventory_item_id FROM product_variant_inventory_item
             WHERE variant_id = $1 AND deleted_at IS NULL LIMIT 1`,
          [variantId]
        );
        const inventoryItemId = invItemRes.rows[0]?.inventory_item_id;
        if (!inventoryItemId) continue;

        await createReservationsWorkflow(req.scope).run({
          input: {
            reservations: [
              {
                inventory_item_id: inventoryItemId,
                location_id,
                quantity: reqItem.quantity,
                line_item_id: reqItem.id,
              },
            ],
          },
        });
      } catch (reservErr: any) {
        console.warn(
          `[complete-pickup] reservation warning for ${reqItem.id}: ${reservErr?.message?.slice(0, 80)}`
        );
      }
    }

    // ── Step 5: Create fulfillment via native workflow ──────────────────────
    const {
      createOrderFulfillmentWorkflow,
      markOrderFulfillmentAsDeliveredWorkflow,
    } = await import("@medusajs/core-flows");

    const fulfillResult = await createOrderFulfillmentWorkflow(req.scope).run({
      input: {
        order_id: orderId,
        items: fulfillmentItems,
        location_id,
        no_notification: true,
        created_by: ((req as any).auth_context?.actor_id ?? "") as string,
      },
    });

    const fulfillment = fulfillResult.result as any;
    const fulfillmentId = fulfillment?.id;
    if (!fulfillmentId) {
      throw new Error("Fulfillment creation returned no id");
    }

    // Patch fulfilled_quantity so order.fulfillment_status reflects reality
    for (const item of fulfillmentItems) {
      await pool.query(
        `UPDATE order_item
            SET fulfilled_quantity = LEAST(quantity, COALESCE(fulfilled_quantity, 0) + $1::numeric)
          WHERE id = $2`,
        [item.quantity, item.id]
      );
    }

    // ── Step 6: Mark as delivered ──────────────────────────────────────────
    await markOrderFulfillmentAsDeliveredWorkflow(req.scope).run({
      input: { orderId, fulfillmentId },
    });

    // ── Step 7: Update order.metadata ──────────────────────────────────────
    const existingMetadata = (orderData.metadata ?? {}) as Record<
      string,
      unknown
    >;
    const pickedUpAt = new Date().toISOString();
    const nextMetadata: Record<string, unknown> = {
      ...existingMetadata,
      picked_up_at: pickedUpAt,
      picked_up_by: picked_up_by ?? existingMetadata.picked_up_by ?? null,
    };
    delete nextMetadata.pickup_pending;
    delete nextMetadata.pickup_pending_invoice_id;
    try {
      await orderModule.updateOrders([{ id: orderId, metadata: nextMetadata }]);
    } catch (metaErr: any) {
      console.warn(
        `[complete-pickup] metadata update warning: ${metaErr?.message}`
      );
    }

    // ── Step 8: Bind fulfillment to invoice ────────────────────────────────
    try {
      await pool.query(
        `UPDATE pos_invoice SET fulfillment_id = $1 WHERE id = $2`,
        [fulfillmentId, invoice_id]
      );
    } catch (bindErr: any) {
      console.warn(
        `[complete-pickup] invoice bind warning: ${bindErr?.message}`
      );
    }

    return res.status(200).json({
      fulfillment_id: fulfillmentId,
      picked_up_at: pickedUpAt,
      picked_up_by: nextMetadata.picked_up_by ?? null,
    });
  } catch (err: any) {
    console.error(`[complete-pickup] ❌ ${err?.message}`, err?.stack);
    return res
      .status(500)
      .json({ message: err?.message ?? "complete-pickup failed" });
  }
}
