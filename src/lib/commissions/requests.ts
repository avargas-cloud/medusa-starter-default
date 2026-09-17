/**
 * Commission Requests — un POS user señala que una orden lleva comisión y a
 * QUIÉN, sin ver ni decidir montos (commission-requests-20260917).
 *
 * La solicitud no tiene %, base ni monto. Accounting la resuelve:
 *  · approved  → al GUARDAR la asignación con esa identidad como beneficiario
 *                (`resolveRequestsForAssignment`, dentro del MISMO lock/tx del
 *                POST /admin/commissions/orders/:orderId). Así también se
 *                resuelve si Accounting asigna directo desde la orden.
 *  · rejected  → acción explícita, motivo + PIN (`rejectRequest`).
 *
 * Las reglas puras (`validateRequestInput`, `requestBlocker`,
 * `matchRequestsToRecipients`) viven separadas del IO para testearse sin base.
 * Las validaciones espejan las de la asignación a propósito: una solicitud
 * que nunca podría aprobarse (orden cancelada, el cliente de la propia orden)
 * no nace, en vez de morir en la pestaña Pending sin que el cajero lo sepa.
 */

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

export type CommissionRequestStatus = "pending" | "approved" | "rejected";

export type CommissionRequestErrorCode =
  | "invalid_input"
  | "not_found"
  | "order_not_commissionable"
  | "beneficiary_is_order_customer"
  | "identity_not_found"
  | "duplicate_pending_request"
  | "already_a_recipient"
  | "request_not_pending"
  | "not_request_owner";

export class CommissionRequestError extends Error {
  constructor(
    public readonly code: CommissionRequestErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "CommissionRequestError";
  }
}

/** HTTP status por código — las rutas lo usan inline (sin helper de framework acá). */
export function requestErrorStatus(err: CommissionRequestError): number {
  switch (err.code) {
    case "not_found":
      return 404;
    case "invalid_input":
      return 400;
    case "not_request_owner":
      return 403;
    default:
      return 409;
  }
}

const NOTE_MAX = 500;
const NAME_MAX = 200;
/** Sólo `canceled` — misma lista que el writer (que la mantiene privada). */
const NON_COMMISSIONABLE_ORDER_STATUSES = new Set(["canceled"]);

export interface RequestInput {
  customerId?: string;
  qbVendorId?: string;
  displayName: string;
  note: string | null;
}

/** Body → input normalizado. Exactamente UNA identidad; nombre obligatorio. */
export function validateRequestInput(raw: unknown): RequestInput {
  const b = (raw ?? {}) as Record<string, unknown>;
  const customerId = typeof b.customer_id === "string" && b.customer_id.trim() ? b.customer_id.trim() : undefined;
  const qbVendorId = typeof b.qb_vendor_id === "string" && b.qb_vendor_id.trim() ? b.qb_vendor_id.trim() : undefined;
  if (!customerId && !qbVendorId) {
    throw new CommissionRequestError("invalid_input", "Pick a customer or a vendor as the beneficiary.");
  }
  if (customerId && qbVendorId) {
    throw new CommissionRequestError("invalid_input", "A request names ONE beneficiary: a customer or a vendor, not both.");
  }
  const displayName = typeof b.display_name === "string" ? b.display_name.trim() : "";
  if (!displayName || displayName.length > NAME_MAX) {
    throw new CommissionRequestError("invalid_input", `display_name is required (max ${NAME_MAX} chars).`);
  }
  let note: string | null = null;
  if (b.note != null) {
    if (typeof b.note !== "string") throw new CommissionRequestError("invalid_input", "note must be text.");
    note = b.note.trim() || null;
    if (note && note.length > NOTE_MAX) {
      throw new CommissionRequestError("invalid_input", `note is too long (max ${NOTE_MAX} chars).`);
    }
  }
  return { customerId, qbVendorId, displayName, note };
}

export interface RequestContext {
  orderStatus: string | null;
  orderCustomerId: string | null;
  identityExists: boolean;
  hasPendingForIdentity: boolean;
  isLiveRecipient: boolean;
}

/** Primer motivo por el que la solicitud NO puede nacer; null = puede. */
export function requestBlocker(input: RequestInput, ctx: RequestContext): CommissionRequestError | null {
  if (ctx.orderStatus != null && NON_COMMISSIONABLE_ORDER_STATUSES.has(ctx.orderStatus)) {
    return new CommissionRequestError(
      "order_not_commissionable",
      `This order is '${ctx.orderStatus}' — it cannot carry a commission.`,
      { orderStatus: ctx.orderStatus }
    );
  }
  if (input.customerId && ctx.orderCustomerId && input.customerId === ctx.orderCustomerId) {
    return new CommissionRequestError(
      "beneficiary_is_order_customer",
      "The order's customer cannot be the beneficiary of its own commission."
    );
  }
  if (!ctx.identityExists) {
    return new CommissionRequestError("identity_not_found", "That customer/vendor does not exist.");
  }
  if (ctx.hasPendingForIdentity) {
    return new CommissionRequestError(
      "duplicate_pending_request",
      "There is already a pending request for this beneficiary on this order."
    );
  }
  if (ctx.isLiveRecipient) {
    return new CommissionRequestError(
      "already_a_recipient",
      "This beneficiary is already assigned a commission on this order."
    );
  }
  return null;
}

export interface RequestIdentity {
  id: string;
  customer_id: string | null;
  qb_vendor_id: string | null;
}

/**
 * Qué solicitudes pendientes quedan APROBADAS por los beneficiarios guardados:
 * coincidencia exacta por customer_id o por qb_vendor_id. Una identidad que no
 * está entre los beneficiarios sigue pendiente (Accounting la rechaza a mano).
 */
export function matchRequestsToRecipients(
  pending: RequestIdentity[],
  recipients: Array<{ customerId?: string | null; qbVendorId?: string | null }>
): string[] {
  const customers = new Set(recipients.map((r) => r.customerId).filter((v): v is string => !!v));
  const vendors = new Set(recipients.map((r) => r.qbVendorId).filter((v): v is string => !!v));
  return pending
    .filter(
      (p) =>
        (p.customer_id != null && customers.has(p.customer_id)) ||
        (p.qb_vendor_id != null && vendors.has(p.qb_vendor_id))
    )
    .map((p) => p.id);
}

// ─── IO ───────────────────────────────────────────────────────────────────

export interface CommissionRequestRow {
  id: string;
  order_id: string;
  customer_id: string | null;
  qb_vendor_id: string | null;
  display_name: string;
  note: string | null;
  status: CommissionRequestStatus;
  requested_by: string | null;
  requested_by_email: string | null;
  requested_at: Date;
  reviewed_by: string | null;
  reviewed_by_email: string | null;
  reviewed_at: Date | null;
  review_reason: string | null;
  order_commission_id: string | null;
  commission_number: string | number | null;
  order_display_id: string | number | null;
  order_document_number: string | null;
}

const REQUEST_SELECT = `
  SELECT cr.id, cr.order_id, cr.customer_id, cr.qb_vendor_id, cr.display_name, cr.note,
         cr.status, cr.requested_by, ur.email AS requested_by_email, cr.requested_at,
         cr.reviewed_by, uv.email AS reviewed_by_email, cr.reviewed_at, cr.review_reason,
         cr.order_commission_id, c.display_number AS commission_number,
         o.display_id AS order_display_id,
         o.metadata->>'document_number' AS order_document_number
    FROM commission_request cr
    LEFT JOIN "user" ur ON ur.id = cr.requested_by
    LEFT JOIN "user" uv ON uv.id = cr.reviewed_by
    LEFT JOIN order_commission c ON c.id = cr.order_commission_id
    LEFT JOIN "order" o ON o.id = cr.order_id`;

type Queryable = Pick<PoolClient, "query">;

export async function listRequestsForOrder(db: Queryable, orderId: string): Promise<CommissionRequestRow[]> {
  const { rows } = await db.query<CommissionRequestRow>(
    `${REQUEST_SELECT}
      WHERE cr.order_id = $1 AND cr.deleted_at IS NULL
      ORDER BY cr.requested_at DESC, cr.id DESC`,
    [orderId]
  );
  return rows;
}

export async function listRequestsByStatus(
  db: Queryable,
  status: CommissionRequestStatus
): Promise<CommissionRequestRow[]> {
  const { rows } = await db.query<CommissionRequestRow>(
    `${REQUEST_SELECT}
      WHERE cr.status = $1 AND cr.deleted_at IS NULL
      ORDER BY cr.requested_at DESC, cr.id DESC`,
    [status]
  );
  return rows;
}

export async function getRequest(db: Queryable, requestId: string): Promise<CommissionRequestRow | null> {
  const { rows } = await db.query<CommissionRequestRow>(
    `${REQUEST_SELECT} WHERE cr.id = $1 AND cr.deleted_at IS NULL LIMIT 1`,
    [requestId]
  );
  return rows[0] ?? null;
}

/** Lee el contexto que `requestBlocker` necesita, en la tx del caller. */
export async function loadRequestContext(
  client: PoolClient,
  orderId: string,
  input: RequestInput
): Promise<RequestContext | null> {
  const { rows: orderRows } = await client.query<{ customer_id: string | null; status: string | null }>(
    `SELECT customer_id, status FROM "order" WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [orderId]
  );
  const order = orderRows[0];
  if (!order) return null;

  const identitySql = input.customerId
    ? `SELECT 1 FROM customer WHERE id = $1 AND deleted_at IS NULL`
    : `SELECT 1 FROM qb_vendor WHERE id = $1 AND deleted_at IS NULL`;
  const identityId = input.customerId ?? input.qbVendorId ?? "";
  const { rowCount: identityCount } = await client.query(identitySql, [identityId]);

  const { rows: pendingRows } = await client.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM commission_request
      WHERE order_id = $1 AND status = 'pending' AND deleted_at IS NULL
        AND (($2::text IS NOT NULL AND customer_id = $2) OR ($3::text IS NOT NULL AND qb_vendor_id = $3))`,
    [orderId, input.customerId ?? null, input.qbVendorId ?? null]
  );
  const { rows: liveRows } = await client.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM order_commission_recipient r
       JOIN order_commission c ON c.id = r.order_commission_id AND c.deleted_at IS NULL
      WHERE c.order_id = $1 AND r.deleted_at IS NULL AND r.state <> 'void'
        AND (($2::text IS NOT NULL AND r.customer_id = $2) OR ($3::text IS NOT NULL AND r.qb_vendor_id = $3))`,
    [orderId, input.customerId ?? null, input.qbVendorId ?? null]
  );
  return {
    orderStatus: order.status,
    orderCustomerId: order.customer_id,
    identityExists: (identityCount ?? 0) > 0,
    hasPendingForIdentity: Number(pendingRows[0]?.n ?? 0) > 0,
    isLiveRecipient: Number(liveRows[0]?.n ?? 0) > 0,
  };
}

export async function createRequest(
  client: PoolClient,
  orderId: string,
  input: RequestInput,
  actorId: string | null
): Promise<{ requestId: string }> {
  const ctx = await loadRequestContext(client, orderId, input);
  if (!ctx) throw new CommissionRequestError("not_found", "Order not found.");
  const blocker = requestBlocker(input, ctx);
  if (blocker) throw blocker;
  const id = `creq_${randomUUID().replace(/-/g, "")}`;
  await client.query(
    `INSERT INTO commission_request
       (id, order_id, customer_id, qb_vendor_id, display_name, note, status, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
    [id, orderId, input.customerId ?? null, input.qbVendorId ?? null, input.displayName, input.note, actorId]
  );
  return { requestId: id };
}

/** Retirar una pendiente: su autor, o Accounting. Soft-delete (la traza queda). */
export async function withdrawRequest(
  client: PoolClient,
  requestId: string,
  actor: { actorId: string | null; canAccounting: boolean }
): Promise<void> {
  const { rows } = await client.query<{ status: CommissionRequestStatus; requested_by: string | null }>(
    `SELECT status, requested_by FROM commission_request
      WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [requestId]
  );
  const row = rows[0];
  if (!row) throw new CommissionRequestError("not_found", "Request not found.");
  if (row.status !== "pending") {
    throw new CommissionRequestError("request_not_pending", "Only a pending request can be withdrawn.");
  }
  if (!actor.canAccounting && (!actor.actorId || row.requested_by !== actor.actorId)) {
    throw new CommissionRequestError("not_request_owner", "Only the requester (or Accounting) can withdraw it.");
  }
  await client.query(
    `UPDATE commission_request SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [requestId]
  );
}

export async function rejectRequest(
  client: PoolClient,
  requestId: string,
  reason: string,
  actorId: string | null
): Promise<void> {
  const { rows } = await client.query<{ status: CommissionRequestStatus }>(
    `SELECT status FROM commission_request WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [requestId]
  );
  const row = rows[0];
  if (!row) throw new CommissionRequestError("not_found", "Request not found.");
  if (row.status !== "pending") {
    throw new CommissionRequestError("request_not_pending", "This request was already reviewed.");
  }
  await client.query(
    `UPDATE commission_request
        SET status = 'rejected', review_reason = $2, reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [requestId, reason, actorId]
  );
}

/**
 * Llamar DENTRO del lock de la orden, después de `saveAssignment`: las
 * pendientes cuya identidad quedó como beneficiario pasan a approved.
 */
export async function resolveRequestsForAssignment(
  client: PoolClient,
  orderId: string,
  commissionId: string,
  recipients: Array<{ customerId?: string | null; qbVendorId?: string | null }>,
  actorId: string | null
): Promise<string[]> {
  const { rows: pending } = await client.query<RequestIdentity>(
    `SELECT id, customer_id, qb_vendor_id FROM commission_request
      WHERE order_id = $1 AND status = 'pending' AND deleted_at IS NULL FOR UPDATE`,
    [orderId]
  );
  const approved = matchRequestsToRecipients(pending, recipients);
  if (approved.length === 0) return [];
  await client.query(
    `UPDATE commission_request
        SET status = 'approved', order_commission_id = $2, reviewed_by = $3,
            reviewed_at = NOW(), updated_at = NOW()
      WHERE id = ANY($1::text[])`,
    [approved, commissionId, actorId]
  );
  return approved;
}

export function serializeRequest(r: CommissionRequestRow) {
  return {
    id: r.id,
    order_id: r.order_id,
    order_display_id: r.order_display_id == null ? null : String(r.order_display_id),
    order_document_number: r.order_document_number,
    customer_id: r.customer_id,
    qb_vendor_id: r.qb_vendor_id,
    display_name: r.display_name,
    note: r.note,
    status: r.status,
    requested_by: r.requested_by,
    requested_by_email: r.requested_by_email,
    requested_at: r.requested_at,
    reviewed_by_email: r.reviewed_by_email,
    reviewed_at: r.reviewed_at,
    review_reason: r.review_reason,
    order_commission_id: r.order_commission_id,
    commission_number: r.commission_number == null ? null : `COM-${r.commission_number}`,
  };
}
