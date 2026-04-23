import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { Modules } from "@medusajs/utils";

import { getDbPool } from "../api/utils/db-pool";

/**
 * AUTO-ENQUEUE CUSTOMER DATA-EXT TO QB
 *
 * Cuando un customer se crea o actualiza con metadata.acquisition_channel,
 * encola una fila step='customer_data_ext' en qb_order_pipeline para que
 * el consolidator escriba ese valor al custom field "Distribution Channel"
 * del customer en QuickBooks Desktop.
 *
 * Reglas:
 *  1. Se necesita metadata.qb_list_id — si no existe (customer todavía no
 *     sincronizado), se saltea; el siguiente update (post-sync) lo atrapará.
 *  2. Se necesita metadata.acquisition_channel con valor truthy.
 *  3. Deduplicación: si ya hay una fila pending/submitted para este customer,
 *     no se encola otra — la existente escribirá el valor actual cuando corra.
 */

async function enqueueIfNeeded(
  customerId: string,
  customerModule: any,
  logger: any
): Promise<void> {
  try {
    const customer = await customerModule.retrieveCustomer(customerId);
    const meta = (customer.metadata ?? {}) as Record<string, unknown>;
    const qbListId = typeof meta.qb_list_id === "string" ? meta.qb_list_id : null;
    const channel =
      typeof meta.acquisition_channel === "string"
        ? (meta.acquisition_channel as string).trim()
        : "";

    if (!qbListId || !channel) return;

    const pool = getDbPool();

    // Dedup: skip if there's already a pending/submitted/waiting row for this customer.
    const { rows: existing } = await pool.query(
      `SELECT id FROM qb_order_pipeline
        WHERE step = 'customer_data_ext'
          AND reference_id = $1
          AND status IN ('pending', 'submitted', 'waiting')
        LIMIT 1`,
      [customerId]
    );
    if (existing.length > 0) {
      return;
    }

    await pool.query(
      `INSERT INTO qb_order_pipeline
         (order_id, step, status, reference_id, reference_type, created_at, updated_at)
       VALUES
         (NULL, 'customer_data_ext', 'pending', $1, 'customer', NOW(), NOW())`,
      [customerId]
    );
    logger.info(
      `[qb-customer-data-ext] Queued data_ext sync for customer ${customerId} (qb_list_id=${qbListId}, channel="${channel}")`
    );
  } catch (err: any) {
    logger.warn(
      `[qb-customer-data-ext] Enqueue failed for customer ${customerId}: ${err?.message ?? err}`
    );
  }
}

function extractCustomerIdsFromEvent(data: any): string[] {
  const ids = new Set<string>();
  const push = (v: unknown) => {
    if (typeof v === "string" && v) ids.add(v);
  };
  if (!data) return [];
  push(data.id);
  push(data.customer_id);
  if (Array.isArray(data.id)) data.id.forEach(push);
  if (Array.isArray(data.customer_id)) data.customer_id.forEach(push);
  if (Array.isArray(data)) {
    for (const item of data) {
      push(item?.id);
      push(item?.customer_id);
    }
  }
  return [...ids];
}

export default async function handler({
  event,
  container,
}: SubscriberArgs<any>) {
  const logger = container.resolve("logger");
  const customerModule = container.resolve(Modules.CUSTOMER);

  const ids = extractCustomerIdsFromEvent(event?.data);
  if (ids.length === 0) return;

  for (const id of ids) {
    await enqueueIfNeeded(id, customerModule, logger);
  }
}

export const config: SubscriberConfig = {
  event: ["customer.created", "customer.updated"],
};
