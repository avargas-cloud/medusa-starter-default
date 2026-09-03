/**
 * Order Outsourced Services — liquidación por vendor bill.
 *
 * Sólo hay UN camino: el bill. No existe el "case 2" de comisiones (cheque
 * contra una cuenta clearing + ReceivePayment sin aplicar) porque a un
 * subcontratista no se le paga con crédito de tienda. Eso borra los dos steps
 * propios de pipeline y sus siete registros cruzados: el bill llega a
 * QuickBooks por `POST /admin/vendor-bills/:id/confirm`, el chokepoint que ya
 * opera a diario.
 *
 * Un servicio NUNCA toca QuickBooks desde este módulo. El acople es de una sola
 * vía y por polling: `reconcileServiceSettlements` lee `vendor_bill.qb_txn_id`.
 */

import { randomUUID } from "crypto";
import type { Pool, PoolClient } from "pg";

import { ServiceError, type ServiceRow } from "./writer";

const asInt = (v: string | number | null | undefined): number =>
  v == null ? 0 : Number(v);

export interface SettlementInsert {
  serviceId: string;
  amountCents: number;
  vendorBillId: string;
  createdBy: string | null;
}

export async function insertSettlement(
  client: PoolClient,
  input: SettlementInsert
): Promise<string> {
  const id = `osst_${randomUUID().replace(/-/g, "")}`;
  try {
    await client.query(
      `INSERT INTO outsourced_service_settlement
         (id, service_id, amount_cents, vendor_bill_id, status, idempotency_key, created_by)
       VALUES ($1,$2,$3,$4,'pending',$5,$6)`,
      [
        id,
        input.serviceId,
        input.amountCents,
        input.vendorBillId,
        `outsourced-service-settle:${id}`,
        input.createdBy,
      ]
    );
  } catch (err) {
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === "23505") {
      // Discriminar por constraint: los tres 23505 posibles significan cosas
      // distintas y un mensaje genérico manda al operador a buscar el problema
      // equivocado.
      if (pgErr.constraint === "uq_osst_live_per_bill") {
        throw new ServiceError(
          "invalid_state",
          "That bill is already settling another service — one bill settles one service.",
          { reason: "bill_already_settled" }
        );
      }
      if (pgErr.constraint === "uq_osst_idempotency") {
        throw new ServiceError("invalid_state", "This settlement was already submitted.", {
          reason: "duplicate_idempotency_key",
        });
      }
      throw new ServiceError(
        "invalid_state",
        "This service already has a live settlement — one obligation goes through ONE path.",
        { reason: "settlement_exists" }
      );
    }
    throw err;
  }
  return id;
}

/**
 * Valida un vendor bill para liquidar un servicio: del vendor correcto, en
 * estado utilizable, no reclamado por nadie (ni por otro servicio NI por una
 * comisión), con el monto EXACTO y todas sus líneas contra la cuenta congelada
 * del servicio.
 *
 * El cruce contra `commission_settlement` es el que evita el modo de falla que
 * ninguna de las dos features ve sola: los índices parciales viven cada uno en
 * SU tabla, así que por base de datos un mismo bill podría reclamarse una vez
 * de cada lado y pagarse dos veces contra una sola salida de plata. En la
 * práctica el chequeo de cuenta ya lo hace estructuralmente imposible —las
 * cuentas de comisión y las de subcontrato son conjuntos disjuntos, y cada lado
 * exige que TODAS las líneas sean de las suyas— pero esa garantía depende de
 * una convención de configuración, y una convención no es un candado. Este
 * chequeo es explícito para que romper la convención dé un error entendible en
 * vez de un pago duplicado. `verify-outsourced-services.ts` §disjuntas afirma
 * la premisa.
 */
export async function validateVendorBillForService(
  client: PoolClient,
  vendorBillId: string,
  service: ServiceRow,
  amountCents: number
): Promise<void> {
  if (!service.qb_account_list_id) {
    throw new ServiceError(
      "settlement_off",
      "This service has no frozen expense account — it was approved before the type was configured."
    );
  }

  const { rows } = await client.query<{
    id: string;
    vendor_id: string | null;
    status: string;
  }>(
    `SELECT id, vendor_id, status FROM vendor_bill
      WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [vendorBillId]
  );
  const bill = rows[0];
  if (!bill) throw new ServiceError("not_found", "Vendor bill not found.");

  if (bill.vendor_id !== service.qb_vendor_id) {
    throw new ServiceError(
      "invalid_state",
      "That bill belongs to a different vendor than the one that performed the service.",
      { reason: "bill_vendor_mismatch" }
    );
  }
  if (!["draft", "confirmed"].includes(bill.status)) {
    throw new ServiceError("invalid_state", `The bill is in state '${bill.status}'.`, {
      reason: "bill_bad_status",
    });
  }

  // Reuso por OTRO servicio. El índice es el candado bajo concurrencia; esto
  // existe para nombrar al otro servicio en el mensaje.
  const { rows: reuseRows } = await client.query<{
    id: string;
    display_number: string | number | null;
    vendor_display_name: string;
  }>(
    `SELECT s.id, o.display_number, o.vendor_display_name
       FROM outsourced_service_settlement s
       JOIN order_outsourced_service o ON o.id = s.service_id
      WHERE s.vendor_bill_id = $1
        AND s.status IN ('pending','qb_waiting','confirmed')
      LIMIT 1`,
    [vendorBillId]
  );
  const reuse = reuseRows[0];
  if (reuse) {
    const label = reuse.display_number ? `OSV-${reuse.display_number}` : reuse.vendor_display_name;
    throw new ServiceError(
      "invalid_state",
      `This bill is already settling ${label} — one bill settles one service.`,
      { reason: "bill_already_settled", otherSettlementId: reuse.id }
    );
  }

  // Reuso por una COMISIÓN. Ver el comentario del encabezado.
  const { rows: commissionRows } = await client.query<{ id: string }>(
    `SELECT id FROM commission_settlement
      WHERE vendor_bill_id = $1
        AND status IN ('pending','qb_waiting','confirmed')
      LIMIT 1`,
    [vendorBillId]
  );
  if (commissionRows[0]) {
    throw new ServiceError(
      "invalid_state",
      "That bill is already settling a commission — it cannot also settle an outsourced service.",
      { reason: "bill_claimed_by_commission", commissionSettlementId: commissionRows[0].id }
    );
  }

  const { rows: lineRows } = await client.query<{
    total_cents: string | number | null;
    off_account: string | number | null;
  }>(
    `SELECT SUM(COALESCE(amount_cents, ROUND(qty * unit_cost_cents)))::bigint AS total_cents,
            COUNT(*) FILTER (WHERE qb_account_list_id IS DISTINCT FROM $2) AS off_account
       FROM vendor_bill_line
      WHERE vendor_bill_id = $1 AND deleted_at IS NULL AND line_type = 'qb_account'`,
    [vendorBillId, service.qb_account_list_id]
  );
  const total = asInt(lineRows[0]?.total_cents);
  const offAccount = asInt(lineRows[0]?.off_account);

  if (total !== amountCents) {
    throw new ServiceError(
      "invalid_state",
      `The bill totals ${total}¢ but the approved service is ${amountCents}¢ — they must match exactly.`,
      { reason: "bill_amount_mismatch", billCents: total, approvedCents: amountCents }
    );
  }
  if (offAccount > 0) {
    throw new ServiceError(
      "invalid_state",
      `Every bill line must post to "${service.qb_account_full_name}".`,
      { reason: "bill_wrong_account" }
    );
  }
}

/**
 * Cierra los settlements cuyo bill ya asentó en QuickBooks. Lo llaman el
 * listado (refresh-on-read) y el E2E.
 *
 * El estado resultante es `posted`, NO `closed`: `qb_txn_id` prueba que el bill
 * existe en QuickBooks, no que el subcontratista haya cobrado. El pago de AP es
 * otro ciclo y esta feature no lo modela — decir "paid" acá sería que la
 * pantalla afirme algo que el sistema nunca observó.
 *
 * `vb.deleted_at IS NULL` no es decorativo: sin él se cerraría contra un bill
 * soft-borrado, y de `posted` no hay vuelta.
 */
export async function reconcileServiceSettlements(
  client: PoolClient | Pool
): Promise<number> {
  const { rows } = await client.query<{ id: string; service_id: string }>(
    `SELECT s.id, s.service_id
       FROM outsourced_service_settlement s
       JOIN vendor_bill vb ON vb.id = s.vendor_bill_id AND vb.deleted_at IS NULL
      WHERE s.status IN ('pending','qb_waiting')
        AND vb.qb_txn_id IS NOT NULL`
  );
  if (rows.length === 0) return 0;

  let closed = 0;
  for (const row of rows) {
    await client.query(
      `UPDATE outsourced_service_settlement
          SET status = 'confirmed', updated_at = now()
        WHERE id = $1`,
      [row.id]
    );
    const res = await client.query(
      `UPDATE order_outsourced_service
          SET state = 'posted', settled_at = now(), updated_at = now()
        WHERE id = $1 AND state = 'settling'`,
      [row.service_id]
    );
    closed += res.rowCount ?? 0;
  }
  return closed;
}

export interface SettlementSummary {
  id: string;
  status: string;
  vendor_bill_id: string | null;
  vendor_bill_number: string | null;
  failure_reason: string | null;
}

/** El settlement más reciente de cada servicio, para el listado y el detalle. */
export async function fetchLatestSettlement(
  client: PoolClient | Pool,
  serviceId: string
): Promise<SettlementSummary | null> {
  const { rows } = await client.query<SettlementSummary>(
    `SELECT s.id, s.status, s.vendor_bill_id, vb.number AS vendor_bill_number,
            s.failure_reason
       FROM outsourced_service_settlement s
       LEFT JOIN vendor_bill vb ON vb.id = s.vendor_bill_id
      WHERE s.service_id = $1
      ORDER BY s.created_at DESC
      LIMIT 1`,
    [serviceId]
  );
  return rows[0] ?? null;
}
