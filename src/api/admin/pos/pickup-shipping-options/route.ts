/**
 * GET /admin/pos/pickup-shipping-options
 *
 * The shipping options that are PICKUP by Medusa's own structure — the same
 * split the admin Locations screen renders as its "Pickup" vs "Shipping"
 * blocks: shipping_option → service_zone → fulfillment_set.type = 'pickup'.
 *
 * This is the native discriminator. Never match on option/method NAMES —
 * renaming "Miami Store Pickup" must not change behavior (owner requirement
 * 2026-08-07). The POS gates the Delivery button (and offers Mark as Picked
 * Up) off this list, keyed by the order's shipping_option_id, so it reacts
 * live to an unsaved picker change too.
 */
import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../../utils/db-pool";

export async function GET(
  _req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { rows } = await getDbPool().query<{ id: string }>(
    `SELECT so.id
       FROM shipping_option so
       JOIN service_zone sz ON sz.id = so.service_zone_id AND sz.deleted_at IS NULL
       JOIN fulfillment_set fs ON fs.id = sz.fulfillment_set_id AND fs.deleted_at IS NULL
      WHERE so.deleted_at IS NULL
        AND fs.type = 'pickup'`
  );
  return res.json({ pickup_option_ids: rows.map((r) => r.id) });
}
