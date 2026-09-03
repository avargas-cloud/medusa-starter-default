/**
 * POST   /admin/outsourced-services/orders/:orderId/services/:serviceId
 *          body.action = update | approve | void | settle          (PIN)
 * DELETE /admin/outsourced-services/orders/:orderId/services/:serviceId  (PIN)
 *
 * Anidado bajo la orden por dos razones: el `orderId` es la clave del advisory
 * lock, y así no compite un segmento dinámico con los literales `types`/`orders`
 * al mismo nivel del router.
 *
 * El settle NO toca QuickBooks. Valida el bill, lo linkea y deja el servicio en
 * `settling`; el bill llega a QB por el confirm normal de vendor bills, y el
 * servicio pasa a `posted` cuando la conciliación ve su `qb_txn_id`.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../../../../../utils/db-pool";
import {
  insertSettlement,
  validateVendorBillForService,
} from "../../../../../../../lib/outsourced-services/settle";
import { canStartSettlement } from "../../../../../../../lib/outsourced-services/transitions";
import {
  approveService,
  deleteDraftService,
  fetchService,
  serviceAmountCents,
  ServiceError,
  updateService,
  voidService,
  withOrderServiceLock,
} from "../../../../../../../lib/outsourced-services/writer";
import { assertAccounting, requireSupervisorPin } from "../../../../_lib/guard";

type Action = "update" | "approve" | "void" | "settle";

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
    res
      .status(statusFor(err.code))
      .json({ error: err.message, code: err.code, ...err.details });
    return true;
  }
  return false;
}

interface ActionBody {
  action?: unknown;
  reason?: unknown;
  vendor_bill_id?: unknown;
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

  const { orderId, serviceId } = req.params;
  if (!orderId || !serviceId) {
    res.status(400).json({ error: "Missing order or service id." });
    return;
  }
  const body = (req.body ?? {}) as ActionBody;
  const action = body.action as Action | undefined;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");

  if (!action || !["update", "approve", "void", "settle"].includes(action)) {
    res.status(400).json({ error: "action must be update, approve, void or settle." });
    return;
  }

  try {
    const result = await withOrderServiceLock(getDbPool(), orderId, async (client) => {
      const service = await fetchService(client, serviceId);
      if (!service) throw new ServiceError("not_found", "Service not found.");
      if (service.order_id !== orderId) {
        // Defensa contra un id pegado a mano: el lock es por ORDEN, así que
        // operar un servicio de otra orden bajo este lock sería una escritura
        // sin protección.
        throw new ServiceError("not_found", "That service does not belong to this order.");
      }

      if (action === "update") {
        await updateService(client, serviceId, {
          qbVendorId: str(body.qb_vendor_id).trim(),
          vendorDisplayName: str(body.vendor_display_name).trim(),
          serviceTypeId: str(body.service_type_id).trim(),
          amountCents:
            typeof body.amount_cents === "number" ? body.amount_cents : NaN,
          description: str(body.description) || null,
          vendorInvoiceNumber: str(body.vendor_invoice_number) || null,
        });
        return { ok: true as const };
      }

      if (action === "approve") {
        const { displayNumber } = await approveService(client, serviceId, pin.actorId);
        return { ok: true as const, service_number: `OSV-${displayNumber}` };
      }

      if (action === "void") {
        await voidService(client, serviceId, str(body.reason), pin.actorId);
        return { ok: true as const };
      }

      // settle
      if (!canStartSettlement(service.state)) {
        throw new ServiceError(
          "invalid_state",
          `Only an approved service can be settled — this one is '${service.state}'.`,
          { state: service.state }
        );
      }
      const vendorBillId = str(body.vendor_bill_id).trim();
      if (!vendorBillId) {
        throw new ServiceError("invalid_input", "Pick or create the vendor bill that settles this service.");
      }

      const amountCents = serviceAmountCents(service);
      await validateVendorBillForService(client, vendorBillId, service, amountCents);

      const settlementId = await insertSettlement(client, {
        serviceId,
        amountCents,
        vendorBillId,
        createdBy: pin.actorId,
      });

      await client.query(
        `UPDATE order_outsourced_service
            SET state = 'settling', settled_by = $2, updated_at = now()
          WHERE id = $1 AND state = 'approved'`,
        [serviceId, pin.actorId]
      );

      return { ok: true as const, settlement_id: settlementId };
    });

    res.json(result);
  } catch (err) {
    if (sendServiceError(res, err)) return;
    throw err;
  }
}

export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  if (!(await assertAccounting(req, res))) return;
  if (!(await requireSupervisorPin(req, res))) return;

  const { orderId, serviceId } = req.params;
  if (!orderId || !serviceId) {
    res.status(400).json({ error: "Missing order or service id." });
    return;
  }

  try {
    await withOrderServiceLock(getDbPool(), orderId, async (client) => {
      const service = await fetchService(client, serviceId);
      if (!service) throw new ServiceError("not_found", "Service not found.");
      if (service.order_id !== orderId) {
        throw new ServiceError("not_found", "That service does not belong to this order.");
      }
      await deleteDraftService(client, serviceId);
    });
    res.json({ ok: true });
  } catch (err) {
    if (sendServiceError(res, err)) return;
    throw err;
  }
}
