import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { assertOrderEditable } from "../_lib/assert-order-editable";
import { assertWebOrderAuthorized } from "../_lib/assert-web-order-authorized";
import { getEstimateTxnId } from "../../../../../lib/quickbooks/qb-metadata-types";
import { writePipelineRow } from "../../../../../lib/quickbooks/qb-pipeline";
import { listActiveReservationsRaw } from "../../../../../lib/reservations";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { id } = req.params;
  const archivedBlock = await assertOrderEditable(req.scope, String(id));
  if (archivedBlock) {
    return res.status(409).json({ error: archivedBlock, code: "ORDER_ARCHIVED" });
  }

  // Una orden que vino de la WEB exige PIN de supervisor para editarse. El gate
  // vivia solo en la pantalla (useWebOrderLock) y comparaba en el navegador, asi
  // que un POST directo a esta ruta la editaba sin encontrar ninguna puerta.
  const webAuth = await assertWebOrderAuthorized(req.scope, String(id), req);
  if (webAuth.denial) {
    return res.status(webAuth.denial.status).json(webAuth.denial.body);
  }

  try {
    const orderService = req.scope.resolve("order");
    const inventoryModule = req.scope.resolve("inventory") as any;

    const pgConnection = req.scope.resolve("__pg_connection__") as any;

    // 1. Fetch the order
    const orders = await orderService.listOrders(
      { id },
      {
        relations: ["items"],
      }
    );
    const order = orders[0];

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Validate that there are no invoices generated for this order yet to safely revert it
    const invoiceCheck = await pgConnection.raw(
      `SELECT count(*) as count FROM pos_invoice WHERE order_id = ? AND status != 'voided'`,
      [order.id]
    );
    if (parseInt(invoiceCheck.rows[0].count, 10) > 0) {
      return res
        .status(400)
        .json({ error: "Cannot revert an order that has generated invoices" });
    }

    const meta = (order.metadata || {}) as Record<string, any>;
    const docNumber = (meta.document_number as string) || "";

    // QB SAFETY CHECK
    // If any pipeline row for this order is already in-flight (pending/submitted/confirmed),
    // the order has been sent to QuickBooks and cannot be safely reverted — close it instead.
    const qbCheck = await pgConnection.raw(
      `SELECT COUNT(*) AS count FROM qb_order_pipeline WHERE order_id = ? AND status IN ('pending', 'submitted', 'confirmed')`,
      [order.id]
    );
    const qbInFlight = parseInt(qbCheck.rows[0].count, 10) > 0;

    // SEQUENCE CHECK
    // Only allow reverting if this order holds the latest S-number.
    let isLastInSequence = true;
    if (docNumber.startsWith("S")) {
      const numericPart = parseInt(docNumber.replace(/\D/g, ""), 10);
      if (!isNaN(numericPart)) {
        const seqRes = await pgConnection.raw(
          `SELECT last_value FROM custom_order_seq`
        );
        const lastValue = parseInt(seqRes.rows[0].last_value, 10);
        isLastInSequence = lastValue === numericPart;
      }
    }

    if (qbInFlight || !isLastInSequence) {
      const reason = qbInFlight ? "qb_in_flight" : "not_last_in_sequence";
      // Close this order and tell the frontend to duplicate it as a new estimate.
      await orderService.updateOrders([
        {
          id: order.id,
          metadata: {
            ...meta,
            order_status: "Closed",
            closed_at: new Date().toISOString(),
            closed_reason: "converted_to_estimate",
          },
        },
      ]);

      // Free inventory reservations
      try {
        for (const item of order.items || []) {
          // RAW SQL read — module { line_item_id } filter is unreliable; a
          // miss here leaks a phantom reservation.
          const knexConn = req.scope.resolve("__pg_connection__") as any;
          const existingRes = await listActiveReservationsRaw(
            knexConn,
            item.id
          );
          if (existingRes.length > 0) {
            await inventoryModule.deleteReservationItems(
              existingRes.map((r) => r.id)
            );
          }
        }
      } catch (invErr) {
        console.warn(
          `[revert-to-draft] Failed to clear reservations for ${id}`,
          invErr
        );
      }

      console.log(
        `[revert-to-draft] ⚠️ Order ${id} (${docNumber}) closed — reason: ${reason}. Frontend will duplicate as estimate.`
      );
      return res.status(200).json({ action: "close_and_duplicate" });
    }

    // Safe to fully revert — recover the sequence gap
    if (docNumber.startsWith("S")) {
      const numericPart = parseInt(docNumber.replace(/\D/g, ""), 10);
      if (!isNaN(numericPart)) {
        await pgConnection.raw(`SELECT setval('custom_order_seq', ?, false)`, [
          numericPart,
        ]);
        console.log(
          `[revert-to-draft] Recovered sequence custom_order_seq back to ${numericPart}`
        );
      }
    }

    // 2. Clear out the S sequence and inject the E sequence (E + display_id)
    const newDocNumber = `E${order.display_id}`;

    await orderService.updateOrders([
      {
        id: order.id,
        is_draft_order: true,
        status: "draft" as any, // TypeScript expects OrderStatus, but 'draft' is used heavily internally
        metadata: {
          ...meta,
          document_number: newDocNumber,
        },
      },
    ]);

    // 2b. Cleanup orphan QB pipeline rows.
    // convert-force writes a `sales_order/waiting` row when the order is converted.
    // After revert, that row would never be processed (qb-pos-sync filters
    // is_draft_order=false in the SO section, and the estimate section only
    // touches step='estimate' rows). Mark them skipped so they don't linger
    // forever as orphans in the pipeline UI.
    try {
      await pgConnection.raw(
        `UPDATE qb_order_pipeline
            SET status     = 'skipped',
                error      = 'Order reverted to draft — Sales Order superseded',
                updated_at = NOW()
          WHERE order_id   = ?
            AND step       = 'sales_order'
            AND status IN ('waiting', 'pending', 'failed')`,
        [order.id]
      );
    } catch (cleanupErr: any) {
      console.warn(
        `[revert-to-draft] Failed to skip orphan sales_order pipeline rows for ${id}:`,
        cleanupErr?.message
      );
    }

    // 2c. Enqueue the estimate row the reverted draft now needs. No
    // draft_order.created event fires on a revert, and qb-pos-sync's estimate
    // section only wakes existing 'waiting' rows — it never inserts one — so
    // without this the estimate never reaches QB (E3161, 2026-08-22).
    // 'pending' (not 'waiting') because the cron's window keys off created_at
    // (1h-24h): a revert outside it would strand a 'waiting' row forever;
    // 'pending' is picked up by the consolidator's next tick regardless of age.
    // Skip when the draft already carries a QB TxnID (draft→convert→revert
    // cycle): the estimate exists in QB and an ADD would mint a duplicate.
    // getEstimateTxnId reads the canonical nested qb_estimate.txn_id shape —
    // the flat qb_estimate_txn_id key is legacy and often null alongside it.
    if (
      process.env.QB_ORDER_FLOW_ENABLED === "true" &&
      !getEstimateTxnId(meta)
    ) {
      try {
        await writePipelineRow({
          orderId: order.id,
          step: "estimate",
          status: "pending",
          medusaRefNumber: newDocNumber,
        });
        console.log(
          `[revert-to-draft] 📥 Enqueued pending estimate row for ${id} (${newDocNumber})`
        );
      } catch (enqueueErr: any) {
        console.warn(
          `[revert-to-draft] Failed to enqueue estimate pipeline row for ${id}:`,
          enqueueErr?.message
        );
      }
    }

    // 3. Clear existing inventory reservations (from Strategy 1 native fulfillment allocations)
    try {
      for (const item of order.items || []) {
        // RAW SQL read — module { line_item_id } filter is unreliable; a miss
        // here leaks a phantom reservation.
        const knexConn = req.scope.resolve("__pg_connection__") as any;
        const existingRes = await listActiveReservationsRaw(knexConn, item.id);
        if (existingRes.length > 0) {
          await inventoryModule.deleteReservationItems(
            existingRes.map((r) => r.id)
          );
        }
      }
    } catch (invErr) {
      console.warn(
        `[revert-to-draft] Failed to clear reservations for ${id}`,
        invErr
      );
    }

    console.log(
      `[revert-to-draft] ✅ Successfully reverted ${id} back to draft state as ${newDocNumber}`
    );
    return res
      .status(200)
      .json({ action: "reverted", document_number: newDocNumber });
  } catch (error: any) {
    console.error(`[revert-to-draft] Error reverting order ${id}:`, error);
    return res.status(500).json({ error: error.message });
  }
}
