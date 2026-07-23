import {
  archiveOrderWorkflow,
  cancelOrderWorkflow,
  completeOrderWorkflow,
} from "@medusajs/core-flows";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { Modules } from "@medusajs/utils";

import { reconcileOrderReservations } from "../../../../../lib/finance/reconcile-order-reservations";
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

/**
 * The pos_closed writes here go through orderService.updateOrders (module
 * level), which emits NO event — so the Meili `orders` doc (source of the
 * POS Open/Closed tabs) never re-indexed and a closed order haunted the
 * Open tab (S10885). Emitting order.updated reuses the full subscriber
 * machinery (fulfillment SQL fallback, fully_invoiced stamp). Every
 * listener of that event is an idempotent no-op for this transition.
 */
async function emitOrderUpdated(scope: any, orderId: string): Promise<void> {
  try {
    const eventBus = scope.resolve(Modules.EVENT_BUS) as any;
    await eventBus.emit({ name: "order.updated", data: { id: orderId } });
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} meili resync emit failed: ${err.message}`);
  }
}

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
 *   3. Invoiced but NOT fully paid/fulfilled → ARCHIVE natively (status=archived
 *      via the complete→archive workflow chain) + metadata.pos_closed = true;
 *      remaining reservations released; enqueues QB so_close.
 *      Reopenable (reopen re-holds with backorder).
 *
 * Reopen (metadata.pos_closed already true): if the order is `completed` or
 * `archived` it is reverted to `pending` (module update + raw SQL enforce);
 * otherwise the flag is cleared (legacy pos_flag rows). Reservations recreated
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
      const wasArchived = order.status === "archived";
      const newMeta = {
        ...meta,
        pos_closed: false,
        pos_closed_via: undefined,
        pos_reopened_at: new Date().toISOString(),
      };

      if (wasCompleted || wasArchived) {
        // completed|archived → pending. The module can silently no-op a
        // terminal-status downgrade (the completed→pending gotcha, see
        // utils/order-utils.ts) — so flip via the module first, then enforce
        // with raw SQL guarded to exactly the two states this route reopens.
        try {
          await orderService.updateOrders([
            { id: orderId, status: "pending", metadata: newMeta },
          ]);
        } catch (statusErr: any) {
          console.warn(
            `${LOG_PREFIX} module status downgrade rejected (${statusErr.message}) — metadata only, SQL enforce follows`
          );
          await orderService.updateOrders([{ id: orderId, metadata: newMeta }]);
        }
        await pg.raw(
          `UPDATE "order" SET status = 'pending'
            WHERE id = ? AND status IN ('completed', 'archived')`,
          [orderId]
        );
        console.log(
          `${LOG_PREFIX} ↩️ Order ${orderId} reopened (${order.status} → pending)`
        );
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

      await emitOrderUpdated(req.scope, orderId!);

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
      // A canceled order must not hold PAYMENT reservations either — release
      // order-only credit links back to the customer's available pool.
      try {
        await reconcileOrderReservations(req.scope, orderId!, {
          logger: { info: console.log, warn: console.warn },
        });
      } catch {
        /* non-fatal hygiene */
      }
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
      // order.canceled already reindexes, but it races our metadata tag above —
      // emit again so the final state (order_status=Voided) lands in Meili.
      await emitOrderUpdated(req.scope, orderId!);
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
      // Leftover PAYMENT reservations (order-only links beyond what the
      // invoices consumed) return to the customer's available pool too.
      try {
        await reconcileOrderReservations(req.scope, orderId!, {
          logger: { info: console.log, warn: console.warn },
        });
      } catch {
        /* non-fatal hygiene */
      }

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
      await emitOrderUpdated(req.scope, orderId!);
      return res.status(200).json({
        success: true,
        action: "completed",
        negative_stock_items: [],
        qb_skipped: qb.qbSkipped,
        qb_error: qb.qbError ?? null,
      });
    }

    // 3. Invoiced but not completable → ARCHIVE (reversible via Reopen).
    //    Remaining allocations are RELEASED so the stock is sellable while
    //    closed; reopen recreates them with backorder.
    //
    //    Medusa only archives completed/canceled/draft orders, so the native
    //    path is the two-workflow chain pending → completed → archived
    //    (completeOrder_ only blocks CANCELED). The transient `completed` is
    //    a stepping stone, never a resting state: if the archive leg fails we
    //    compensate back to `pending` — a completed-but-unfulfilled order is
    //    the exact phantom of the 2026-07-07 void bug (hides Mark as Picked
    //    Up, wrong Closed-tab semantics). On any chain failure the close
    //    still holds via metadata.pos_closed (legacy flag behavior).
    const newMeta = {
      ...meta,
      pos_closed: true,
      pos_closed_at: new Date().toISOString(),
      pos_closed_via: "archive",
    };
    await orderService.updateOrders([{ id: orderId, metadata: newMeta }]);

    await releaseAllReservations(inventoryModule, pg, items);

    let finalStatus = "pending";
    try {
      await completeOrderWorkflow(req.scope).run({
        input: { orderIds: [orderId!] },
      });
      try {
        await archiveOrderWorkflow(req.scope).run({
          input: { orderIds: [orderId!] },
        });
        finalStatus = "archived";
      } catch (archiveErr: any) {
        console.error(
          `${LOG_PREFIX} archive leg failed (${archiveErr.message}) — compensating completed → pending`
        );
        try {
          await orderService.updateOrders([
            { id: orderId, status: "pending" },
          ]);
        } catch {
          /* raw SQL below is the enforcement */
        }
        await pg.raw(
          `UPDATE "order" SET status = 'pending' WHERE id = ? AND status = 'completed'`,
          [orderId]
        );
      }
    } catch (completeErr: any) {
      console.error(
        `${LOG_PREFIX} complete leg failed (${completeErr.message}) — falling back to pos_flag-only close`
      );
    }

    const qb = await enqueueSoToggle({
      orderId: orderId!,
      meta: newMeta,
      action: "close",
    });

    console.log(
      `${LOG_PREFIX} 📦 Order ${orderId} closed → status=${finalStatus} (not completable: ${completeResult.reason})`
    );
    await emitOrderUpdated(req.scope, orderId!);
    return res.status(200).json({
      success: true,
      action: "closed",
      final_status: finalStatus,
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
