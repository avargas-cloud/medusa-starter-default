/**
 * refresh-delivery-tracking — every 6 hours.
 *
 * Advances the order_delivery state machine by polling carriers (reuses the
 * lib/carrier-tracking lookup adapters by tracking number — plan Fase 6).
 * Guardrails per the delivery plan:
 *  - Only non-terminal rows (delivered/canceled leave the query — the partial
 *    index IDX_order_delivery_active serves exactly this WHERE).
 *  - Max tracking age 45d: a label the carrier stopped updating is not polled
 *    forever.
 *  - exception/failed rows retry on a slower cadence (24h) instead of every
 *    run — they stay visible in the [Deliveries] tab until a human resolves.
 *  - pg advisory try-lock so overlapping runs never double-poll.
 *  - Stale-poll safety: transitions go through applyStatusUpdate (forward-only).
 */

import type { MedusaContainer } from "@medusajs/framework/types";

import { fetchCarrierEta } from "../lib/carrier-tracking";
import { getDispatchAdapter } from "../lib/shipping-dispatch/registry";
import {
  applyStatusUpdate,
  deliveryStatusFromCarrier,
} from "../lib/shipping-dispatch/status";
import type { DeliveryStatus } from "../lib/shipping-dispatch/types";
import { getDbPool } from "../api/utils/db-pool";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";
export const config = {
  name: "refresh-delivery-tracking",
  schedule: "0 */6 * * *",
};

const MAX_TRACKING_AGE_DAYS = 45;
const BATCH_LIMIT = 200;
const LOCK_KEY = "refresh-delivery-tracking";

interface DeliveryRow {
  id: string;
  provider: string | null;
  provider_object_id: string | null;
  carrier: string | null;
  tracking_number: string;
  status: DeliveryStatus;
  /** Per-box labels (multi-piece shipments). Empty/missing → master only. */
  packages: { tracking_number?: string | null }[] | null;
}

/**
 * Aggregate per-box probes: the LEAST-advanced box defines the shipment.
 * `delivered` only when EVERY box is delivered — a multi-piece shipment stays
 * In Transit until the last package lands. Boxes with no info (pending/
 * unavailable/error) block the delivered aggregate but don't regress anything.
 */
export function aggregateBoxStatuses(
  mapped: (DeliveryStatus | null)[]
): DeliveryStatus | null {
  if (mapped.length === 0) return null;
  if (mapped.every((s) => s === "delivered")) return "delivered";
  if (mapped.some((s) => s === "in_transit" || s === "delivered")) {
    return "in_transit";
  }
  return null;
}

export default async function refreshDeliveryTracking(
  container: MedusaContainer
) {
  if (isScheduledJobsDisabled(container)) return;

  const logger = container.resolve("logger");
  const pool = getDbPool();
  const lock = await pool.connect();
  try {
    const got = await lock.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
      [LOCK_KEY]
    );
    if (!got.rows[0]?.locked) {
      logger.info("[delivery-tracking] previous run still active — skipping");
      return;
    }

    const { rows } = await pool.query<DeliveryRow>(
      `SELECT id, provider, provider_object_id, carrier, tracking_number, status,
              metadata->'packages' AS packages
         FROM order_delivery
        WHERE deleted_at IS NULL
          AND voided_at IS NULL
          AND tracking_number IS NOT NULL
          AND status NOT IN ('delivered','canceled')
          AND created_at > now() - interval '${MAX_TRACKING_AGE_DAYS} days'
          AND (
            status NOT IN ('exception','failed')
            OR status_checked_at IS NULL
            OR status_checked_at < now() - interval '24 hours'
          )
        ORDER BY status_checked_at ASC NULLS FIRST
        LIMIT ${BATCH_LIMIT}`
    );
    if (rows.length === 0) {
      logger.info("[delivery-tracking] nothing to poll");
      return;
    }

    let updated = 0;
    let errors = 0;
    for (const row of rows) {
      try {
        // Multi-piece shipments: poll EVERY box's tracking — the shipment is
        // only delivered when the last package lands.
        const trackingNumbers = [
          ...new Set(
            (row.packages ?? [])
              .map((p) => p.tracking_number)
              .filter((t): t is string => Boolean(t))
          ),
        ];
        if (trackingNumbers.length === 0) trackingNumbers.push(row.tracking_number);

        const details: string[] = [];
        let aggregate: DeliveryStatus | null = null;
        let providerDeliveredAt: string | null = null;

        // Providers with their own status probe (Uber: courier dispatch, no
        // parcel tracking number) are polled via adapter.getStatus — ONE trip
        // per delivery, box aggregation doesn't apply. Parcel carriers fall
        // through to the tracking-number lookup below.
        const statusAdapter = (() => {
          if (!row.provider || !row.provider_object_id) return null;
          try {
            const a = getDispatchAdapter(row.provider);
            return a.getStatus ? a : null;
          } catch {
            return null; // unregistered/unconfigured → carrier fallback
          }
        })();

        if (statusAdapter?.getStatus && row.provider_object_id) {
          const probe = await statusAdapter.getStatus(row.provider_object_id);
          aggregate = probe.status;
          providerDeliveredAt = probe.delivered_at;
          if (probe.detail) details.push(probe.detail);
        } else {
          const mappedPerBox: (DeliveryStatus | null)[] = [];
          for (const tn of trackingNumbers) {
            const probe = await fetchCarrierEta(row.carrier ?? "Auto", tn);
            mappedPerBox.push(deliveryStatusFromCarrier(probe.status));
            if (probe.detail) details.push(probe.detail);
          }
          aggregate = aggregateBoxStatuses(mappedPerBox);
        }

        const next = aggregate ? applyStatusUpdate(row.status, aggregate) : null;
        if (next && next !== row.status) {
          await pool.query(
            `UPDATE order_delivery
                SET status = $2,
                    status_detail = $3,
                    delivered_at = CASE WHEN $2 = 'delivered'
                                        THEN COALESCE(delivered_at, $4::timestamptz, now())
                                        ELSE delivered_at END,
                    status_checked_at = now(),
                    updated_at = now()
              WHERE id = $1`,
            [row.id, next, details.slice(0, 3).join(" | ") || null, providerDeliveredAt]
          );
          updated += 1;
        } else {
          await pool.query(
            `UPDATE order_delivery SET status_checked_at = now() WHERE id = $1`,
            [row.id]
          );
        }
      } catch (err) {
        errors += 1;
        logger.warn(
          `[delivery-tracking] ${row.id} (${row.tracking_number}): ${err instanceof Error ? err.message : err}`
        );
      }
    }
    logger.info(
      `[delivery-tracking] ✓ done — ${rows.length} polled, ${updated} advanced, ${errors} errors`
    );
  } finally {
    await lock
      .query(`SELECT pg_advisory_unlock(hashtext($1))`, [LOCK_KEY])
      .catch(() => undefined);
    lock.release();
  }
}
