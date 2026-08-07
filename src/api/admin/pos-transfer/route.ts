import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { handleDraftOrderUpdated } from "../../../lib/quickbooks/handlers/handle-draft-order-updated";
import { handleOrderUpdated } from "../../../lib/quickbooks/handlers/handle-order-updated";
import { getEstimateTxnId, getSoTxnId } from "../../../lib/quickbooks/qb-metadata-types";
import { resolveOrderQbCustomer } from "../../../lib/quickbooks/resolve-order-qb-customer";

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
 * Guard: once an order has at least one non-voided POS invoice (which is what
 * becomes a QB Invoice or QB Sales Receipt), the customer can no longer be
 * changed — the invoice must be voided first. The modal in the POS only
 * collects the intent; this route is the authority.
 *
 * Propagation (cases 1-4, 2026-08-06): documents that already exist in
 * QuickBooks (Estimate and/or Sales Order) get a MOD enqueued whose payload
 * re-asserts CustomerRef with the live customer. Documents still waiting in
 * the pipeline need nothing — their payload is built fresh at dispatch and
 * the resolver now reads the live customer.
 */

interface PosInvoiceRow {
  invoice_number: string;
  status: string;
  voided_at: string | Date | null;
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  try {
    const { id, customer_id, email } = req.body as {
      id: string;
      customer_id: string;
      email?: string;
    };

    if (!id || !customer_id) {
      return res.status(400).json({ error: "id and customer_id are required" });
    }

    const orderModule = req.scope.resolve("order");
    const current = await orderModule.retrieveOrder(id);

    const isCustomerChange = current.customer_id !== customer_id;

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
    }

    // Attempt update natively bypassing REST restrictions
    const result = await orderModule.updateOrders([
      {
        id,
        customer_id,
        email,
      },
    ]);

    // Re-stamp order.metadata.qb_list_id from the NEW customer right away so
    // every reader converges without waiting for the next handler run.
    if (isCustomerChange) {
      const logger = req.scope.resolve("logger");
      await resolveOrderQbCustomer({ orderId: id, logger }).catch(() => {
        /* best-effort — handlers re-resolve at dispatch anyway */
      });
    }

    // Propagate the change to documents already in QuickBooks (fire-and-forget:
    // the handlers own their pipeline rows, retries and failure visibility).
    if (isCustomerChange && process.env.QB_ORDER_FLOW_ENABLED === "true") {
      const logger = req.scope.resolve("logger");
      const meta = (current.metadata ?? {}) as Record<string, unknown>;
      if (getEstimateTxnId(meta)) {
        handleDraftOrderUpdated(id, req.scope, logger).catch((err) =>
          logger.warn(
            `[pos-transfer] Estimate customer MOD enqueue failed for ${id}: ${err?.message}`
          )
        );
      }
      if (getSoTxnId(meta)) {
        handleOrderUpdated(id, req.scope, logger).catch((err) =>
          logger.warn(
            `[pos-transfer] Sales Order customer MOD enqueue failed for ${id}: ${err?.message}`
          )
        );
      }
    }

    return res.status(200).json({
      success: true,
      message: `Successfully transferred ownership to customer ${customer_id}`,
      order: result[0],
    });
  } catch (error: any) {
    console.error("[pos-transfer]", error);
    return res.status(500).json({ error: error.message });
  }
};
