import { Modules } from "@medusajs/utils";
import { getDbPool } from "../api/utils/db-pool";

/**
 * Dynamically computes and resets the true native Medusa Order statuses
 * based purely on factual order_item quantities and pos_invoice records.
 * Use this after voiding invoices, changing fulfillments, or manual payment interventions.
 * @param orderId - The Medusa Order ID (e.g. order_01...)
 * @param container - Provide the Medusa dependency scope to invoke native services
 */
export async function recalculateOrderStatus(
  orderId: string,
  container?: any
): Promise<void> {
  const pool = getDbPool();
  // Dedicated connection so we can hold a session advisory lock (below) and never
  // leave session state on a pooled connection borrowed by someone else.
  const client = await pool.connect();
  const lockKey = `complete-order:${orderId}`;
  let locked = false;

  try {
    // Serialize against maybeCompleteOrder, which holds the SAME advisory lock key
    // while it completes an order. Without this, a void-driven reopen could race a
    // concurrent native completion and either be clobbered or (worse) reopen an
    // order that legitimately just completed. Bounded ~5s try-loop (deterministic,
    // independent of whether lock_timeout applies to advisory locks); if we can't
    // acquire it we proceed best-effort rather than hang the void response.
    for (let i = 0; i < 25 && !locked; i++) {
      const lr = await client.query(
        `SELECT pg_try_advisory_lock(hashtext($1)) AS ok`,
        [lockKey]
      );
      if (lr.rows[0]?.ok) {
        locked = true;
        break;
      }
      await client.query(`SELECT pg_sleep(0.2)`);
    }
    if (!locked) {
      console.warn(
        `[ORDER ORACLE] advisory lock busy for ${orderId} after ~5s — proceeding best-effort`
      );
    }

    // Step 1: Fulfillment metrics — CURRENT VERSION ONLY. Edited / void+re-invoice
    // orders leave stale prior-version `order_item` rows (fulfilled_quantity=0);
    // summing across all versions misclassifies completeness (repo rule: derive
    // fulfillment from oi.version = order.version — see CLAUDE.md 2026-06-03).
    const itemRes = await client.query(
      `SELECT
                SUM(oi.quantity)            AS total_qty,
                SUM(oi.fulfilled_quantity)  AS total_fulfilled,
                SUM(oi.delivered_quantity)  AS total_delivered
             FROM order_item oi
             JOIN "order" o ON o.id = oi.order_id
             WHERE oi.order_id = $1
               AND oi.version = o.version
               AND oi.deleted_at IS NULL`,
      [orderId]
    );
    const metrics = itemRes.rows[0];
    const qty = Number(metrics?.total_qty || 0);
    const fulfilled = Number(metrics?.total_fulfilled || 0);
    const delivered = Number(metrics?.total_delivered || 0);

    let newFulfillmentStatus = "not_fulfilled";

    if (fulfilled > 0 && fulfilled < qty) {
      newFulfillmentStatus = "partially_fulfilled";
    } else if (fulfilled > 0 && fulfilled >= qty) {
      newFulfillmentStatus = "fulfilled";
      // Note: If delivered == qty we could set shipped, but 'fulfilled' is standard for POS.
    }

    // Step 2: Recognized payment from non-voided POS invoices (informational log
    // only — NOT used to derive a status). ⚠️ We deliberately do NOT read
    // `order.total` here: in Medusa v2 the "order" table has no physical `total`
    // column, so `SELECT total FROM "order"` throws and used to abort this whole
    // recalc → order stayed `completed`.
    const invoiceRes = await client.query(
      `SELECT SUM(amount_paid) as total_paid
             FROM pos_invoice
             WHERE order_id = $1 AND status != 'voided'`,
      [orderId]
    );
    const totalPaid = Number(invoiceRes.rows[0]?.total_paid || 0);

    // This helper only runs to REOPEN an order after a void / fulfillment change,
    // so the target is always the open state 'pending'. We never re-close here.
    //
    // NOTE: We intentionally do NOT reverse native payment collections here — the
    // invoice void route already refunds captured payments via the payment module.

    const newStatus = "pending";
    console.log(
      `[ORDER ORACLE] Recalculating ${orderId} | Fulfillment: ${newFulfillmentStatus} | Paid(cents): ${totalPaid} | Delivered: ${delivered} | Status: ${newStatus}`
    );

    // Re-read the live status INSIDE the lock. Only the completed→pending reopen is
    // the problematic case: Medusa treats `completed` as terminal and the ORDER
    // module's updateOrders silently no-ops that downgrade, so a voided order stayed
    // `completed` — which kept it in the POS Closed tab while actually unfulfilled
    // AND hid the "Mark as Picked Up" button (the invoice page maps
    // order.status==='completed' → fulfillment state 'delivered'; order #2252 /
    // invoice 20930). We NEVER force-reopen a canceled/draft/archived order, and an
    // already-'pending' order needs no status write.
    const statusRes = await client.query(
      `SELECT status FROM "order" WHERE id = $1`,
      [orderId]
    );
    const liveStatus = statusRes.rows[0]?.status as string | undefined;

    if (liveStatus === "completed") {
      // Prefer the module first (fires order.updated for subscribers) even though it
      // no-ops the terminal downgrade; the authoritative raw SQL below actually
      // enforces it. Raw SQL is the source of truth for the `status` column.
      if (container) {
        try {
          const orderModule = container.resolve(Modules.ORDER);
          await orderModule.updateOrders([{ id: orderId, status: newStatus }]);
        } catch (modErr: any) {
          console.warn(
            `[ORDER ORACLE] module updateOrders failed for ${orderId}, SQL fallback will enforce: ${modErr.message}`
          );
        }
      }
      const upd = await client.query(
        `UPDATE "order" SET status = $1, updated_at = NOW() WHERE id = $2 AND status = 'completed'`,
        [newStatus, orderId]
      );
      console.log(
        `[ORDER ORACLE] reopened ${orderId} completed→pending (${upd.rowCount} row)`
      );
    } else if (liveStatus && liveStatus !== "pending") {
      console.log(
        `[ORDER ORACLE] ${orderId} status='${liveStatus}' — leaving as-is (no reopen)`
      );
    }

    // Reset the display `order_status` metadata so a stale "Fulfilled" / "Ready to
    // Ship" / "Delivered" label doesn't survive the void (the order is now reopened
    // & no longer fully fulfilled). Only for OPEN orders — never rewrite a
    // canceled/draft label. Written via jsonb_set (NOT the module) because Medusa's
    // update* deep-merges JSONB and a scalar key can re-hydrate to its old value.
    // Never overwrite a "Voided" label.
    if (liveStatus === "completed" || liveStatus === "pending") {
      const orderStatusLabel =
        newFulfillmentStatus === "fulfilled" ? "Fulfilled" : "Approved";
      await client.query(
        `UPDATE "order"
            SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{order_status}', to_jsonb($1::text), true),
                updated_at = NOW()
          WHERE id = $2
            AND COALESCE(metadata->>'order_status', '') NOT IN ('Voided', $1)`,
        [orderStatusLabel, orderId]
      );
    }
  } catch (e: any) {
    console.error(
      `[ORDER ORACLE] Failed to recalculate order status for ${orderId}:`,
      e.message
    );
  } finally {
    if (locked) {
      try {
        await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [lockKey]);
      } catch {
        /* best-effort unlock */
      }
    }
    client.release();
  }
}
