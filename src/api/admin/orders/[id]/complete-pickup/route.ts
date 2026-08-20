import { createReservationsWorkflow } from "@medusajs/core-flows";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { Modules } from "@medusajs/utils";

import { getDbPool } from "../../../../utils/db-pool";
import { maybeCompleteOrder } from "../../../../../lib/maybe-complete-order";
import { clearDeliveredSeparations } from "../../../../../lib/separation/clear-delivered-separations";
import { syncInventoryItemToMeiliSearchWorkflow } from "../../../../../workflows/sync-inventory-item-meilisearch";
import { consumeReservationsForFulfillment } from "../_lib/consume-reservations-for-fulfillment";

/**
 * Auto-complete the order natively in Medusa once it is fully fulfilled +
 * fully paid, then ALWAYS reindex. Delegates the guarded completion to the
 * shared, idempotent, advisory-locked `maybeCompleteOrder` helper (single
 * source of truth — also used by the invoice route and the auto-complete
 * subscriber). For pickup orders the invoice is created BEFORE the fulfillment
 * exists, so the fulfillment only lands here, on "Mark as Picked Up" — this is
 * the moment to (re)attempt the close. Non-fatal by design.
 */
async function tryCompleteOrder(
  scope: MedusaRequest["scope"],
  orderId: string
): Promise<void> {
  // The goods just walked out, so any line now fully out of the building has
  // no business still claiming shelf stock — a stale separation shrinks the
  // `separable_cap` of every OTHER order wanting that SKU. Idempotent (sets to
  // zero, never subtracts), non-fatal, and deliberately after the COMMIT that
  // recorded the pickup: tidying a mark must never be able to undo the handover.
  await clearDeliveredSeparations(getDbPool(), orderId);

  try {
    await maybeCompleteOrder(scope, orderId);
  } catch (completeErr: any) {
    // maybeCompleteOrder never throws, but stay non-fatal regardless — order
    // stays pending and the auto-complete subscriber retries on a later edge.
    console.warn(
      `[complete-pickup] auto-complete skipped: ${completeErr?.message?.slice(0, 120)}`
    );
  }

  // ALWAYS emit pos.order.fulfilled so the order-meilisearch-sync subscriber
  // reindexes the order — this is how "Mark as Picked Up" moves the order out of
  // the Open tab IMMEDIATELY. Fires whether or not native completion happened
  // (the delivery itself changed fulfillment state) and whether markDelivered
  // used the native workflow OR the SQL fallback (the fallback emits no
  // delivery.created event, so without this the Meili doc stays stale).
  // purchasing-snapshot-on-event also listens to this — both are idempotent.
  try {
    const eventBus = scope.resolve(Modules.EVENT_BUS);
    await eventBus.emit({ name: "pos.order.fulfilled", data: { id: orderId } });
  } catch {
    /* non-fatal */
  }
}

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
  const lockClient = await pool.connect();

  try {
    await lockClient.query("BEGIN");
    await lockClient.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `complete-pickup:${invoice_id}`,
    ]);

    const markDeliveredWithFallback = async (
      fulfillmentId: string,
      deliveredAt: string
    ) => {
      const { markOrderFulfillmentAsDeliveredWorkflow } =
        await import("@medusajs/core-flows");
      try {
        await markOrderFulfillmentAsDeliveredWorkflow(req.scope).run({
          input: { orderId, fulfillmentId },
        });
      } catch (workflowErr: any) {
        console.warn(
          `[complete-pickup] mark delivered workflow refused (${workflowErr?.message?.slice(0, 100)}), using direct SQL fallback`
        );
        await pool.query(
          `UPDATE fulfillment
              SET delivered_at = COALESCE(delivered_at, $1::timestamptz),
                  updated_at = NOW()
            WHERE id = $2`,
          [deliveredAt, fulfillmentId]
        );
      }
    };

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
        // Self-heal an orphan: if the invoice-bound fulfillment lost its
        // order_fulfillment link (see Step 5.5), re-create it so the order shows
        // as fulfilled/delivered and leaves the Unfulfilled tab.
        try {
          const linkExists = await pool.query(
            `SELECT 1 FROM order_fulfillment
              WHERE order_id = $1 AND fulfillment_id = $2 AND deleted_at IS NULL
              LIMIT 1`,
            [orderId, existingFulId]
          );
          if (linkExists.rowCount === 0) {
            const { ulid } = await import("ulid");
            await pool.query(
              `INSERT INTO order_fulfillment (id, order_id, fulfillment_id, created_at, updated_at)
               VALUES ($1, $2, $3, NOW(), NOW())
               ON CONFLICT DO NOTHING`,
              [`ordful_${ulid()}`, orderId, existingFulId]
            );
            console.warn(
              `[complete-pickup] ensure-link (short-circuit): relinked orphan ${existingFulId} → order ${orderId}`
            );
          }
        } catch (linkErr: any) {
          console.warn(
            `[complete-pickup] ensure-link (short-circuit) failed (non-fatal): ${linkErr?.message}`
          );
        }

        if (!ful.delivered_at) {
          await markDeliveredWithFallback(
            existingFulId,
            new Date().toISOString()
          );
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
        // ⚠️ Medusa update* deep-merges JSONB → `delete` never persists (the key
        // re-hydrates from the stored value). Set false/null to actually clear,
        // otherwise the "Mark as Picked Up" button keeps showing.
        nextMetadata.pickup_pending = false;
        nextMetadata.pickup_pending_invoice_id = null;
        try {
          await orderModule.updateOrders([
            { id: orderId, metadata: nextMetadata },
          ]);
        } catch (metaErr: any) {
          console.warn(
            `[complete-pickup] metadata update warning: ${metaErr?.message}`
          );
        }

        await lockClient.query("COMMIT");
        await tryCompleteOrder(req.scope, orderId);
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
      await lockClient.query("COMMIT");
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
      await lockClient.query("COMMIT");
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

    // The order may already have a fulfillment for these invoice lines even
    // when Medusa's fulfilled quantities are stale. Reuse it instead of
    // creating a duplicate fulfillment that consumes stock a second time.
    const matchingFulfillmentRes = await pool.query<{
      fulfillment_id: string;
      delivered_at: Date | null;
    }>(
      `WITH inv_lines AS (
          SELECT variant_id, SUM(quantity)::numeric AS qty
            FROM pos_invoice_item
           WHERE invoice_id = $2
             AND deleted_at IS NULL
             AND variant_id IS NOT NULL
           GROUP BY variant_id
        ),
        ful_lines AS (
          SELECT f.id AS fulfillment_id,
                 f.created_at,
                 f.delivered_at,
                 oli.variant_id,
                 SUM(fi.quantity)::numeric AS qty
            FROM order_fulfillment ofu
            JOIN fulfillment f ON f.id = ofu.fulfillment_id
             AND f.deleted_at IS NULL
             AND f.canceled_at IS NULL
            JOIN fulfillment_item fi ON fi.fulfillment_id = f.id
             AND fi.deleted_at IS NULL
            JOIN order_line_item oli ON oli.id = fi.line_item_id
           WHERE ofu.order_id = $1
             AND ofu.deleted_at IS NULL
           GROUP BY f.id, f.created_at, f.delivered_at, oli.variant_id
        ),
        candidates AS (
          SELECT fl.fulfillment_id,
                 MAX(fl.created_at) AS created_at,
                 MAX(fl.delivered_at) AS delivered_at,
                 COUNT(*) FILTER (WHERE il.variant_id IS NULL) AS extra_lines
            FROM ful_lines fl
            LEFT JOIN inv_lines il ON il.variant_id = fl.variant_id
           GROUP BY fl.fulfillment_id
          HAVING NOT EXISTS (
            SELECT 1
              FROM inv_lines il
              LEFT JOIN ful_lines fl2 ON fl2.fulfillment_id = fl.fulfillment_id
               AND fl2.variant_id = il.variant_id
             WHERE COALESCE(fl2.qty, 0) < il.qty
          )
        )
        SELECT fulfillment_id, delivered_at
          FROM candidates
         ORDER BY extra_lines ASC, created_at ASC
         LIMIT 1`,
      [orderId, invoice_id]
    );
    const matchingFulfillment = matchingFulfillmentRes.rows[0];
    if (matchingFulfillment) {
      const pickedUpAt = new Date().toISOString();
      if (!matchingFulfillment.delivered_at) {
        await markDeliveredWithFallback(
          matchingFulfillment.fulfillment_id,
          pickedUpAt
        );
      }

      const existingMetadata = (orderData.metadata ?? {}) as Record<
        string,
        unknown
      >;
      const nextMetadata: Record<string, unknown> = {
        ...existingMetadata,
        picked_up_at: pickedUpAt,
        picked_up_by: picked_up_by ?? existingMetadata.picked_up_by ?? null,
      };
      // ⚠️ Medusa update* deep-merges JSONB → `delete` never persists; set
      // false/null to actually clear the pickup_pending flag.
      nextMetadata.pickup_pending = false;
      nextMetadata.pickup_pending_invoice_id = null;
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
        [matchingFulfillment.fulfillment_id, invoice_id]
      );

      await lockClient.query("COMMIT");
      await tryCompleteOrder(req.scope, orderId);
      return res.status(200).json({
        fulfillment_id: matchingFulfillment.fulfillment_id,
        picked_up_at: pickedUpAt,
        picked_up_by: nextMetadata.picked_up_by ?? null,
      });
    }

    if (!fulfillmentItems.length) {
      await lockClient.query("COMMIT");
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

    for (const reqItem of fulfillmentItems) {
      try {
        // RAW SQL — module { line_item_id } filter unreliable. CRITICAL: the
        // native fulfillment workflow decrements stock once PER reservation of
        // the line — legacy duplicates or wrong-location rows reaching it
        // double-decrement. Ensure EXACTLY ONE right-location reservation.
        const actives = await pool.query<{
          id: string;
          quantity: string;
          location_id: string;
        }>(
          `SELECT id, quantity, location_id FROM reservation_item
            WHERE line_item_id = $1 AND deleted_at IS NULL
            ORDER BY created_at ASC`,
          [reqItem.id]
        );
        let consolidationQty: number | undefined;
        if (
          actives.rows.length === 1 &&
          actives.rows[0]!.location_id === location_id
        ) {
          continue;
        }
        if (actives.rows.length > 0) {
          // Duplicates or wrong location → delete ALL before the native
          // workflow runs; if the recreate below fails, the fallback consume
          // handles the no-reservation case gracefully.
          const inventoryModuleForDedup = req.scope.resolve(
            Modules.INVENTORY
          ) as any;
          await inventoryModuleForDedup.deleteReservationItems(
            actives.rows.map((r) => r.id)
          );
          const oiRes = await pool.query<{ unfulfilled: string }>(
            `SELECT (oi.quantity - COALESCE(oi.fulfilled_quantity, 0))::numeric AS unfulfilled
               FROM order_item oi
               JOIN "order" o ON o.id = oi.order_id AND oi.version = o.version
              WHERE oi.item_id = $1 AND oi.deleted_at IS NULL
              LIMIT 1`,
            [reqItem.id]
          );
          consolidationQty = Math.max(
            Number(reqItem.quantity),
            Number(oiRes.rows[0]?.unfulfilled ?? 0)
          );
          console.log(
            `[complete-pickup] ♻️ consolidated ${actives.rows.length} stale reservation(s) for ${reqItem.id} → recreating ${consolidationQty}× @ ${location_id}`
          );
        }

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
                quantity: consolidationQty ?? reqItem.quantity,
                line_item_id: reqItem.id,
                allow_backorder: true,
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
    const { createOrderFulfillmentWorkflow } =
      await import("@medusajs/core-flows");

    let fulfillmentId: string | undefined;
    try {
      const fulfillResult = await createOrderFulfillmentWorkflow(req.scope).run(
        {
          input: {
            order_id: orderId,
            items: fulfillmentItems,
            location_id,
            no_notification: true,
            created_by: ((req as any).auth_context?.actor_id ?? "") as string,
          },
        }
      );
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
      const fallbackItems = await Promise.all(
        fulfillmentItems.map(async (reqItem) => {
          const orderItem = freshOrderData?.items?.find(
            (item: any) => item.id === reqItem.id
          );
          const sku = orderItem?.variant_sku ?? orderItem?.sku ?? null;
          // Resolve inventory_item_id so a later native ship (createOrderShipmentWorkflow)
          // can match the fulfillment item to its inventory item. Without it, managed
          // variants make Medusa throw a TypeError → 500 "An unknown error occurred"
          // when a pickup order is later given delivery tracking.
          let inventoryItemId: string | null = null;
          const variantId = orderItem?.variant_id ?? null;
          if (variantId) {
            const invRes = await pool.query<{ inventory_item_id: string }>(
              `SELECT inventory_item_id FROM product_variant_inventory_item
                 WHERE variant_id = $1 AND deleted_at IS NULL LIMIT 1`,
              [variantId]
            );
            inventoryItemId = invRes.rows[0]?.inventory_item_id ?? null;
          }
          return {
            title: orderItem?.title ?? "Item",
            sku,
            barcode: orderItem?.variant_barcode ?? sku ?? "",
            quantity: reqItem.quantity,
            line_item_id: reqItem.id,
            ...(inventoryItemId ? { inventory_item_id: inventoryItemId } : {}),
          };
        })
      );

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

      // The fallback bypasses the native workflow, so it must consume the
      // reservations + decrement stock itself (parity with
      // create-fulfillment-force Strategy 2; shared proportional helper).
      // Without this, the apartado reservation survives the pickup and the
      // stock never decrements.
      try {
        const inventoryModuleForConsume = req.scope.resolve(
          Modules.INVENTORY
        ) as any;
        const affectedInventoryItems = await consumeReservationsForFulfillment(
          {
            pool,
            inventoryModule: inventoryModuleForConsume,
            locationId: location_id,
            items: fulfillmentItems.map((reqItem) => ({
              line_item_id: reqItem.id,
              quantity: reqItem.quantity,
            })),
            logPrefix: "[complete-pickup:fallback]",
          }
        );
        if (affectedInventoryItems.length > 0) {
          await Promise.allSettled(
            affectedInventoryItems.map((inventoryItemId) =>
              syncInventoryItemToMeiliSearchWorkflow(req.scope).run({
                input: { inventoryItemId },
              })
            )
          );
        }
      } catch (consumeErr: any) {
        console.warn(
          `[complete-pickup] fallback inventory consume failed: ${consumeErr?.message?.slice(0, 120)}`
        );
      }
    }

    if (!fulfillmentId) {
      throw new Error("Fulfillment creation returned no id");
    }

    // ── Step 5.5: Guarantee the order↔fulfillment link exists ────────────────
    // A fulfillment can end up created + bound to the invoice but WITHOUT an
    // order_fulfillment row (native workflow link lost, or the fallback link
    // insert failed) → an ORPHAN delivered fulfillment. markDelivered-native
    // can't see it (so delivered_at lands via the SQL fallback) and the
    // /invoices Unfulfilled tab classifier — which reads order.fulfillments via
    // query.graph — never finds it, so the invoice is misread as unfulfilled
    // forever (e.g. S10688 / inv 20669). Idempotently ensure the link BEFORE
    // delivering/binding so no orphan is ever produced.
    try {
      const linkExists = await pool.query(
        `SELECT 1 FROM order_fulfillment
          WHERE order_id = $1 AND fulfillment_id = $2 AND deleted_at IS NULL
          LIMIT 1`,
        [orderId, fulfillmentId]
      );
      if (linkExists.rowCount === 0) {
        const { ulid } = await import("ulid");
        await pool.query(
          `INSERT INTO order_fulfillment (id, order_id, fulfillment_id, created_at, updated_at)
           VALUES ($1, $2, $3, NOW(), NOW())
           ON CONFLICT DO NOTHING`,
          [`ordful_${ulid()}`, orderId, fulfillmentId]
        );
        console.warn(
          `[complete-pickup] ensure-link: inserted missing order_fulfillment for ${fulfillmentId} → order ${orderId}`
        );
      }
    } catch (linkErr: any) {
      console.warn(
        `[complete-pickup] ensure-link safety net failed (non-fatal): ${linkErr?.message}`
      );
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
    const pickedUpAt = new Date().toISOString();
    await markDeliveredWithFallback(fulfillmentId, pickedUpAt);

    // ── Step 7: Update order.metadata ──────────────────────────────────────
    const existingMetadata = (orderData.metadata ?? {}) as Record<
      string,
      unknown
    >;
    const nextMetadata: Record<string, unknown> = {
      ...existingMetadata,
      picked_up_at: pickedUpAt,
      picked_up_by: picked_up_by ?? existingMetadata.picked_up_by ?? null,
    };
    // ⚠️ Medusa update* deep-merges JSONB → `delete` never persists; set
    // false/null to actually clear the pickup_pending flag.
    nextMetadata.pickup_pending = false;
    nextMetadata.pickup_pending_invoice_id = null;
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

    await lockClient.query("COMMIT");
    await tryCompleteOrder(req.scope, orderId);
    return res.status(200).json({
      fulfillment_id: fulfillmentId,
      picked_up_at: pickedUpAt,
      picked_up_by: nextMetadata.picked_up_by ?? null,
    });
  } catch (err: any) {
    try {
      await lockClient.query("ROLLBACK");
    } catch {
      /* lock cleanup best-effort */
    }
    console.error(`[complete-pickup] ❌ ${err?.message}`, err?.stack);
    return res
      .status(500)
      .json({ message: err?.message ?? "complete-pickup failed" });
  } finally {
    lockClient.release();
  }
}
