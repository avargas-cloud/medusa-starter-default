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
    // ── Step 0: Short-circuit if the invoice already has a live fulfillment ─
    // Cobro/checkout often creates the fulfillment up-front, so by the time
    // the cashier clicks "Mark as Picked Up" the order is already fulfilled
    // (reservations consumed + soft-deleted). Re-running create-fulfillment
    // would crash with "No stock reservation found". Just mark delivered.
    const invoiceRow = await pool.query<{ fulfillment_id: string | null }>(
      `SELECT fulfillment_id FROM pos_invoice WHERE id = $1 LIMIT 1`,
      [invoice_id]
    );
    const existingFulId = invoiceRow.rows[0]?.fulfillment_id;
    if (existingFulId) {
      const fulRow = await pool.query<{
        canceled_at: Date | null;
        delivered_at: Date | null;
      }>(
        `SELECT canceled_at, delivered_at FROM fulfillment WHERE id = $1 LIMIT 1`,
        [existingFulId]
      );
      const ful = fulRow.rows[0];
      if (ful && !ful.canceled_at) {
        const { markOrderFulfillmentAsDeliveredWorkflow } =
          await import("@medusajs/core-flows");
        if (!ful.delivered_at) {
          await markOrderFulfillmentAsDeliveredWorkflow(req.scope).run({
            input: { orderId, fulfillmentId: existingFulId },
          });
        }

        const orderModule = req.scope.resolve(Modules.ORDER) as any;
        const orderData = await orderModule.retrieveOrder(orderId);
        const existingMetadata = (orderData?.metadata ?? {}) as Record<
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
          await orderModule.updateOrders([
            { id: orderId, metadata: nextMetadata },
          ]);
        } catch (metaErr: any) {
          console.warn(
            `[complete-pickup] metadata update warning: ${metaErr?.message}`
          );
        }

        return res.status(200).json({
          fulfillment_id: existingFulId,
          picked_up_at: pickedUpAt,
          picked_up_by: nextMetadata.picked_up_by ?? null,
        });
      }
    }

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
      const existingFulfillmentRes = await pool.query<{
        fulfillment_id: string;
        delivered_at: Date | null;
      }>(
        `SELECT f.id AS fulfillment_id, f.delivered_at
           FROM order_fulfillment ofu
           JOIN fulfillment f ON f.id = ofu.fulfillment_id
          WHERE ofu.order_id = $1
            AND ofu.deleted_at IS NULL
            AND f.deleted_at IS NULL
            AND f.canceled_at IS NULL
            AND EXISTS (
              SELECT 1
                FROM fulfillment_item fi
                JOIN pos_invoice_item pii ON pii.invoice_id = $2
                 AND pii.variant_id IS NOT NULL
                 AND pii.deleted_at IS NULL
                JOIN order_line_item oli ON oli.id = fi.line_item_id
                 AND oli.variant_id = pii.variant_id
               WHERE fi.fulfillment_id = f.id
                 AND fi.deleted_at IS NULL
            )
          ORDER BY f.delivered_at DESC NULLS LAST, f.created_at DESC
          LIMIT 1`,
        [orderId, invoice_id]
      );
      const existingFulfillment = existingFulfillmentRes.rows[0];
      if (!existingFulfillment) {
        return res.status(400).json({
          message:
            "No unfulfilled order items matched the invoice — the order may already be fulfilled",
        });
      }

      const { markOrderFulfillmentAsDeliveredWorkflow } =
        await import("@medusajs/core-flows");
      if (!existingFulfillment.delivered_at) {
        await markOrderFulfillmentAsDeliveredWorkflow(req.scope).run({
          input: { orderId, fulfillmentId: existingFulfillment.fulfillment_id },
        });
      }

      const pickedUpAt = new Date().toISOString();
      const existingMetadata = (orderData.metadata ?? {}) as Record<
        string,
        unknown
      >;
      const nextMetadata: Record<string, unknown> = {
        ...existingMetadata,
        picked_up_at: pickedUpAt,
        picked_up_by: picked_up_by ?? existingMetadata.picked_up_by ?? null,
      };
      delete nextMetadata.pickup_pending;
      delete nextMetadata.pickup_pending_invoice_id;
      try {
        await orderModule.updateOrders([
          { id: orderId, metadata: nextMetadata },
        ]);
      } catch (metaErr: any) {
        console.warn(
          `[complete-pickup] metadata update warning: ${metaErr?.message}`
        );
      }
      await pool.query(
        `UPDATE pos_invoice SET fulfillment_id = $1 WHERE id = $2`,
        [existingFulfillment.fulfillment_id, invoice_id]
      );

      return res.status(200).json({
        fulfillment_id: existingFulfillment.fulfillment_id,
        picked_up_at: pickedUpAt,
        picked_up_by: nextMetadata.picked_up_by ?? null,
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

    // ── Step 5: Create fulfillment ─────────────────────────────────────────
    const {
      createOrderFulfillmentWorkflow,
      markOrderFulfillmentAsDeliveredWorkflow,
    } = await import("@medusajs/core-flows");

    let fulfillmentId: string | undefined;
    try {
      const fulfillResult = await createOrderFulfillmentWorkflow(req.scope).run({
        input: {
          order_id: orderId,
          items: fulfillmentItems,
          location_id,
          no_notification: true,
          created_by: ((req as any).auth_context?.actor_id ?? "") as string,
        },
      });
      fulfillmentId = (fulfillResult.result as any)?.id;
    } catch (workflowErr: any) {
      console.warn(
        `[complete-pickup] native fulfillment failed (${workflowErr?.message?.slice(0, 120)}), using force fallback`
      );

      const fulfillmentModule = req.scope.resolve(Modules.FULFILLMENT) as any;
      const freshOrderData = await orderModule.retrieveOrder(orderId, {
        relations: ["items", "shipping_address", "shipping_methods"],
      });
      const shippingMethod = freshOrderData?.shipping_methods?.[0];
      const fallbackItems = fulfillmentItems.map((reqItem) => {
        const orderItem = freshOrderData?.items?.find(
          (item: any) => item.id === reqItem.id
        );
        const sku = orderItem?.variant_sku ?? orderItem?.sku ?? null;
        return {
          title: orderItem?.title ?? "Item",
          sku,
          barcode: orderItem?.variant_barcode ?? sku ?? "",
          quantity: reqItem.quantity,
          line_item_id: reqItem.id,
        };
      });

      const dbProviders: string[] = [];
      try {
        const rows = await fulfillmentModule.listFulfillmentProviders(
          {},
          { take: 20 }
        );
        dbProviders.push(
          ...(rows as any[]).map((provider: any) => provider.id).filter(Boolean)
        );
      } catch {
        /* non-fatal */
      }

      const optionProvider = shippingMethod?.shipping_option?.provider_id;
      const candidates = [
        ...new Set(
          [
            "store-pickup_store-pickup",
            "manual_manual",
            optionProvider,
            ...dbProviders,
          ].filter(Boolean)
        ),
      ] as string[];

      const deliveryAddress = freshOrderData?.shipping_address?.country_code
        ? (() => {
            const { id, created_at, updated_at, deleted_at, ...clean } =
              freshOrderData.shipping_address as any;
            return clean;
          })()
        : {
            address_1: "2760 W 84th St Unit 4",
            city: "Hialeah",
            province: "FL",
            postal_code: "33016",
            country_code: "us",
          };

      let fallbackFulfillment: any;
      for (const providerId of candidates) {
        try {
          fallbackFulfillment = await fulfillmentModule.createFulfillment({
            location_id,
            provider_id: providerId,
            shipping_option_id: shippingMethod?.shipping_option_id ?? null,
            items: fallbackItems,
            delivery_address: deliveryAddress,
            order: { id: orderId },
            data: {},
            labels: [],
          });
          break;
        } catch (providerErr: any) {
          console.warn(
            `[complete-pickup] fallback provider ${providerId} failed: ${providerErr?.message?.slice(0, 80)}`
          );
        }
      }

      if (!fallbackFulfillment) {
        fallbackFulfillment = await fulfillmentModule.createFulfillment({
          location_id,
          shipping_option_id: shippingMethod?.shipping_option_id ?? null,
          items: fallbackItems,
          delivery_address: deliveryAddress,
          order: { id: orderId },
          data: {},
          labels: [],
        });
      }

      let linkOk = false;
      try {
        await orderModule.registerFulfillment({
          order_id: orderId,
          reference: "fulfillment",
          reference_id: fallbackFulfillment.id,
          items: fulfillmentItems,
        });
        linkOk = true;
      } catch (regErr: any) {
        console.warn(
          `[complete-pickup] registerFulfillment failed (${regErr?.message?.slice(0, 100)}), inserting order_fulfillment link`
        );
        try {
          const { ulid } = await import("ulid");
          await pool.query(
            `INSERT INTO order_fulfillment (id, order_id, fulfillment_id, created_at, updated_at)
             VALUES ($1, $2, $3, NOW(), NOW())
             ON CONFLICT DO NOTHING`,
            [`ordful_${ulid()}`, orderId, fallbackFulfillment.id]
          );
          linkOk = true;
        } catch (linkErr: any) {
          console.error(
            `[complete-pickup] order_fulfillment link failed: ${linkErr?.message}`
          );
        }
      }

      if (!linkOk) {
        try {
          await fulfillmentModule.softDeleteFulfillments([
            fallbackFulfillment.id,
          ]);
        } catch {
          /* swallow */
        }
        throw new Error(
          `Fulfillment ${fallbackFulfillment.id} created but could not be linked to order ${orderId}`
        );
      }

      fulfillmentId = fallbackFulfillment.id;
    }

    if (!fulfillmentId) {
      throw new Error("Fulfillment creation returned no id");
    }

    // Patch fulfilled_quantity so order.fulfillment_status reflects reality.
    // order_item is a versioned junction; item_id (not id) is the line-item FK.
    for (const item of fulfillmentItems) {
      await pool.query(
        `UPDATE order_item
            SET fulfilled_quantity = LEAST(quantity, COALESCE(fulfilled_quantity, 0) + $1::numeric)
          WHERE item_id = $2 AND order_id = $3`,
        [item.quantity, item.id, orderId]
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
