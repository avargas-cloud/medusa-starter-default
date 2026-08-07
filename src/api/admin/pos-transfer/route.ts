import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { randomBytes } from "crypto";

import { getDbPool } from "../../utils/db-pool";
import { refreshOrderDocsForPayment } from "../finance/_lib/refresh-order-docs";
import {
  extractSupervisorPin,
  guardSupervisorPin,
  pinGuardResponse,
  resolveActorId,
} from "../../../lib/pos/supervisor-pin-guard";
import { pgAsPinConn } from "../../../lib/pos/verify-supervisor-pin";
import { handleDraftOrderUpdated } from "../../../lib/quickbooks/handlers/handle-draft-order-updated";
import { handleOrderUpdated } from "../../../lib/quickbooks/handlers/handle-order-updated";
import { getEstimateTxnId, getSoTxnId } from "../../../lib/quickbooks/qb-metadata-types";

/**
 * POST /admin/pos-transfer
 *
 * Forcefully transfers an Order or Draft Order to a new customer.
 * Native Medusa transfer endpoints require a token-based acceptance flow,
 * which does not fit an immediate POS UI update.
 *
 * This route is the single chokepoint for customer changes: the POS orders
 * page calls it directly and sync-pos (estimates) routes through it too.
 *
 * Guards (the route is the authority; POS modals only collect intent):
 * 1. INVOICES_EXIST — ≥1 non-voided POS invoice (QB Invoice / Sales Receipt)
 *    blocks the change entirely: void first.
 * 2. PAYMENTS_LINKED — the order has linked deposits/payments and the caller
 *    has not said what to do with them. The response lists each payment and
 *    whether it can move customers (a payment with ANY active invoice-bound
 *    application cannot). The POS re-sends with `payment_action`:
 *      · "transfer" → the payment(s) move to the new customer too (Medusa
 *        customer_id + QB transfer_payment TxnDel/recreate). Supervisor PIN.
 *      · "unlink"   → the payment(s) stay with the old customer and are
 *        detached from this order (order-only applications hard-deleted,
 *        locked attribution cleared). Supervisor PIN.
 *    Web-source payments are permanent Treasury ledger — neither action is
 *    allowed on them.
 *
 * Propagation (cases 1-4, 2026-08-06): documents already in QuickBooks
 * (Estimate / Sales Order) get a MOD whose payload re-asserts CustomerRef
 * with the live customer. Documents still waiting in the pipeline need
 * nothing — their payload is built fresh at dispatch. The cache
 * order.metadata.qb_list_id is re-stamped from the NEW customer (or cleared
 * when the new customer has no QB ListID yet — never left pointing at the
 * previous owner), with provenance in qb_list_id_customer_id.
 */

interface PosInvoiceRow {
  invoice_number: string;
  status: string;
  voided_at: string | Date | null;
}

interface LinkedPaymentRow {
  id: string;
  amount: string | number;
  status: string;
  customer_id: string;
  source: string | null;
  locked_order_id: string | null;
  qb_txn: string | null;
  has_invoice_apps: boolean;
}

const cryptoRandomId = (): string => {
  const chars = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = randomBytes(26);
  let out = "";
  for (let i = 0; i < 26; i++) out += chars.charAt((bytes[i] ?? 0) % 32);
  return out;
};

async function findLinkedPayments(
  orderId: string
): Promise<LinkedPaymentRow[]> {
  const { rows } = await getDbPool().query(
    `SELECT cp.id, cp.amount, cp.status, cp.customer_id, cp.source,
            cp.locked_order_id,
            cp.metadata->>'qb_txn_id' AS qb_txn,
            EXISTS(SELECT 1 FROM payment_application pa2
                    WHERE pa2.payment_id = cp.id
                      AND pa2.voided_at IS NULL AND pa2.deleted_at IS NULL
                      AND pa2.invoice_id IS NOT NULL) AS has_invoice_apps
       FROM customer_payment cp
      WHERE cp.type = 'payment'
        AND cp.status NOT IN ('voided', 'refunded')
        AND cp.deleted_at IS NULL
        AND (
          COALESCE(cp.locked_order_id, cp.metadata->>'order_id') = $1
          OR EXISTS(SELECT 1 FROM payment_application pa
                     WHERE pa.payment_id = cp.id AND pa.order_id = $1
                       AND pa.invoice_id IS NULL
                       AND pa.voided_at IS NULL AND pa.deleted_at IS NULL)
        )`,
    [orderId]
  );
  return rows as LinkedPaymentRow[];
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  try {
    const { id, customer_id, email, payment_action } = req.body as {
      id: string;
      customer_id: string;
      email?: string;
      payment_action?: "transfer" | "unlink";
    };

    if (!id || !customer_id) {
      return res.status(400).json({ error: "id and customer_id are required" });
    }

    const orderModule = req.scope.resolve("order");
    const logger = req.scope.resolve("logger");
    const current = await orderModule.retrieveOrder(id);

    const isCustomerChange = current.customer_id !== customer_id;
    let linkedPayments: LinkedPaymentRow[] = [];

    if (isCustomerChange) {
      const invoiceService = req.scope.resolve("invoices") as {
        listPosInvoices: (
          filters: Record<string, unknown>
        ) => Promise<PosInvoiceRow[]>;
      };
      const invoices = await invoiceService.listPosInvoices({ order_id: id });
      const active = (invoices ?? []).filter(
        (inv) => inv.status !== "voided" && !inv.voided_at
      );

      if (active.length > 0) {
        return res.status(409).json({
          error:
            "Customer cannot be changed: this order already has at least one invoice. " +
            "If it was billed to the wrong customer, void the invoice first.",
          code: "INVOICES_EXIST",
          invoices: active.map((inv) => ({
            number: inv.invoice_number,
            status: inv.status,
          })),
        });
      }

      // Money guard (business rule 2026-08-06): a linked deposit belongs to
      // the current customer in QB. The operator decides what happens to it.
      linkedPayments = await findLinkedPayments(id);

      if (linkedPayments.length > 0 && !payment_action) {
        return res.status(409).json({
          error:
            "This order has linked payments/deposits. Choose what to do with " +
            "them (payment_action: transfer | unlink).",
          code: "PAYMENTS_LINKED",
          payments: linkedPayments.map((p) => ({
            id: p.id,
            amount_cents: Math.round(Number(p.amount)),
            transferable: !p.has_invoice_apps && p.source !== "web",
            applied_elsewhere: p.has_invoice_apps,
            web_locked: p.source === "web",
          })),
        });
      }

      if (linkedPayments.length > 0 && payment_action) {
        // Both branches move money attribution → supervisor PIN, verified
        // HERE (the route that executes), mirroring the standalone
        // customer-payments transfer and finance unlink routes.
        const guard = await guardSupervisorPin({
          scope: req.scope as unknown as { resolve: (k: string) => unknown },
          db: pgAsPinConn(getDbPool()),
          pin: extractSupervisorPin(req),
          actorId: resolveActorId(req),
        });
        if (!guard.ok) {
          const { status, body } = pinGuardResponse(guard);
          return res.status(status).json(body);
        }

        const webLocked = linkedPayments.filter((p) => p.source === "web");
        if (webLocked.length > 0) {
          return res.status(409).json({
            error:
              "A web checkout payment is linked to this order. Web payments " +
              "are permanent Treasury ledger — they cannot be transferred or " +
              "unlinked. Resolve it manually before changing the customer.",
            code: "PAYMENTS_WEB_LOCKED",
          });
        }

        if (payment_action === "transfer") {
          const applied = linkedPayments.filter((p) => p.has_invoice_apps);
          if (applied.length > 0) {
            return res.status(409).json({
              error:
                "A linked payment was already applied (even partially) to an " +
                "invoice — its customer cannot be changed. Unlink instead, or " +
                "resolve the applications first.",
              code: "PAYMENT_APPLIED",
              payment_ids: applied.map((p) => p.id),
            });
          }
        }
      }
    }

    // Attempt update natively bypassing REST restrictions
    const result = await orderModule.updateOrders([
      {
        id,
        customer_id,
        email,
      },
    ]);

    // ── Payment resolution (after the order committed, before QB docs) ──────
    if (isCustomerChange && linkedPayments.length > 0 && payment_action) {
      try {
        if (payment_action === "transfer") {
          await transferLinkedPayments(req, linkedPayments, customer_id, id);
        } else {
          await unlinkLinkedPayments(req, linkedPayments, id);
        }
      } catch (payErr) {
        const msg = payErr instanceof Error ? payErr.message : String(payErr);
        // The order already moved; the payment did not. Loud + actionable —
        // never silent (the POS shows this verbatim).
        return res.status(500).json({
          error:
            `Customer was changed but the linked payment could not be ` +
            `${payment_action === "transfer" ? "transferred" : "unlinked"}: ${msg}. ` +
            `Resolve the payment from Accounting.`,
          code: "PAYMENT_RESOLUTION_FAILED",
        });
      }
    }

    // Re-stamp the cache from the NEW customer right away. If the new customer
    // has no QB ListID yet, the cache is CLEARED (never left pointing at the
    // previous owner) and provenance records whose value it is — the document
    // handlers' requireQbCustomer preflight will then create the customer in
    // QB and hold the rows until it exists.
    if (isCustomerChange) {
      try {
        const pool = getDbPool();
        const { rows } = await pool.query(
          `SELECT metadata->>'qb_list_id' AS live FROM customer WHERE id = $1`,
          [customer_id]
        );
        const live = (rows[0]?.live as string | null) ?? null;
        await pool.query(
          `UPDATE "order"
              SET metadata = COALESCE(metadata, '{}'::jsonb)
                  || jsonb_build_object('qb_list_id', $1::text,
                                        'qb_list_id_customer_id', $2::text)
            WHERE id = $3`,
          [live, customer_id, id]
        );
        if (!live) {
          logger.warn(
            `[pos-transfer] customer ${customer_id} has no qb_list_id yet — cache cleared for order ${id}; QB customer will be created on next document`
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          `[pos-transfer] could not re-stamp qb_list_id for ${id}: ${msg}`
        );
      }
    }

    // Propagate the change to documents already in QuickBooks. Awaited so the
    // pending pipeline rows exist before we answer (the bridge work itself
    // stays in the handlers' serialized background callback).
    if (isCustomerChange && process.env.QB_ORDER_FLOW_ENABLED === "true") {
      const meta = (current.metadata ?? {}) as Record<string, unknown>;
      if (getEstimateTxnId(meta)) {
        try {
          await handleDraftOrderUpdated(id, req.scope, logger);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(
            `[pos-transfer] Estimate customer MOD enqueue failed for ${id}: ${msg}`
          );
        }
      }
      if (getSoTxnId(meta)) {
        try {
          await handleOrderUpdated(id, req.scope, logger);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(
            `[pos-transfer] Sales Order customer MOD enqueue failed for ${id}: ${msg}`
          );
        }
      }
    }

    return res.status(200).json({
      success: true,
      message: `Successfully transferred ownership to customer ${customer_id}`,
      order: result[0],
      ...(isCustomerChange && linkedPayments.length > 0 && payment_action
        ? { payment_action, payment_ids: linkedPayments.map((p) => p.id) }
        : {}),
    });
  } catch (error: any) {
    console.error("[pos-transfer]", error);
    return res.status(500).json({ error: error.message });
  }
};

/**
 * Moves the linked payments to the new customer: Medusa customer_id, audit row,
 * and (when the payment lives in QB) a `transfer_payment` pipeline row that
 * TxnDel/recreates the ReceivePayment under the new customer. Order-only
 * applications and locked attribution stay intact — the payment moves WITH the
 * order, so the links remain valid. Mirrors the standalone transfer route's
 * chaining rules; a failed prior transfer blocks (a dead chain never wakes).
 */
async function transferLinkedPayments(
  req: MedusaRequest,
  payments: LinkedPaymentRow[],
  targetCustomerId: string,
  orderId: string
): Promise<void> {
  const actorId =
    ((req as unknown as { auth_context?: { actor_id?: string } }).auth_context
      ?.actor_id as string | undefined) ?? null;
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const p of payments) {
      const { rows: locked } = await client.query(
        `SELECT id, customer_id, amount, metadata FROM customer_payment
          WHERE id = $1 FOR UPDATE`,
        [p.id]
      );
      const fresh = locked[0];
      if (!fresh) throw new Error(`payment ${p.id} not found`);
      if (fresh.customer_id === targetCustomerId) continue;

      // Re-verify inside the lock: still zero invoice-bound applications.
      const { rows: apps } = await client.query(
        `SELECT COUNT(*)::int AS n FROM payment_application
          WHERE payment_id = $1 AND invoice_id IS NOT NULL
            AND voided_at IS NULL AND deleted_at IS NULL`,
        [p.id]
      );
      if (Number(apps[0]?.n ?? 0) > 0) {
        throw new Error(
          `payment ${p.id} was applied to an invoice while transferring`
        );
      }

      const { rows: unresolved } = await client.query(
        `SELECT id, status FROM qb_order_pipeline
          WHERE reference_id = $1 AND step = 'transfer_payment'
            AND status NOT IN ('confirmed', 'cancelled', 'skipped')
          ORDER BY created_at DESC`,
        [p.id]
      );
      if (unresolved.some((r) => r.status === "failed")) {
        throw new Error(
          `payment ${p.id} has a failed prior QB transfer pending review`
        );
      }
      const dependsOn = unresolved[0]?.id ?? null;

      const fromCustomerId = fresh.customer_id as string;
      const amountCents = Math.round(Number(fresh.amount));
      const qbTxnId =
        ((fresh.metadata as Record<string, unknown> | null)?.[
          "qb_txn_id"
        ] as string | undefined) ?? null;
      const needsQb =
        process.env.QB_ORDER_FLOW_ENABLED === "true" && !!qbTxnId;

      await client.query(
        `UPDATE customer_payment SET customer_id = $2, updated_at = NOW()
          WHERE id = $1`,
        [p.id, targetCustomerId]
      );

      const transferId = `cptr_${cryptoRandomId()}`;
      await client.query(
        `INSERT INTO customer_payment_transfer
           (id, payment_id, from_customer_id, to_customer_id, amount, raw_amount,
            reason, requested_by, qb_old_txn_id, qb_status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,NOW(),NOW())`,
        [
          transferId,
          p.id,
          fromCustomerId,
          targetCustomerId,
          amountCents,
          JSON.stringify({ value: String(amountCents), precision: 20 }),
          `pos-transfer of order ${orderId}`,
          actorId,
          qbTxnId,
          needsQb || dependsOn ? "pending" : "not_synced",
        ]
      );

      if (needsQb || dependsOn) {
        await client.query(
          `INSERT INTO qb_order_pipeline
             (reference_id, reference_type, step, status, depends_on, payload, retry_count)
           VALUES ($1, 'customer_payment', 'transfer_payment', $2, $3, $4::jsonb, 0)`,
          [
            p.id,
            dependsOn ? "waiting" : "pending",
            dependsOn,
            JSON.stringify({
              target_customer_id: targetCustomerId,
              transfer_id: transferId,
              payment_id: p.id,
            }),
          ]
        );
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Detaches the linked payments from this order, leaving them with the OLD
 * customer: active order-only applications are hard-deleted (same semantics
 * as finance/applications/:id/unlink — the link is treated as if it never
 * happened) and locked attribution is cleared. Payment status is recomputed
 * from what remains applied.
 */
async function unlinkLinkedPayments(
  req: MedusaRequest,
  payments: LinkedPaymentRow[],
  orderId: string
): Promise<void> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const p of payments) {
      await client.query(
        `DELETE FROM payment_application
          WHERE payment_id = $1 AND order_id = $2 AND invoice_id IS NULL
            AND voided_at IS NULL AND deleted_at IS NULL`,
        [p.id, orderId]
      );
      await client.query(
        `UPDATE customer_payment
            SET locked_order_id = NULL,
                metadata = COALESCE(metadata, '{}'::jsonb) - 'order_id',
                updated_at = NOW()
          WHERE id = $1
            AND COALESCE(locked_order_id, metadata->>'order_id') = $2`,
        [p.id, orderId]
      );
      // Recompute status from what remains applied to invoices.
      const { rows: sums } = await client.query(
        `SELECT COALESCE(SUM(amount_applied), 0)::numeric AS applied
           FROM payment_application
          WHERE payment_id = $1 AND invoice_id IS NOT NULL
            AND voided_at IS NULL AND deleted_at IS NULL`,
        [p.id]
      );
      const applied = Number(sums[0]?.applied ?? 0);
      const amount = Math.round(Number(p.amount));
      const newStatus =
        applied >= amount
          ? "applied"
          : applied > 0
            ? "partially_applied"
            : "available";
      await client.query(
        `UPDATE customer_payment SET status = $2, updated_at = NOW()
          WHERE id = $1 AND status NOT IN ('voided', 'refunded')`,
        [p.id, newStatus]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Unlinking removed money from the order — its search doc is stale.
  try {
    for (const p of payments) {
      await refreshOrderDocsForPayment(req.scope, p.id);
    }
  } catch {
    /* never fatal — the drift reconciler covers it */
  }
}
