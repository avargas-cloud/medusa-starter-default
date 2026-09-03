/**
 * GET  /admin/commissions/orders/:orderId — comisión de la orden (refrescada).
 * POST /admin/commissions/orders/:orderId — guardar asignación (PIN, §2.5).
 * DELETE /admin/commissions/orders/:orderId — quitar asignación en draft (PIN).
 *
 * La ruta es la autoridad (PIN + validaciones acá, nunca en la pantalla). Todo
 * write pasa por el escritor único con advisory lock; el dinero se lee en la
 * MISMA transacción.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../../../utils/db-pool";
import {
  loadCommissionBusinessConfig,
} from "../../../../../lib/commissions/config";
import { readOrderMoneySnapshot } from "../../../../../lib/commissions/order-money";
import {
  effectiveAmountCents,
  effectiveBps,
  type CommissionAmountMode,
} from "../../../../../lib/commissions/calculator";
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
import { assertAccounting, requireSupervisorPin } from "../../_lib/guard";

interface RecipientBody {
  customer_id?: unknown;
  qb_vendor_id?: unknown;
  display_name?: unknown;
  percent_bps?: unknown;
  amount_mode?: unknown;
  fixed_amount_cents?: unknown;
}

function requireOrderId(req: AuthenticatedMedusaRequest, res: MedusaResponse): string | null {
  const orderId = req.params.orderId;
  if (!orderId) {
    res.status(400).json({ error: "orderId is required." });
    return null;
  }
  return orderId;
}

function commissionErrorResponse(res: MedusaResponse, err: CommissionError): void {
  const status =
    err.code === "not_found"
      ? 404
      : err.code === "assignment_locked" || err.code === "order_not_commissionable"
        ? 409
        : 400;
  res.status(status).json({ error: err.message, code: err.code, details: err.details });
}

function serializeRecipient(r: RecipientRow, baseCents: number) {
  const frozen = r.amount_cents == null ? null : asInt(r.amount_cents);
  const amount = {
    mode: r.amount_mode,
    percentBps: r.percent_bps,
    fixedAmountCents: r.fixed_amount_cents == null ? null : asInt(r.fixed_amount_cents),
  };
  return {
    id: r.id,
    customer_id: r.customer_id,
    qb_vendor_id: r.qb_vendor_id,
    display_name: r.display_name,
    /**
     * El % VIVO sobre la base vigente. En una fila fija se deriva del monto,
     * así que se mueve solo cuando la orden cambia — es exactamente lo que el
     * cap tiene que medir. Una fila ya congelada conserva el suyo.
     */
    percent_bps: frozen != null ? r.percent_bps : effectiveBps(baseCents, amount) ?? r.percent_bps,
    amount_mode: r.amount_mode,
    fixed_amount_cents: amount.fixedAmountCents,
    state: r.state,
    eligible_at: r.eligible_at,
    /** Congelado al aprobar; antes, derivado en vivo según el modo. */
    amount_cents: frozen ?? effectiveAmountCents(baseCents, amount),
    amount_is_frozen: frozen != null,
  };
}

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  if (!(await assertAccounting(req, res))) return;
  const orderId = requireOrderId(req, res);
  if (!orderId) return;
  const pool = getDbPool();
  try {
    const config = await loadCommissionBusinessConfig();
    const result = await withOrderCommissionLock(pool, orderId, async (client) => {
      const money = await readOrderMoneySnapshot(client, orderId);
      if (!money) return { missingOrder: true as const };
      const { cap } = await refreshCommission(client, orderId, money);
      const existing = await fetchCommission(client, orderId);
      return { missingOrder: false as const, money, existing, cap };
    });

    if (result.missingOrder) {
      res.status(404).json({ error: "Order not found." });
      return;
    }

    const { existing, money, cap } = result;
    res.json({
      config: { cap_bps: config.capBps, wait_days: config.waitDays },
      money: {
        item_subtotal_cents: money.itemSubtotalCents,
        discount_cents: money.discountCents,
        fully_paid_at: money.fullyPaidAt,
        first_invoice_at: money.firstInvoiceAt,
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
            // Cap combinado VIVO. `cap` es null sólo si no hay comisión (caso
            // ya cubierto por `existing ? … : null` de más arriba) — se omiten
            // las 4 claves en vez de mandar ceros: un cero diría "está bien" y
            // no es lo mismo que "no sé".
            ...(cap
              ? {
                  combined_bps: cap.combinedBps,
                  total_commission_bps: cap.totalCommissionBps,
                  cap_exceeded: !cap.ok && !cap.undeterminedFixed,
                  cap_undetermined: cap.undeterminedFixed,
                }
              : {}),
          }
        : null,
    });
  } catch (err) {
    console.error("[commissions] GET order failed:", err);
    res.status(500).json({ error: "Could not load the order's commission." });
  }
}

export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  if (!(await assertAccounting(req, res))) return;
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
    mode: CommissionAmountMode;
    percentBps: number;
    fixedAmountCents?: number | null;
  }> = [];
  for (const raw of body.recipients as RecipientBody[]) {
    const customerId = typeof raw.customer_id === "string" && raw.customer_id ? raw.customer_id : undefined;
    const qbVendorId =
      typeof raw.qb_vendor_id === "string" && raw.qb_vendor_id
        ? raw.qb_vendor_id
        : undefined;
    const displayName = typeof raw.display_name === "string" ? raw.display_name.trim() : "";
    if (!displayName) {
      res.status(400).json({ error: "Each recipient needs a display_name." });
      return;
    }

    // Sin `amount_mode` es 'percent': los callers previos siguen andando igual.
    if (raw.amount_mode !== undefined && raw.amount_mode !== "percent" && raw.amount_mode !== "fixed") {
      res.status(400).json({ error: "amount_mode must be 'percent' or 'fixed'." });
      return;
    }
    const mode: CommissionAmountMode = raw.amount_mode === "fixed" ? "fixed" : "percent";

    if (mode === "fixed") {
      const fixedAmountCents = Number(raw.fixed_amount_cents);
      if (!Number.isInteger(fixedAmountCents) || fixedAmountCents <= 0) {
        res
          .status(400)
          .json({ error: "fixed_amount_cents must be a positive integer (cents)." });
        return;
      }
      recipients.push({ customerId, qbVendorId, displayName, mode, percentBps: 0, fixedAmountCents });
      continue;
    }

    const percentBps = Number(raw.percent_bps);
    if (!Number.isInteger(percentBps)) {
      res.status(400).json({ error: "percent_bps must be an integer (bps)." });
      return;
    }
    recipients.push({ customerId, qbVendorId, displayName, mode, percentBps });
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
        orderStatus: money.orderStatus,
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

export async function DELETE(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  if (!(await assertAccounting(req, res))) return;
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
