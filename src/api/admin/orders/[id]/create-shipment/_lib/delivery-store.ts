/**
 * order_delivery persistence for the create-shipment command — explicit
 * pool-based SQL (repo pattern of the hardened order routes), NOT the module
 * service. Each statement auto-commits: the idempotency claim and the
 * bought-label snapshot must be durable the instant they happen, even if the
 * process dies mid-request (that is the whole no-rebuy guarantee).
 * No BigNumber/raw_* columns on this table, so raw SQL is safe.
 */

import { generateEntityId } from "@medusajs/utils";
import type { Pool } from "pg";

import type { CreateLabelResult } from "../../../../../../lib/shipping-dispatch/types";
import type { RehostedPackage } from "./rehost-labels";

export interface OrderDeliveryRow {
  id: string;
  order_id: string;
  fulfillment_id: string | null;
  invoice_id: string | null;
  provider: string;
  provider_object_id: string | null;
  carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  label_url: string | null;
  service: string | null;
  rate_amount_cents: number | null;
  status: string;
  status_detail: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  voided_at: string | null;
  idempotency_key: string | null;
  created_by_user_id: string | null;
  /** { packages: RehostedPackage[], ...provider raw snapshot } */
  metadata: Record<string, unknown> | null;
}

const COLS = `id, order_id, fulfillment_id, invoice_id, provider,
  provider_object_id, carrier, tracking_number, tracking_url, label_url,
  service, rate_amount_cents, status, status_detail, shipped_at, delivered_at,
  voided_at, idempotency_key, created_by_user_id, metadata`;

export async function findDeliveryByKey(
  pool: Pool,
  idempotencyKey: string
): Promise<OrderDeliveryRow | null> {
  const { rows } = await pool.query<OrderDeliveryRow>(
    `SELECT ${COLS} FROM order_delivery
      WHERE idempotency_key = $1 AND deleted_at IS NULL LIMIT 1`,
    [idempotencyKey]
  );
  return rows[0] ?? null;
}

export async function getDelivery(
  pool: Pool,
  id: string
): Promise<OrderDeliveryRow | null> {
  const { rows } = await pool.query<OrderDeliveryRow>(
    `SELECT ${COLS} FROM order_delivery WHERE id = $1 AND deleted_at IS NULL`,
    [id]
  );
  return rows[0] ?? null;
}

/** Atomic claim. Returns the claimed/pre-existing row for this key. */
export async function claimDelivery(
  pool: Pool,
  input: {
    order_id: string;
    invoice_id: string | null;
    provider: string;
    idempotency_key: string;
    created_by_user_id: string | null;
  }
): Promise<OrderDeliveryRow> {
  const id = generateEntityId("", "odel");
  await pool.query(
    `INSERT INTO order_delivery
       (id, order_id, invoice_id, provider, status, idempotency_key, created_by_user_id)
     VALUES ($1, $2, $3, $4, 'label_created', $5, $6)
     ON CONFLICT (idempotency_key) WHERE deleted_at IS NULL AND idempotency_key IS NOT NULL
     DO NOTHING`,
    [
      id,
      input.order_id,
      input.invoice_id,
      input.provider,
      input.idempotency_key,
      input.created_by_user_id,
    ]
  );
  const row = await findDeliveryByKey(pool, input.idempotency_key);
  if (!row) {
    throw new Error("order_delivery claim failed to persist");
  }
  return row;
}

/** Persist the bought label IMMEDIATELY — this is the no-rebuy checkpoint.
 * `packages` = one entry per box (labels already re-hosted to our storage). */
export async function saveLabelOnDelivery(
  pool: Pool,
  id: string,
  label: CreateLabelResult,
  packages: RehostedPackage[]
): Promise<void> {
  await pool.query(
    `UPDATE order_delivery
        SET provider_object_id = $2, carrier = $3, service = $4,
            tracking_number = $5, tracking_url = $6, label_url = $7,
            rate_amount_cents = $8, metadata = $9::jsonb, updated_at = now()
      WHERE id = $1`,
    [
      id,
      label.provider_object_id,
      label.carrier,
      label.service,
      label.tracking_number,
      label.tracking_url,
      label.label_url,
      label.rate_amount_cents,
      JSON.stringify({ ...(label.raw ?? {}), packages }),
    ]
  );
}

export async function setDeliveryFulfillment(
  pool: Pool,
  id: string,
  fulfillmentId: string
): Promise<void> {
  await pool.query(
    `UPDATE order_delivery SET fulfillment_id = $2, updated_at = now() WHERE id = $1`,
    [id, fulfillmentId]
  );
}

export async function finalizeDelivery(
  pool: Pool,
  id: string,
  input: { fulfillment_id: string; invoice_id: string | null; shipped_at: Date }
): Promise<OrderDeliveryRow | null> {
  await pool.query(
    `UPDATE order_delivery
        SET fulfillment_id = $2,
            invoice_id = COALESCE($3, invoice_id),
            shipped_at = $4, status_detail = NULL, updated_at = now()
      WHERE id = $1`,
    [id, input.fulfillment_id, input.invoice_id, input.shipped_at]
  );
  return getDelivery(pool, id);
}

export async function setDeliveryErrorDetail(
  pool: Pool,
  id: string,
  detail: string
): Promise<void> {
  await pool.query(
    `UPDATE order_delivery SET status_detail = left($2, 500), updated_at = now() WHERE id = $1`,
    [id, detail]
  );
}
