/**
 * Order Outsourced Services — escritor único de dominio.
 *
 * Toda mutación pasa por acá dentro de una transacción con advisory lock por
 * ORDEN. La ruta verifica PIN y rol ANTES; este módulo asume que la
 * autorización ya ocurrió y se ocupa de la consistencia.
 *
 * Sobre el estado de la orden: a diferencia de comisiones, una orden `canceled`
 * NO bloquea nada acá. Cancelar una venta no deshace el trabajo del
 * subcontratista — si el instalador ya fue, la deuda existe igual, y bloquear
 * dejaría ese costo sin forma de registrarse. Lo que corresponde es que se VEA:
 * el listado sirve `order_status` para que una orden cancelada con un servicio
 * vivo salte a la vista.
 */

import { randomUUID } from "crypto";
import type { Pool, PoolClient } from "pg";

import { loadServiceType, isSettleable } from "./config";
import {
  canApprove,
  canEdit,
  canVoid,
  isServiceState,
  type ServiceState,
} from "./transitions";
import {
  validateService,
  VALIDATION_MESSAGE,
  type ServiceInput,
} from "./validate";

export class ServiceError extends Error {
  constructor(
    public readonly code:
      | "invalid_input"
      | "not_found"
      | "invalid_state"
      | "service_type_unavailable"
      | "settlement_off",
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

const newId = (prefix: string): string =>
  `${prefix}_${randomUUID().replace(/-/g, "")}`;

/** Transacción + advisory lock por orden. Única puerta de escritura. */
export async function withOrderServiceLock<T>(
  pool: Pool,
  orderId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('order_outsourced_service:' || $1))",
      [orderId]
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface ServiceRow {
  id: string;
  order_id: string;
  display_number: string | number | null;
  currency_code: string;
  qb_vendor_id: string;
  vendor_display_name: string;
  service_type_id: string;
  service_type_code: string;
  service_type_name: string;
  qb_account_list_id: string | null;
  qb_account_full_name: string | null;
  amount_cents: string | number;
  description: string | null;
  vendor_invoice_number: string | null;
  state: ServiceState;
  assigned_by: string | null;
  assigned_at: Date | string | null;
  approved_by: string | null;
  approved_at: Date | string | null;
  settled_by: string | null;
  settled_at: Date | string | null;
  void_reason: string | null;
}

const SERVICE_COLUMNS = `
  id, order_id, display_number, currency_code, qb_vendor_id, vendor_display_name,
  service_type_id, service_type_code, service_type_name,
  qb_account_list_id, qb_account_full_name, amount_cents, description,
  vendor_invoice_number, state, assigned_by, assigned_at,
  approved_by, approved_at, settled_by, settled_at, void_reason
`;

export async function fetchServicesForOrder(
  client: PoolClient | Pool,
  orderId: string
): Promise<ServiceRow[]> {
  const { rows } = await client.query<ServiceRow>(
    `SELECT ${SERVICE_COLUMNS}
       FROM order_outsourced_service
      WHERE order_id = $1 AND deleted_at IS NULL
      ORDER BY assigned_at, id`,
    [orderId]
  );
  return rows;
}

export async function fetchService(
  client: PoolClient | Pool,
  serviceId: string,
  opts?: { forUpdate?: boolean }
): Promise<ServiceRow | null> {
  const { rows } = await client.query<ServiceRow>(
    `SELECT ${SERVICE_COLUMNS}
       FROM order_outsourced_service
      WHERE id = $1 AND deleted_at IS NULL
      LIMIT 1
      ${opts?.forUpdate ? "FOR UPDATE" : ""}`,
    [serviceId]
  );
  return rows[0] ?? null;
}

/**
 * OSV-#### gapless. Se reclama al APROBAR, no al crear: un borrador descartado
 * no debe quemar un número contable. `UPDATE ... RETURNING` dentro de la
 * transacción del caller — un rollback devuelve el número. Si falta la fila del
 * contador TIRA, en vez de caer a un fallback que rompería la secuencia.
 */
async function allocateServiceNumber(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ value: string | number }>(
    `UPDATE document_number_counter
        SET value = value + 1, updated_at = now()
      WHERE name = 'order_outsourced_service'
      RETURNING value`
  );
  const first = rows[0];
  if (!first) {
    throw new ServiceError(
      "invalid_state",
      "The 'order_outsourced_service' number counter is missing — run migration 1783200000000."
    );
  }
  return Number(first.value);
}

function assertValid(input: ServiceInput): void {
  const v = validateService(input);
  if (!v.ok) {
    throw new ServiceError("invalid_input", VALIDATION_MESSAGE[v.reason], {
      reason: v.reason,
    });
  }
}

export interface CreateServiceInput extends ServiceInput {
  orderId: string;
  currencyCode?: string;
  actorId: string | null;
}

export async function createService(
  client: PoolClient,
  input: CreateServiceInput
): Promise<string> {
  assertValid(input);

  const type = await loadServiceType(client, input.serviceTypeId);
  if (!type || !type.isActive) {
    throw new ServiceError(
      "service_type_unavailable",
      "That service type does not exist or is no longer active.",
      { serviceTypeId: input.serviceTypeId }
    );
  }

  // El tipo se snapshotea ya al crear (code + name) para que el borrador diga
  // la verdad si alguien renombra el catálogo mientras está abierto. La CUENTA
  // en cambio se congela recién al aprobar: hasta entonces la obligación no
  // existe y debe seguir al catálogo vivo.
  const id = newId("osvc");
  await client.query(
    `INSERT INTO order_outsourced_service
       (id, order_id, currency_code, qb_vendor_id, vendor_display_name,
        service_type_id, service_type_code, service_type_name,
        amount_cents, description, vendor_invoice_number,
        state, assigned_by, assigned_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft',$12, now())`,
    [
      id,
      input.orderId,
      input.currencyCode ?? "usd",
      input.qbVendorId,
      input.vendorDisplayName.trim(),
      type.id,
      type.code,
      type.displayName,
      input.amountCents,
      input.description?.trim() || null,
      input.vendorInvoiceNumber?.trim() || null,
      input.actorId,
    ]
  );
  return id;
}

export async function updateService(
  client: PoolClient,
  serviceId: string,
  input: ServiceInput
): Promise<void> {
  assertValid(input);

  const current = await fetchService(client, serviceId, { forUpdate: true });
  if (!current) throw new ServiceError("not_found", "Service not found.");
  if (!canEdit(current.state)) {
    throw new ServiceError(
      "invalid_state",
      `A service in state '${current.state}' can no longer be edited — void it and register a new one.`,
      { state: current.state }
    );
  }

  const type = await loadServiceType(client, input.serviceTypeId);
  if (!type || !type.isActive) {
    throw new ServiceError(
      "service_type_unavailable",
      "That service type does not exist or is no longer active.",
      { serviceTypeId: input.serviceTypeId }
    );
  }

  await client.query(
    `UPDATE order_outsourced_service
        SET qb_vendor_id = $2, vendor_display_name = $3,
            service_type_id = $4, service_type_code = $5, service_type_name = $6,
            amount_cents = $7, description = $8, vendor_invoice_number = $9,
            updated_at = now()
      WHERE id = $1`,
    [
      serviceId,
      input.qbVendorId,
      input.vendorDisplayName.trim(),
      type.id,
      type.code,
      type.displayName,
      input.amountCents,
      input.description?.trim() || null,
      input.vendorInvoiceNumber?.trim() || null,
    ]
  );
}

/**
 * Aprobar es el punto de no retorno del registro: reclama el OSV-####, congela
 * la cuenta contable y deja la obligación inmutable. Es lo único que separa un
 * número tipeado en un formulario de un asiento que va a QuickBooks, y por eso
 * lleva PIN en la ruta.
 */
export async function approveService(
  client: PoolClient,
  serviceId: string,
  actorId: string | null
): Promise<{ displayNumber: number }> {
  const current = await fetchService(client, serviceId, { forUpdate: true });
  if (!current) throw new ServiceError("not_found", "Service not found.");
  if (!canApprove(current.state)) {
    throw new ServiceError(
      "invalid_state",
      `Only a draft can be approved — this one is '${current.state}'.`,
      { state: current.state }
    );
  }

  const type = await loadServiceType(client, current.service_type_id);
  if (!type) {
    throw new ServiceError(
      "service_type_unavailable",
      "The service type of this record no longer exists."
    );
  }
  if (!isSettleable(type)) {
    // Kill switch por TIPO: sin cuenta mapeada no hay dónde asentar el gasto.
    // Se rechaza acá y no al liquidar para que el operador no llegue a tener
    // una obligación aprobada que después no puede cerrar por pantalla.
    throw new ServiceError(
      "settlement_off",
      `"${type.displayName}" has no QuickBooks expense account configured — set it in Settings before approving.`,
      { serviceTypeId: type.id, serviceTypeName: type.displayName }
    );
  }

  const displayNumber = await allocateServiceNumber(client);

  await client.query(
    `UPDATE order_outsourced_service
        SET state = 'approved',
            display_number = $2,
            qb_account_list_id = $3,
            qb_account_full_name = $4,
            service_type_code = $5,
            service_type_name = $6,
            approved_by = $7,
            approved_at = now(),
            updated_at = now()
      WHERE id = $1 AND state = 'draft'`,
    [
      serviceId,
      displayNumber,
      type.qbAccountListId,
      type.qbAccountFullName,
      type.code,
      type.displayName,
      actorId,
    ]
  );

  return { displayNumber };
}

export async function voidService(
  client: PoolClient,
  serviceId: string,
  reason: string,
  actorId: string | null
): Promise<void> {
  const current = await fetchService(client, serviceId, { forUpdate: true });
  if (!current) throw new ServiceError("not_found", "Service not found.");
  if (!canVoid(current.state)) {
    throw new ServiceError(
      "invalid_state",
      current.state === "settling"
        ? "This service has a vendor bill in flight — resolve the bill before voiding."
        : "A posted service cannot be voided — the bill already exists in QuickBooks. Issue a vendor credit instead.",
      { state: current.state }
    );
  }
  if (reason.trim().length < 5) {
    throw new ServiceError("invalid_input", "Give a reason of at least 5 characters.");
  }

  // `state='void'` + `void_reason`, SIN tocar `deleted_at`: la fila sigue
  // visible en el listado con su motivo. Un void que desaparece de la pantalla
  // deja al operador sin forma de entender qué pasó.
  await client.query(
    `UPDATE order_outsourced_service
        SET state = 'void', void_reason = $2, updated_at = now()
      WHERE id = $1`,
    [serviceId, reason.trim()]
  );
  void actorId;
}

/** Borrado real (soft) de un borrador: sólo draft, y deja de listarse. */
export async function deleteDraftService(
  client: PoolClient,
  serviceId: string
): Promise<void> {
  const current = await fetchService(client, serviceId, { forUpdate: true });
  if (!current) throw new ServiceError("not_found", "Service not found.");
  if (!canEdit(current.state)) {
    throw new ServiceError(
      "invalid_state",
      `Only a draft can be deleted — this one is '${current.state}'. Use Void instead.`,
      { state: current.state }
    );
  }
  await client.query(
    `UPDATE order_outsourced_service
        SET deleted_at = now(), updated_at = now()
      WHERE id = $1`,
    [serviceId]
  );
}

/** Coerción defensiva: el driver puede devolver bigint como string. */
export function serviceAmountCents(row: Pick<ServiceRow, "amount_cents">): number {
  return Number(row.amount_cents);
}

export function assertKnownState(value: string): ServiceState {
  if (!isServiceState(value)) {
    throw new ServiceError("invalid_state", `Unknown service state '${value}'.`);
  }
  return value;
}
