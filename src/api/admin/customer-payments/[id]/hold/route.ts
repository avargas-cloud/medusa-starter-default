/**
 * POST /admin/customer-payments/:id/hold { kind: "deposit"|"credit"|null, note? }
 *
 * Marks a payment's UNAPPLIED balance as a known deposit/credit hold for Cash
 * Close (`metadata.cash_close_hold`) so it stops counting as unexplained.
 * `kind: null` clears the hold. All the validation and the jsonb merge live
 * in `lib/cash-close/service.ts#holdPayment` — this route only maps its
 * errors to HTTP status codes.
 */
import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import {
  CashClosePaymentFullyAppliedError,
  CashClosePaymentNotFoundError,
  CashClosePaymentVoidedError,
  holdPayment,
} from "../../../../../lib/cash-close/service";
import type { Knexish } from "../../../../../lib/cash-close/load-day";
import type { HoldKind } from "../../../../../lib/cash-close/types";

interface HoldBody {
  kind?: unknown;
  note?: unknown;
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const userId = req.auth_context?.actor_id;
  if (!userId) {
    res.status(401).json({ error: "POS_AUTH_REQUIRED" });
    return;
  }

  const { id } = req.params as { id: string };
  const body = req.body as HoldBody;
  const kind: HoldKind | null =
    body.kind === "deposit" || body.kind === "credit" ? body.kind : null;
  if (body.kind !== undefined && body.kind !== null && kind === null) {
    res.status(400).json({ error: "CASH_CLOSE_INVALID_HOLD_KIND" });
    return;
  }
  const note =
    typeof body.note === "string" && body.note.trim() !== ""
      ? body.note.trim().slice(0, 2000)
      : null;

  const knex = req.scope.resolve("__pg_connection__") as unknown as Knexish;

  try {
    const hold = await holdPayment(knex, {
      paymentId: id,
      kind,
      note,
      actorId: userId,
    });
    res.json({ hold });
  } catch (err) {
    if (err instanceof CashClosePaymentNotFoundError) {
      res.status(404).json({ error: "CASH_CLOSE_PAYMENT_NOT_FOUND" });
      return;
    }
    if (err instanceof CashClosePaymentVoidedError) {
      res.status(409).json({ error: "CASH_CLOSE_PAYMENT_VOIDED" });
      return;
    }
    if (err instanceof CashClosePaymentFullyAppliedError) {
      res.status(409).json({ error: "CASH_CLOSE_PAYMENT_FULLY_APPLIED" });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[cash-close] hold failed: ${message}`);
    res.status(500).json({ error: "CASH_CLOSE_HOLD_FAILED", message });
  }
}
