import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";

import { FINANCE_MODULE } from "../../../../../modules/finance";

export interface AppliedPaymentDto {
  application_id: string;
  payment_id: string;
  sequence_number: number | null;
  payment_method: string;
  card_brand: string | null;
  reference: string | null;
  payment_status: string;
  payment_type: string;
  captured_at: string | null;
  applied_at: string | null;
  amount_applied_cents: number;
  voided: boolean;
  void_reason: string | null;
}

function toCents(val: unknown): number {
  if (val == null) return 0;
  if (typeof val === "number") return Math.round(val);
  if (typeof val === "string") {
    const n = Number(val);
    return Number.isFinite(n) ? Math.round(n) : 0;
  }
  if (typeof val === "object") {
    const raw =
      (val as { numeric_?: unknown; value?: unknown }).numeric_ ??
      (val as { value?: unknown }).value;
    if (typeof raw === "number") return Math.round(raw);
    if (typeof raw === "string") {
      const n = Number(raw);
      return Number.isFinite(n) ? Math.round(n) : 0;
    }
  }
  return 0;
}

function toIso(val: unknown): string | null {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === "string") return val;
  return null;
}

interface RawPaymentApplication {
  id: string;
  payment_id?: string | null;
  amount_applied?: unknown;
  applied_at?: unknown;
  voided_at?: unknown;
  void_reason?: string | null;
  payment?: {
    id?: string;
    display_id?: number | null;
    method?: string | null;
    card_brand?: string | null;
    reference?: string | null;
    status?: string | null;
    type?: string | null;
    received_at?: unknown;
  } | null;
}

export function mapAppliedPayment(
  app: RawPaymentApplication
): AppliedPaymentDto {
  const payment = app.payment ?? null;
  return {
    application_id: app.id,
    payment_id: payment?.id ?? app.payment_id ?? "",
    sequence_number: payment?.display_id ?? null,
    payment_method: payment?.method ?? "other",
    card_brand: payment?.card_brand ?? null,
    reference: payment?.reference ?? null,
    payment_status: payment?.status ?? "unknown",
    payment_type: payment?.type ?? "payment",
    captured_at: toIso(payment?.received_at),
    applied_at: toIso(app.applied_at),
    amount_applied_cents: toCents(app.amount_applied),
    voided: Boolean(app.voided_at),
    void_reason: app.void_reason ?? null,
  };
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const id = req.params.id;
  if (!id) {
    return res.status(400).json({ error: "Missing invoice id" });
  }

  const financeService = req.scope.resolve(FINANCE_MODULE) as {
    listPaymentApplications: (
      filters: Record<string, unknown>,
      config?: Record<string, unknown>
    ) => Promise<RawPaymentApplication[]>;
  };

  try {
    // Applications bound to THIS invoice (real settlements) only. Order-only
    // deposits (invoice_id NULL) are NOT settlements — they appear in the
    // modal's Store Credits list (selectable to apply), not here. Including
    // them here showed the same deposit twice (Applied + Store Credit).
    const invoiceApps = await financeService.listPaymentApplications(
      { invoice_id: id },
      { relations: ["payment"] }
    );

    const applied_payments = invoiceApps
      .map(mapAppliedPayment)
      .sort((a, b) => {
        const aTime = a.applied_at ?? a.captured_at ?? "";
        const bTime = b.applied_at ?? b.captured_at ?? "";
        return bTime.localeCompare(aTime);
      });

    return res.json({ applied_payments });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
}
