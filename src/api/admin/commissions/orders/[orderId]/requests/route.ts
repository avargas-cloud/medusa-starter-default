/**
 * GET  /admin/commissions/orders/:orderId/requests — solicitudes de comisión
 *      de la orden (pending/approved/rejected), SIN montos.
 * POST /admin/commissions/orders/:orderId/requests — un POS user señala al
 *      beneficiario (customer o vendor) + nota. Sin %, sin PIN: no mueve
 *      dinero; Accounting decide después (commission-requests-20260917).
 *
 * A propósito NO lleva `assertAccounting`: es la única puerta de comisiones
 * abierta al cajero. Sí exige un usuario autenticado del POS (Medusa auth).
 * Las validaciones espejan las de la asignación (`requestBlocker`), para que
 * no nazca una solicitud que nunca podría aprobarse.
 */

import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { getDbPool } from "../../../../../utils/db-pool";
import { withOrderCommissionLock } from "../../../../../../lib/commissions/writer";
import {
  CommissionRequestError,
  createRequest,
  listRequestsForOrder,
  requestErrorStatus,
  serializeRequest,
  validateRequestInput,
} from "../../../../../../lib/commissions/requests";

function requestErrorResponse(res: MedusaResponse, err: CommissionRequestError): void {
  res.status(requestErrorStatus(err)).json({ error: err.message, code: err.code, details: err.details });
}

function requireOrderId(req: AuthenticatedMedusaRequest, res: MedusaResponse): string | null {
  const orderId = req.params.orderId;
  if (!orderId) {
    res.status(400).json({ error: "orderId is required." });
    return null;
  }
  return orderId;
}

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  const orderId = requireOrderId(req, res);
  if (!orderId) return;
  if (!req.auth_context?.actor_id) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }
  try {
    const rows = await listRequestsForOrder(getDbPool(), orderId);
    res.json({ requests: rows.map(serializeRequest) });
  } catch (err) {
    console.error("[commission-requests] GET order failed:", err);
    res.status(500).json({ error: "Could not load the commission requests." });
  }
}

export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  const orderId = requireOrderId(req, res);
  if (!orderId) return;
  const actorId = req.auth_context?.actor_id ?? null;
  if (!actorId) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }
  let input;
  try {
    input = validateRequestInput(req.body);
  } catch (err) {
    if (err instanceof CommissionRequestError) {
      requestErrorResponse(res, err);
      return;
    }
    throw err;
  }
  try {
    // Mismo lock que la asignación: una solicitud no puede nacer mientras
    // Accounting está guardando beneficiarios de esa orden (y viceversa).
    const { requestId } = await withOrderCommissionLock(getDbPool(), orderId, (client) =>
      createRequest(client, orderId, input, actorId)
    );
    res.status(201).json({ ok: true, request_id: requestId });
  } catch (err) {
    if (err instanceof CommissionRequestError) {
      requestErrorResponse(res, err);
      return;
    }
    console.error("[commission-requests] POST failed:", err);
    res.status(500).json({ error: "Could not submit the commission request." });
  }
}
