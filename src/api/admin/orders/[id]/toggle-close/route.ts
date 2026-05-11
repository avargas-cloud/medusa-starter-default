import { createReservationsWorkflow } from "@medusajs/core-flows";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { Modules } from "@medusajs/utils";

// 1.5.5: closeSalesOrderInQb/reopenSalesOrderInQb imports removed —
// route now enqueues 'pending' rows; consolidator submits to bridge.
import {
  writePipelineRow,
  findLastInFlightSoToggleRow,
} from "../../../../../lib/quickbooks/qb-pipeline";

const LOG_PREFIX = "[toggle-close]";

/**
 * POST /admin/orders/:id/toggle-close
 *
 * Toggles a POS order between closed and open state.
 *
 * Close flow:
 *   1. Sets metadata.pos_closed = true + pos_closed_at timestamp
 *   2. Releases all existing reservations
 *   3. Recreates reservations (allow_backorder=true — negative stock is allowed)
 *   4. Writes a "so_close" pipeline row
 *   5. Calls closeSalesOrderInQb if a QB Sales Order TxnID exists
 *
 * Open (reopen) flow:
 *   1. Sets metadata.pos_closed = false + pos_reopened_at timestamp
 *   2. Releases and recreates reservations (allow_backorder=true)
 *   3. Writes a "so_reopen" pipeline row
 *   4. Calls reopenSalesOrderInQb if a QB Sales Order TxnID exists
 *
 * Returns:
 *   { success, action, negative_stock_items[], qb_skipped }
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { id: orderId } = req.params;

  try {
    const orderService = req.scope.resolve("order") as any;
    const inventoryModule = req.scope.resolve(Modules.INVENTORY) as any;
    const stockLocationModule = req.scope.resolve(
      Modules.STOCK_LOCATION
    ) as any;
    const remoteQuery = req.scope.resolve("remoteQuery") as any;
    const pg = req.scope.resolve("__pg_connection__") as any;

    // 1. Fetch order — we need metadata + items
    const orders = await orderService.listOrders(
      { id: orderId },
      { relations: ["items"] }
    );
    const order = orders[0];
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const meta = (order.metadata || {}) as Record<string, any>;
    const isCurrentlyClosed = meta.pos_closed === true;
    const action: "close" | "reopen" = isCurrentlyClosed ? "reopen" : "close";

    console.log(`${LOG_PREFIX} Order ${orderId}: action=${action}`);

    // 2. Update metadata flag
    const newMeta =
      action === "close"
        ? { ...meta, pos_closed: true, pos_closed_at: new Date().toISOString() }
        : {
            ...meta,
            pos_closed: false,
            pos_reopened_at: new Date().toISOString(),
          };

    await orderService.updateOrders([{ id: orderId, metadata: newMeta }]);
    console.log(
      `${LOG_PREFIX} ✅ Metadata updated — pos_closed=${newMeta.pos_closed}`
    );

    // 3. Resolve stock location
    let locationId: string | undefined;
    try {
      const locs = await stockLocationModule.listStockLocations(
        {},
        { take: 1, select: ["id"] }
      );
      locationId = locs?.[0]?.id;
    } catch {}

    if (!locationId) {
      console.warn(
        `${LOG_PREFIX} No stock location found — skipping reservation management`
      );
    }

    // 4. Release existing reservations
    const negativeStockItems: {
      sku: string;
      variant_id: string;
      available: number;
    }[] = [];

    if (locationId) {
      try {
        for (const item of order.items || []) {
          const existing = await inventoryModule.listReservationItems({
            line_item_id: item.id,
          });
          if (existing?.length) {
            await inventoryModule.deleteReservationItems(
              existing.map((r: any) => r.id)
            );
            console.log(
              `${LOG_PREFIX} 🗑️ Released ${existing.length} reservation(s) for item ${item.id}`
            );
          }
        }
      } catch (err: any) {
        console.warn(
          `${LOG_PREFIX} Failed to release reservations: ${err.message}`
        );
      }

      // 5. Recreate reservations with allow_backorder=true
      // Pre-fetch invoiced quantities for this order so we can skip items that
      // are already fully invoiced (guard against re-leaking reservations).
      const invoicedQtyMap = new Map<string, number>();
      try {
        const { rows: invRows } = await pg.raw(
          `SELECT pii.variant_id, COALESCE(SUM(pii.quantity), 0) AS invoiced_qty
           FROM pos_invoice_item pii
           JOIN pos_invoice pi ON pi.id = pii.invoice_id
           WHERE pi.order_id = ? AND pi.status != 'voided'
             AND pi.deleted_at IS NULL AND pii.deleted_at IS NULL
           GROUP BY pii.variant_id`,
          [orderId]
        );
        for (const row of invRows) {
          invoicedQtyMap.set(row.variant_id, Number(row.invoiced_qty));
        }
      } catch (mapErr: any) {
        console.warn(`${LOG_PREFIX} Could not fetch invoiced quantities: ${mapErr.message}`);
      }

      for (const item of order.items || []) {
        const variantId = item.variant_id;
        if (!variantId) continue;

        const fulfilledQty = Number(item.detail?.fulfilled_quantity || 0);
        const invoicedQty = invoicedQtyMap.get(variantId) ?? 0;
        const alreadyDone = Math.max(fulfilledQty, invoicedQty);
        const quantity = Math.max(0, Number(item.quantity) - alreadyDone);
        if (quantity === 0) {
          if (invoicedQty >= Number(item.quantity)) {
            console.log(
              `${LOG_PREFIX} Skipping reservation for ${variantId} — fully invoiced (${invoicedQty}/${item.quantity})`
            );
          }
          continue;
        }

        try {
          // Resolve inventory_item_id
          let inventoryItemId: string | undefined;
          try {
            const variantData = await remoteQuery({
              variant: {
                fields: ["id"],
                __args: { filters: { id: variantId } },
                inventory_items: { fields: ["inventory_item_id"] },
              },
            });
            inventoryItemId =
              variantData?.[0]?.inventory_items?.[0]?.inventory_item_id;
          } catch {}

          if (!inventoryItemId) continue;

          // Ensure allow_backorder=true
          try {
            const [invItem] = await inventoryModule.listInventoryItems(
              { id: inventoryItemId },
              { select: ["id", "allow_backorder"] }
            );
            if (invItem && !invItem.allow_backorder) {
              await inventoryModule.updateInventoryItems([
                { id: inventoryItemId, allow_backorder: true },
              ]);
            }
          } catch {}

          // Ensure inventory level exists at this location
          try {
            const levels = await inventoryModule.listInventoryLevels(
              { inventory_item_id: inventoryItemId, location_id: locationId },
              { select: ["id", "stocked_quantity", "reserved_quantity"] }
            );
            if (!levels?.length) {
              await inventoryModule.createInventoryLevels([
                {
                  inventory_item_id: inventoryItemId,
                  location_id: locationId,
                  stocked_quantity: 0,
                },
              ]);
            } else {
              // Check if this will go negative and report it
              const level = levels[0];
              const available =
                Number(level.stocked_quantity) -
                Number(level.reserved_quantity) -
                quantity;
              if (available < 0) {
                negativeStockItems.push({
                  sku: item.variant?.sku || variantId,
                  variant_id: variantId,
                  available,
                });
              }
            }
          } catch {}

          // Create reservation — allow_backorder forces it through even at 0 stock
          await createReservationsWorkflow(req.scope).run({
            input: {
              reservations: [
                {
                  inventory_item_id: inventoryItemId,
                  location_id: locationId,
                  quantity,
                  line_item_id: item.id,
                  allow_backorder: true,
                },
              ],
            },
          });
          console.log(
            `${LOG_PREFIX} ✅ Reserved ${quantity}× for variant ${variantId}`
          );
        } catch (err: any) {
          console.warn(
            `${LOG_PREFIX} Reservation failed for ${variantId}: ${err.message?.slice(0, 100)}`
          );
        }
      }
    }

    // 6. Write QB pipeline row
    const soTxnId: string | undefined =
      (meta.qb_sales_order as any)?.txn_id ||
      meta.qb_so_txn_id ||
      meta.qb_sales_order_txn_id;

    const soRefNumber: string | undefined =
      (meta.qb_sales_order as any)?.ref_number ||
      (meta.qb_so_ref_number as string | undefined);

    const medusaRefNumber = meta.document_number
      ? String(meta.document_number)
      : null;
    const pipelineStep = action === "close" ? "so_close" : "so_reopen";

    // Check for any in-flight so_close/so_reopen rows — if found, chain this one as
    // waiting so they execute sequentially and never race in QB
    let dependsOnRowId: string | null = null;
    let pipelineStatus: "pending" | "waiting" | "skipped" = soTxnId
      ? "pending"
      : "skipped";

    if (soTxnId) {
      try {
        dependsOnRowId = await findLastInFlightSoToggleRow(orderId!);
        if (dependsOnRowId) {
          pipelineStatus = "waiting";
          console.log(
            `${LOG_PREFIX} In-flight row detected (${dependsOnRowId}) — chaining as waiting`
          );
        }
      } catch (depErr: any) {
        console.warn(
          `${LOG_PREFIX} Could not check in-flight rows: ${depErr.message}`
        );
      }
    }

    try {
      await writePipelineRow({
        orderId,
        referenceId: orderId,
        referenceType: "order",
        step: pipelineStep,
        status: pipelineStatus,
        dependsOn: dependsOnRowId,
        qbTxnId: soTxnId ?? null,
        qbRefNumber: soRefNumber ?? null,
        medusaRefNumber,
      });
      console.log(
        `${LOG_PREFIX} ✅ Pipeline row written (step=${pipelineStep}, status=${pipelineStatus})`
      );
    } catch (pErr: any) {
      console.warn(
        `${LOG_PREFIX} Could not write pipeline row: ${pErr.message}`
      );
    }

    // 7. QB Sales Order sync (non-blocking — skipped when chained as waiting)
    let qbSkipped = false;
    let qbError: string | undefined;

    if (!soTxnId) {
      qbSkipped = true;
      console.log(`${LOG_PREFIX} No QB SO TxnID — skipping QB sync`);
    } else if (pipelineStatus === "waiting") {
      qbSkipped = true;
      console.log(
        `${LOG_PREFIX} Chained as waiting — QB sync deferred until dependency resolves`
      );
    } else {
      // 1.5.5: pipeline-only — enqueue 'pending' so_close / so_reopen row.
      // The earlier writePipelineRow above already wrote a 'pending' row with
      // depends_on; if soTxnId is known we can re-write as a non-dependent
      // 'pending' which the consolidator pending-dispatch will pick up.
      try {
        await writePipelineRow({
          orderId,
          referenceId: orderId,
          referenceType: "order",
          step: pipelineStep,
          status: "pending",
          qbTxnId: soTxnId,
          qbRefNumber: soRefNumber ?? null,
          medusaRefNumber,
        });
        console.log(
          `${LOG_PREFIX} 📥 Enqueued ${action} for SO ${soTxnId} (consolidator will submit)`
        );
      } catch (qbErr: any) {
        qbError = qbErr.message;
        console.warn(`${LOG_PREFIX} Enqueue exception: ${qbErr.message}`);
      }
    }

    return res.status(200).json({
      success: true,
      action,
      negative_stock_items: negativeStockItems,
      qb_skipped: qbSkipped,
      qb_error: qbError ?? null,
    });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} Fatal error:`, err.message);
    return res.status(500).json({ error: err.message });
  }
}
