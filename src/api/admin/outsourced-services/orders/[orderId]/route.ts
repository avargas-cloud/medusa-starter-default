/**
 * GET  /admin/outsourced-services/orders/:orderId  → servicios de la orden + catálogo
 * POST /admin/outsourced-services/orders/:orderId  → alta de un servicio (PIN)
 *
 * A diferencia de comisiones no hay "asignación" con N beneficiarios que se
 * re-guarda entera: cada servicio es una obligación independiente que nace,
 * se aprueba y se liquida por su cuenta. Por eso el POST CREA uno, no reemplaza
 * un conjunto.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../../../utils/db-pool";
import {
  isSettleable,
  loadServiceTypes,
} from "../../../../../lib/outsourced-services/config";
import { fetchLatestSettlement } from "../../../../../lib/outsourced-services/settle";
import {
  createService,
  fetchServicesForOrder,
  ServiceError,
  withOrderServiceLock,
} from "../../../../../lib/outsourced-services/writer";
import { assertAccounting, requireSupervisorPin } from "../../_lib/guard";

function statusFor(code: ServiceError["code"]): number {
  switch (code) {
    case "not_found":
      return 404;
    case "invalid_state":
    case "settlement_off":
      return 409;
    default:
      return 400;
  }
}

function sendServiceError(res: MedusaResponse, err: unknown): boolean {
  if (err instanceof ServiceError) {
    res.status(statusFor(err.code)).json({ error: err.message, code: err.code, ...err.details });
    return true;
  }
  return false;
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  if (!(await assertAccounting(req, res))) return;

  const orderId = req.params.orderId;
  if (!orderId) {
    res.status(400).json({ error: "Missing order id." });
    return;
  }
  const pool = getDbPool();

  const [services, types] = await Promise.all([
    fetchServicesForOrder(pool, orderId),
    loadServiceTypes(pool),
  ]);

  const withSettlements = await Promise.all(
    services.map(async (s) => ({
      id: s.id,
      service_number: s.display_number ? `OSV-${s.display_number}` : null,
      state: s.state,
      qb_vendor_id: s.qb_vendor_id,
      vendor_display_name: s.vendor_display_name,
      service_type_id: s.service_type_id,
      service_type_code: s.service_type_code,
      service_type_name: s.service_type_name,
      qb_account_full_name: s.qb_account_full_name,
      amount_cents: Number(s.amount_cents),
      description: s.description,
      vendor_invoice_number: s.vendor_invoice_number,
      assigned_at: s.assigned_at,
      approved_at: s.approved_at,
      settled_at: s.settled_at,
      void_reason: s.void_reason,
      settlement: await fetchLatestSettlement(pool, s.id),
    }))
  );

  res.json({
    order_id: orderId,
    services: withSettlements,
    types: types.map((t) => ({
      id: t.id,
      code: t.code,
      display_name: t.displayName,
      settleable: isSettleable(t),
    })),
    settlement_enabled: types.some(isSettleable),
  });
}

interface CreateBody {
  qb_vendor_id?: unknown;
  vendor_display_name?: unknown;
  service_type_id?: unknown;
  amount_cents?: unknown;
  description?: unknown;
  vendor_invoice_number?: unknown;
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  if (!(await assertAccounting(req, res))) return;
  const pin = await requireSupervisorPin(req, res);
  if (!pin) return;

  const orderId = req.params.orderId;
  if (!orderId) {
    res.status(400).json({ error: "Missing order id." });
    return;
  }
  const body = (req.body ?? {}) as CreateBody;

  const str = (v: unknown): string => (typeof v === "string" ? v : "");

  try {
    const id = await withOrderServiceLock(getDbPool(), orderId, (client) =>
      createService(client, {
        orderId,
        qbVendorId: str(body.qb_vendor_id).trim(),
        vendorDisplayName: str(body.vendor_display_name).trim(),
        serviceTypeId: str(body.service_type_id).trim(),
        amountCents:
          typeof body.amount_cents === "number" ? body.amount_cents : NaN,
        description: str(body.description) || null,
        vendorInvoiceNumber: str(body.vendor_invoice_number) || null,
        actorId: pin.actorId,
      })
    );
    res.json({ ok: true, id });
  } catch (err) {
    if (sendServiceError(res, err)) return;
    throw err;
  }
}
