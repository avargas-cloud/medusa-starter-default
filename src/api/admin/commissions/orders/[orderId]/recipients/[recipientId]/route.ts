/**
 * POST /admin/commissions/orders/:orderId/recipients/:recipientId
 *   body { action: "approve" | "void" | "settle", reason?, method?, vendor_bill_id? }
 *
 * approve: eligible → approved, congela el monto (guard accounting + PIN).
 * void:    draft/eligible/approved → void, con motivo (guard accounting + PIN).
 * settle:  approved → settling (guard accounting + PIN):
 *   · method 'vendor_bill' → valida y linkea un bill YA creado por el chokepoint
 *     de vendor-bills; cierra cuando el bill confirma en QB (reconcile).
 *   · method 'store_credit' → crea el crédito POS (customer_payment marcado) y
 *     encola el par commission_check → commission_payment en el pipeline propio.
 *     La ruta solo escribe filas: despacha el consolidator, confirma el poller.
 *
 * El refresh corre primero en la misma transacción: cada acción decide sobre el
 * estado REAL del devengo, no sobre una fila vieja (§5.4 — revalidar justo
 * antes).
 */

import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { getDbPool } from "../../../../../../utils/db-pool";
import { readOrderMoneySnapshot } from "../../../../../../../lib/commissions/order-money";
import {
  approveRecipient,
  asInt,
  CommissionError,
  fetchCommission,
  refreshCommission,
  voidRecipient,
  withOrderCommissionLock,
} from "../../../../../../../lib/commissions/writer";
import { canStartSettlement } from "../../../../../../../lib/commissions/transitions";
import { loadCommissionQbAccounts } from "../../../../../../../lib/commissions/config";
import {
  buildStoreCreditPayloads,
  commissionMemo,
  commissionRefNumber,
  COMMISSION_CHECK_STEP,
  COMMISSION_PAYMENT_STEP,
  insertSettlement,
  recipientOrdinal,
  resolveBeneficiary,
  validateVendorBillForSettlement,
} from "../../../../../../../lib/commissions/settle";
import { writePipelineRow } from "../../../../../../../lib/quickbooks/qb-pipeline";
import { getBusinessDateString } from "../../../../../../../lib/quickbooks/order-flow-core";
import { FINANCE_MODULE } from "../../../../../../../modules/finance";
import { assertAccounting, requireSupervisorPin } from "../../../../_lib/guard";

interface FinanceModuleLike {
  createCustomerPayments: (data: Record<string, unknown>) => Promise<{ id: string }>;
  updateCustomerPayments: (
    selector: Record<string, unknown>,
    data: Record<string, unknown>
  ) => Promise<unknown>;
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { orderId, recipientId } = req.params;
  if (!orderId || !recipientId) {
    res.status(400).json({ error: "orderId and recipientId are required." });
    return;
  }
  if (!(await assertAccounting(req, res))) return;
  const pin = await requireSupervisorPin(req, res);
  if (!pin) return;

  const body = (req.body ?? {}) as {
    action?: unknown;
    reason?: unknown;
    method?: unknown;
    vendor_bill_id?: unknown;
  };
  const action = body.action;
  if (action !== "approve" && action !== "void" && action !== "settle") {
    res.status(400).json({ error: "action must be 'approve', 'void' or 'settle'." });
    return;
  }
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";

  if (action === "settle") {
    await handleSettle(req, res, {
      orderId,
      recipientId,
      actorId: pin.actorId,
      method: body.method,
      vendorBillId: typeof body.vendor_bill_id === "string" ? body.vendor_bill_id : null,
    });
    return;
  }
  if (action === "void" && !reason) {
    res.status(400).json({ error: "void requires a reason." });
    return;
  }

  const pool = getDbPool();
  try {
    const result = await withOrderCommissionLock(
      pool,
      orderId,
      async (client): Promise<{ amountCents: number } | null> => {
        const money = await readOrderMoneySnapshot(client, orderId);
        if (money) await refreshCommission(client, orderId, money);
        if (action === "approve") {
          return await approveRecipient(client, recipientId, pin.actorId);
        }
        await voidRecipient(client, recipientId, pin.actorId, reason);
        return null;
      }
    );
    res.json({ ok: true, ...(result ? { amount_cents: result.amountCents } : {}) });
  } catch (err) {
    if (err instanceof CommissionError) {
      const status =
        err.code === "not_found" ? 404 : err.code === "invalid_state" ? 409 : 400;
      res.status(status).json({ error: err.message, code: err.code, details: err.details });
      return;
    }
    console.error("[commissions] recipient action failed:", err);
    res.status(500).json({ error: "Could not run the action." });
  }
}

interface SettleContext {
  orderId: string;
  recipientId: string;
  actorId: string | null;
  method: unknown;
  vendorBillId: string | null;
}

async function handleSettle(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
  ctx: SettleContext
): Promise<void> {
  if (ctx.method !== "vendor_bill" && ctx.method !== "store_credit") {
    res.status(400).json({ error: "method must be 'vendor_bill' or 'store_credit'." });
    return;
  }
  const method = ctx.method;
  if (method === "vendor_bill" && !ctx.vendorBillId) {
    res.status(400).json({ error: "vendor_bill_id is required for method 'vendor_bill'." });
    return;
  }

  const accounts = await loadCommissionQbAccounts();
  if (!accounts) {
    res.status(409).json({
      error:
        "Settlement is OFF: the QuickBooks accounts are missing in Settings (expense + clearing).",
      code: "settlement_off",
    });
    return;
  }

  const pool = getDbPool();
  try {
    // Fase transaccional: validar, insertar settlement, mover el estado.
    const staged = await withOrderCommissionLock(pool, ctx.orderId, async (client) => {
      const money = await readOrderMoneySnapshot(client, ctx.orderId);
      if (money) await refreshCommission(client, ctx.orderId, money);

      const existing = await fetchCommission(client, ctx.orderId);
      if (!existing) throw new CommissionError("not_found", "This order has no commission.");
      const recipient = existing.recipients.find((r) => r.id === ctx.recipientId);
      if (!recipient) throw new CommissionError("not_found", "Recipient not found.");
      if (!canStartSettlement(recipient.state)) {
        throw new CommissionError(
          "invalid_state",
          `Only an 'approved' recipient can be settled (it is '${recipient.state}').`,
          { state: recipient.state }
        );
      }
      const amountCents = asInt(recipient.amount_cents);
      if (amountCents <= 0) {
        throw new CommissionError("invalid_state", "The frozen amount is invalid.", {
          reason: "bad_amount",
        });
      }

      const beneficiary = await resolveBeneficiary(client, recipient);
      if (method === "store_credit") {
        if (!beneficiary.customerId) {
          throw new CommissionError(
            "invalid_state",
            "store_credit needs a customer account linked to the beneficiary.",
            { reason: "customer_link_missing" }
          );
        }
        if (!beneficiary.customerQbListId) {
          throw new CommissionError(
            "invalid_state",
            "The customer has no QuickBooks ListID — sync it before settling.",
            { reason: "customer_not_synced" }
          );
        }
      } else {
        await validateVendorBillForSettlement(
          client,
          String(ctx.vendorBillId),
          beneficiary,
          amountCents,
          accounts
        );
      }

      const settlementId = await insertSettlement(client, {
        recipientId: recipient.id,
        method,
        amountCents,
        vendorBillId: method === "vendor_bill" ? ctx.vendorBillId : null,
        createdBy: ctx.actorId,
      });
      await client.query(
        `UPDATE order_commission_recipient
            SET state = 'settling', payout_method = $2, settled_by = $3, updated_at = NOW()
          WHERE id = $1`,
        [recipient.id, method, ctx.actorId]
      );

      const ordinal = recipientOrdinal(existing.recipients, recipient.id);
      const refNumber = commissionRefNumber(money?.orderDisplayId ?? null, ordinal);
      const memo = commissionMemo(
        {
          mode: recipient.amount_mode,
          percentBps: recipient.percent_bps,
          fixedAmountCents:
            recipient.fixed_amount_cents == null ? null : asInt(recipient.fixed_amount_cents),
        },
        money?.orderDisplayId ?? null,
        recipient.display_name
      );
      return {
        settlementId,
        amountCents,
        beneficiary,
        refNumber,
        memo,
        commission: existing.commission,
      };
    });

    if (method === "vendor_bill") {
      res.json({ ok: true, settlement_id: staged.settlementId, method });
      return;
    }

    // Fase post-commit del caso store_credit: crédito POS + filas del pipeline.
    // Si algo falla acá, se COMPENSA (settlement failed + beneficiario approved)
    // y el error viaja al operador — nunca un estado a medias en silencio.
    try {
      const finance = req.scope.resolve(FINANCE_MODULE) as FinanceModuleLike;
      const { rows: seqRows } = await pool.query<{ display_id: string | number }>(
        `SELECT nextval('custom_payment_seq') AS display_id`
      );
      const displayId = Number(seqRows[0]?.display_id ?? 0);
      const payment = await finance.createCustomerPayments({
        customer_id: staged.beneficiary.customerId,
        display_id: displayId,
        amount: staged.amountCents,
        method: "credit_memo",
        type: "payment",
        source: "pos",
        status: "available",
        received_at: new Date(),
        reference: staged.refNumber,
        notes: staged.memo,
        metadata: {
          is_commission_credit: "true",
          commission_settlement_id: staged.settlementId,
          qb_sync_status: "pending",
        },
      });

      const txnDate = getBusinessDateString(new Date());
      const payloads = buildStoreCreditPayloads({
        settlementId: staged.settlementId,
        amountCents: staged.amountCents,
        beneficiary: staged.beneficiary,
        accounts,
        refNumber: staged.refNumber,
        memo: staged.memo,
        txnDate,
        customerPaymentId: payment.id,
        commission: staged.commission,
      });

      const checkRowId = await writePipelineRow({
        referenceId: staged.settlementId,
        referenceType: "commission_settlement",
        step: COMMISSION_CHECK_STEP,
        status: "pending",
        orderId: ctx.orderId,
        medusaRefNumber: staged.refNumber,
        payload: payloads.check,
      });
      const paymentRowId = await writePipelineRow({
        referenceId: staged.settlementId,
        referenceType: "commission_settlement",
        step: COMMISSION_PAYMENT_STEP,
        status: "waiting",
        dependsOn: checkRowId,
        orderId: ctx.orderId,
        medusaRefNumber: staged.refNumber,
        payload: payloads.payment,
      });

      await pool.query(
        `UPDATE commission_settlement
            SET customer_payment_id = $2, check_operation_id = $3, payment_operation_id = $4,
                updated_at = NOW()
          WHERE id = $1`,
        [staged.settlementId, payment.id, checkRowId, paymentRowId]
      );

      res.json({
        ok: true,
        settlement_id: staged.settlementId,
        method,
        customer_payment_id: payment.id,
        ref_number: staged.refNumber,
      });
    } catch (postErr) {
      const message = postErr instanceof Error ? postErr.message : String(postErr);
      console.error("[commissions] settle post-commit failed, compensating:", postErr);
      await pool
        .query(
          `UPDATE commission_settlement
              SET status = 'failed', failure_reason = $2, updated_at = NOW()
            WHERE id = $1`,
          [staged.settlementId, message.slice(0, 500)]
        )
        .catch(() => undefined);
      await pool
        .query(
          `UPDATE order_commission_recipient
              SET state = 'approved', payout_method = NULL, updated_at = NOW()
            WHERE id = $1 AND state = 'settling'`,
          [ctx.recipientId]
        )
        .catch(() => undefined);
      res.status(502).json({
        error: `The settlement could not be queued and was reverted: ${message}`,
        code: "settle_enqueue_failed",
      });
    }
  } catch (err) {
    if (err instanceof CommissionError) {
      const status =
        err.code === "not_found" ? 404 : err.code === "invalid_state" ? 409 : 400;
      res.status(status).json({ error: err.message, code: err.code, details: err.details });
      return;
    }
    console.error("[commissions] settle failed:", err);
    res.status(500).json({ error: "Could not settle." });
  }
}
