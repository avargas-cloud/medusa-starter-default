/**
 * GET  /admin/commissions/orders/:orderId — comisión de la orden (refrescada).
 * POST /admin/commissions/orders/:orderId — guardar asignación (PIN, §2.5).
 * DELETE /admin/commissions/orders/:orderId — quitar asignación en draft (PIN).
 *
 * La ruta es la autoridad (PIN + validaciones acá, nunca en la pantalla). Todo
 * write pasa por el escritor único con advisory lock; el dinero se lee en la
 * MISMA transacción.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { getDbPool } from "../../../../utils/db-pool";
import {
  loadCommissionBusinessConfig,
} from "../../../../../lib/commissions/config";
import { readOrderMoneySnapshot } from "../../../../../lib/commissions/order-money";
import { recipientAmountCents } from "../../../../../lib/commissions/calculator";
import {
  asInt,
  CommissionError,
  fetchCommission,
  refreshCommission,
  saveAssignment,
  withOrderCommissionLock,
  type RecipientRow,
} from "../../../../../lib/commissions/writer";
import { canReSaveAssignment } from "../../../../../lib/commissions/transitions";
import { requireSupervisorPin } from "../../_lib/guard";

interface RecipientBody {
  customer_id?: unknown;
  qb_vendor_id?: unknown;
  display_name?: unknown;
  percent_bps?: unknown;
}

function requireOrderId(req: MedusaRequest, res: MedusaResponse): string | null {
  const orderId = req.params.orderId;
  if (!orderId) {
    res.status(400).json({ error: "orderId is required." });
    return null;
  }
  return orderId;
}

function commissionErrorResponse(res: MedusaResponse, err: CommissionError): void {
  const status =
    err.code === "not_found" ? 404 : err.code === "assignment_locked" ? 409 : 400;
  res.status(status).json({ error: err.message, code: err.code, details: err.details });
}

function serializeRecipient(r: RecipientRow, baseCents: number) {
  const frozen = r.amount_cents == null ? null : asInt(r.amount_cents);
  return {
    id: r.id,
    customer_id: r.customer_id,
    qb_vendor_id: r.qb_vendor_id,
    display_name: r.display_name,
    percent_bps: r.percent_bps,
    state: r.state,
    eligible_at: r.eligible_at,
    /** Congelado al aprobar; antes, derivado en vivo de la base vigente. */
    amount_cents: frozen ?? recipientAmountCents(baseCents, r.percent_bps),
    amount_is_frozen: frozen != null,
  };
}

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const orderId = requireOrderId(req, res);
  if (!orderId) return;
  const pool = getDbPool();
  try {
    const config = await loadCommissionBusinessConfig();
    const result = await withOrderCommissionLock(pool, orderId, async (client) => {
      const money = await readOrderMoneySnapshot(client, orderId);
      if (!money) return { missingOrder: true as const };
      await refreshCommission(client, orderId, money);
      const existing = await fetchCommission(client, orderId);
      return { missingOrder: false as const, money, existing };
    });

    if (result.missingOrder) {
      res.status(404).json({ error: "Order not found." });
      return;
    }

    const { existing, money } = result;
    res.json({
      config: { cap_bps: config.capBps, wait_days: config.waitDays },
      money: {
        item_subtotal_cents: money.itemSubtotalCents,
        discount_cents: money.discountCents,
        fully_paid_at: money.fullyPaidAt,
        last_invoice_at: money.lastInvoiceAt,
      },
      commission: existing
        ? {
            id: existing.commission.id,
            order_id: existing.commission.order_id,
            currency_code: existing.commission.currency_code,
            item_subtotal_cents: asInt(existing.commission.item_subtotal_cents),
            discount_cents: asInt(existing.commission.discount_cents),
            base_cents: asInt(existing.commission.base_cents),
            discount_bps: existing.commission.discount_bps,
            cap_bps: existing.commission.cap_bps,
            wait_days: existing.commission.wait_days,
            version: existing.commission.version,
            editable: canReSaveAssignment(existing.recipients.map((r) => r.state)),
            recipients: existing.recipients.map((r) =>
              serializeRecipient(r, asInt(existing.commission.base_cents))
            ),
          }
        : null,
    });
  } catch (err) {
    console.error("[commissions] GET order failed:", err);
    res.status(500).json({ error: "Could not load the order's commission." });
  }
}

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const orderId = requireOrderId(req, res);
  if (!orderId) return;
  const pin = await requireSupervisorPin(req, res);
  if (!pin) return;

  const body = (req.body ?? {}) as { recipients?: unknown };
  if (!Array.isArray(body.recipients)) {
    res.status(400).json({ error: "recipients must be a list." });
    return;
  }
  const recipients: Array<{
    customerId?: string;
    qbVendorId?: string;
    displayName: string;
    percentBps: number;
  }> = [];
  for (const raw of body.recipients as RecipientBody[]) {
    const customerId = typeof raw.customer_id === "string" && raw.customer_id ? raw.customer_id : undefined;
    const qbVendorId =
      typeof raw.qb_vendor_id === "string" && raw.qb_vendor_id
        ? raw.qb_vendor_id
        : undefined;
    const displayName = typeof raw.display_name === "string" ? raw.display_name.trim() : "";
    const percentBps = Number(raw.percent_bps);
    if (!displayName) {
      res.status(400).json({ error: "Each recipient needs a display_name." });
      return;
    }
    if (!Number.isInteger(percentBps)) {
      res.status(400).json({ error: "percent_bps must be an integer (bps)." });
      return;
    }
    recipients.push({ customerId, qbVendorId, displayName, percentBps });
  }

  const pool = getDbPool();
  try {
    const config = await loadCommissionBusinessConfig();
    const saved = await withOrderCommissionLock(pool, orderId, async (client) => {
      const money = await readOrderMoneySnapshot(client, orderId);
      if (!money) throw new CommissionError("not_found", "Order not found.");
      const result = await saveAssignment(client, {
        orderId,
        orderCustomerId: money.orderCustomerId,
        currencyCode: money.currencyCode,
        money,
        recipients,
        capBps: config.capBps,
        waitDays: config.waitDays,
        actorId: pin.actorId,
      });
      await refreshCommission(client, orderId, money);
      return result;
    });
    res.json({ ok: true, commission_id: saved.commissionId, recipient_ids: saved.recipientIds });
  } catch (err) {
    if (err instanceof CommissionError) {
      commissionErrorResponse(res, err);
      return;
    }
    console.error("[commissions] POST assignment failed:", err);
    res.status(500).json({ error: "Could not save the assignment." });
  }
}

export async function DELETE(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const orderId = requireOrderId(req, res);
  if (!orderId) return;
  const pin = await requireSupervisorPin(req, res);
  if (!pin) return;

  const pool = getDbPool();
  try {
    await withOrderCommissionLock(pool, orderId, async (client) => {
      const existing = await fetchCommission(client, orderId);
      if (!existing) throw new CommissionError("not_found", "This order has no commission.");
      if (!canReSaveAssignment(existing.recipients.map((r) => r.state))) {
        throw new CommissionError(
          "assignment_locked",
          "This assignment already has accrued or settled recipients — it cannot be removed."
        );
      }
      await client.query(
        `UPDATE order_commission_recipient
            SET deleted_at = NOW(), updated_at = NOW()
          WHERE order_commission_id = $1 AND deleted_at IS NULL`,
        [existing.commission.id]
      );
      await client.query(
        `UPDATE order_commission SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [existing.commission.id]
      );
    });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof CommissionError) {
      commissionErrorResponse(res, err);
      return;
    }
    console.error("[commissions] DELETE assignment failed:", err);
    res.status(500).json({ error: "Could not remove the assignment." });
  }
}
