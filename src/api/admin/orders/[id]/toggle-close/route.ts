import { cancelOrderWorkflow } from "@medusajs/core-flows";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";

import { maybeCompleteOrder } from "../../../../../lib/maybe-complete-order";
import {
  getInventoryModules,
  resolveStockLocation,
  releaseAllReservations,
  recreateReservationsWithBackorder,
  type NegativeStockItem,
} from "./_lib/reservations";
import { enqueueSoToggle } from "./_lib/qb-so-toggle";

const LOG_PREFIX = "[toggle-close]";

/** Count of non-voided invoices for an order. */
async function countActiveInvoices(pg: any, orderId: string): Promise<number> {
  try {
    const { rows } = await pg.raw(
      `SELECT COUNT(*)::int AS n FROM pos_invoice
        WHERE order_id = ? AND status != 'voided' AND deleted_at IS NULL`,
      [orderId]
    );
    return Number(rows?.[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

/**
 * POST /admin/orders/:id/toggle-close
 *
 * Terminal close/reopen for a POS order. The "close" action resolves to one of
 * three outcomes based on the order's invoiced/paid/fulfilled state:
 *
 *   1. No active invoices → CANCEL natively (status=canceled). Releases
 *      reservations; the order.canceled event enqueues QB void_sales_order.
 *      Terminal — not reopenable.
 *   2. Invoiced AND fully paid + fulfilled → COMPLETE natively (status=completed).
 *      Releases leftover reservations of un-invoiced lines; enqueues QB so_close.
 *      Reopenable → status back to pending.
 *   3. Invoiced but NOT fully paid/fulfilled → POS-flag close (metadata.pos_closed
 *      = true), remaining reservations released; enqueues QB so_close.
 *      Reopenable via the flag (reopen re-holds with backorder).
 *
 * Reopen (metadata.pos_closed already true): if the order is `completed` it is
 * reverted to `pending`; otherwise the flag is cleared. Reservations recreated
 * and QB so_reopen enqueued.
 *
 * Returns: { success, action, negative_stock_items[], qb_skipped, qb_error,
 *            complete_blocked_reason? }
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { id: orderId } = req.params;

  try {
    const orderService = req.scope.resolve("order") as any;
    const remoteQuery = req.scope.resolve("remoteQuery") as any;
    const pg = req.scope.resolve("__pg_connection__") as any;
    const { inventoryModule, stockLocationModule } = getInventoryModules(
      req.scope
    );

    // Fetch order — need metadata + items + current status.
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
    const items = order.items || [];
    const locationId = await resolveStockLocation(stockLocationModule);
    if (!locationId) {
      console.warn(
        `${LOG_PREFIX} No stock location — reservation management skipped`
      );
    }

    // ─────────────────────────────────────────────────────────────────────
    // REOPEN
    // ─────────────────────────────────────────────────────────────────────
    if (isCurrentlyClosed) {
      const wasCompleted = order.status === "completed";
      const newMeta = {
        ...meta,
        pos_closed: false,
        pos_closed_via: undefined,
        pos_reopened_at: new Date().toISOString(),
      };

      if (wasCompleted) {
        // completed → pending (direct status flip; updateOrders status pattern is
        // used elsewhere e.g. revert-to-draft).
        await orderService.updateOrders([
          { id: orderId, status: "pending", metadata: newMeta },
        ]);
        console.log(`${LOG_PREFIX} ↩️ Order ${orderId} reopened (completed → pending)`);
      } else {
        await orderService.updateOrders([{ id: orderId, metadata: newMeta }]);
        console.log(`${LOG_PREFIX} ↩️ Order ${orderId} reopened (pos flag cleared)`);
      }

      let negativeStockItems: NegativeStockItem[] = [];
      if (locationId) {
        negativeStockItems = await recreateReservationsWithBackorder({
          scope: req.scope,
          inventoryModule,
          remoteQuery,
          knex: pg,
          locationId,
          orderId: orderId!,
          items,
        });
      }

      const qb = await enqueueSoToggle({
        orderId: orderId!,
        meta: newMeta,
        action: "reopen",
      });

      return res.status(200).json({
        success: true,
        action: "reopen",
        negative_stock_items: negativeStockItems,
        qb_skipped: qb.qbSkipped,
        qb_error: qb.qbError ?? null,
      });
    }

    // ─────────────────────────────────────────────────────────────────────
    // CLOSE — resolve to cancel / complete / pos-flag
    // ─────────────────────────────────────────────────────────────────────
    const activeInvoices = await countActiveInvoices(pg, orderId!);

    // 1. No invoices → CANCEL natively.
    if (activeInvoices === 0) {
      try {
        await cancelOrderWorkflow(req.scope).run({
          input: { order_id: orderId!, no_notification: true },
        });
      } catch (cancelErr: any) {
        console.error(
          `${LOG_PREFIX} cancelOrderWorkflow failed: ${cancelErr.message}`
        );
        return res.status(400).json({
          error: `Could not cancel order: ${cancelErr.message}`,
        });
      }

      // Best-effort: release any lingering reservations + tag order_status.
      await releaseAllReservations(inventoryModule, pg, items);
      try {
        await orderService.updateOrders([
          {
            id: orderId,
            metadata: {
              ...meta,
              order_status: "Voided",
              pos_canceled_at: new Date().toISOString(),
            },
          },
        ]);
      } catch (mErr: any) {
        console.warn(`${LOG_PREFIX} metadata tag failed: ${mErr.message}`);
      }

      console.log(`${LOG_PREFIX} 🚫 Order ${orderId} canceled (no invoices)`);
      // QB void_sales_order is enqueued by the order.canceled subscriber.
      return res.status(200).json({
        success: true,
        action: "canceled",
        negative_stock_items: [],
        qb_skipped: false,
        qb_error: null,
      });
    }

    // 2. Invoiced → try native COMPLETE (guards: fully paid + fulfilled).
    const completeResult = await maybeCompleteOrder(req.scope, orderId!);

    if (completeResult.completed) {
      // Order is done → release ALL leftover reservations (un-invoiced lines).
      await releaseAllReservations(inventoryModule, pg, items);

      // Mark closed so Reopen is available (status stays `completed`).
      const newMeta = {
        ...meta,
        pos_closed: true,
        pos_closed_at: new Date().toISOString(),
        pos_closed_via: "complete",
      };
      await orderService.updateOrders([{ id: orderId, metadata: newMeta }]);

      const qb = await enqueueSoToggle({
        orderId: orderId!,
        meta: newMeta,
        action: "close",
      });

      console.log(`${LOG_PREFIX} ✅ Order ${orderId} completed natively`);
      return res.status(200).json({
        success: true,
        action: "completed",
        negative_stock_items: [],
        qb_skipped: qb.qbSkipped,
        qb_error: qb.qbError ?? null,
      });
    }

    // 3. Invoiced but not completable → POS-flag close (reversible). Remaining
    //    allocations are RELEASED so the stock is sellable while closed; reopen
    //    recreates them with backorder.
    const newMeta = {
      ...meta,
      pos_closed: true,
      pos_closed_at: new Date().toISOString(),
      pos_closed_via: "pos_flag",
    };
    await orderService.updateOrders([{ id: orderId, metadata: newMeta }]);

    await releaseAllReservations(inventoryModule, pg, items);

    const qb = await enqueueSoToggle({
      orderId: orderId!,
      meta: newMeta,
      action: "close",
    });

    console.log(
      `${LOG_PREFIX} 📦 Order ${orderId} POS-closed, reservations released (not completable: ${completeResult.reason})`
    );
    return res.status(200).json({
      success: true,
      action: "closed",
      complete_blocked_reason: completeResult.reason,
      negative_stock_items: [],
      qb_skipped: qb.qbSkipped,
      qb_error: qb.qbError ?? null,
    });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} Fatal error:`, err.message);
    return res.status(500).json({ error: err.message });
  }
}
