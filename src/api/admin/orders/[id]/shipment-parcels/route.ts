/**
 * POST /admin/orders/:id/shipment-parcels
 *
 * Suggest the package boxes for a shipment — the DispatchModal prefill.
 * Reuses the SAME packing engine the web checkout uses (modules/box-packing:
 * long items >30" split into bundles capped at 70 lb / 12 in² cross-section —
 * LED channels get their own tube boxes, capacity per model emerges from each
 * profile's real W×H; regular items pack volumetrically into XS→XXL).
 *
 * Dims per unit resolve like Freight Specs: product_variant.metadata.shipping_*
 * (EXACT source of truth, read as text and coerced in TS) → inventory_item →
 * native variant columns → modest default.
 *
 * Body: items?: { id: string; quantity: number }[]  (order line items;
 *       default = pending fulfillment's items, else all unfulfilled)
 * Returns: { parcels: DispatchParcel[], resolved_items, missing_dims_skus }
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { packItems } from "../../../../../modules/box-packing";
import { getDbPool } from "../../../../utils/db-pool";
import {
  findPendingFulfillment,
  loadUnfulfilledItems,
  type ShipItem,
} from "../create-shipment/_lib/resolve";

interface DimsRow {
  id: string;
  sku: string | null;
  m_len: string | null;
  m_wid: string | null;
  m_hei: string | null;
  m_wei: string | null;
  ii_len: string | null;
  ii_wid: string | null;
  ii_hei: string | null;
  ii_wei: string | null;
  pv_len: string | null;
  pv_wid: string | null;
  pv_hei: string | null;
  pv_wei: string | null;
}

/** First positive finite number in the fallback chain, else the default. */
function pick(def: number, ...vals: (string | null)[]): number {
  for (const v of vals) {
    if (v == null) continue;
    const n = parseFloat(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return def;
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const orderId = req.params.id as string;
  const body = (req.body ?? {}) as { items?: ShipItem[] };
  const pool = getDbPool();

  try {
    let items: ShipItem[] | undefined = body.items?.length ? body.items : undefined;
    if (!items) {
      const pending = await findPendingFulfillment(pool, orderId);
      items = pending && pending.items.length > 0
        ? pending.items
        : await loadUnfulfilledItems(pool, orderId);
    }
    if (!items.length) {
      return res.status(409).json({
        code: "nothing_to_ship",
        message: "No pending fulfillment and no unfulfilled items on this order",
      });
    }

    const qtyByLine = new Map(items.map((i) => [i.id, i.quantity]));
    const { rows } = await pool.query<DimsRow>(
      `SELECT DISTINCT ON (oli.id)
              oli.id,
              pv.sku,
              pv.metadata->>'shipping_length' AS m_len,
              pv.metadata->>'shipping_width'  AS m_wid,
              pv.metadata->>'shipping_height' AS m_hei,
              pv.metadata->>'shipping_weight' AS m_wei,
              ii.length::text AS ii_len, ii.width::text AS ii_wid,
              ii.height::text AS ii_hei, ii.weight::text AS ii_wei,
              pv.length::text AS pv_len, pv.width::text AS pv_wid,
              pv.height::text AS pv_hei, pv.weight::text AS pv_wei
         FROM order_line_item oli
         LEFT JOIN product_variant pv ON pv.id = oli.variant_id AND pv.deleted_at IS NULL
         LEFT JOIN product_variant_inventory_item pvii
                ON pvii.variant_id = pv.id AND pvii.deleted_at IS NULL
         LEFT JOIN inventory_item ii ON ii.id = pvii.inventory_item_id AND ii.deleted_at IS NULL
        WHERE oli.id = ANY($1)
        ORDER BY oli.id`,
      [items.map((i) => i.id)]
    );

    const missingDims: string[] = [];
    const packInput = rows.map((r) => {
      const length = pick(0, r.m_len, r.ii_len, r.pv_len);
      const width = pick(0, r.m_wid, r.ii_wid, r.pv_wid);
      const height = pick(0, r.m_hei, r.ii_hei, r.pv_hei);
      const weight = pick(0, r.m_wei, r.ii_wei, r.pv_wei);
      if (!length || !width || !height || !weight) {
        missingDims.push(r.sku ?? r.id);
      }
      return {
        // Modest defaults for unmeasured SKUs — the cashier edits anyway.
        length: length || 6,
        width: width || 4,
        height: height || 2,
        weight: weight || 1,
        quantity: qtyByLine.get(r.id) ?? 1,
      };
    });

    const packages = packItems(packInput);
    return res.json({
      parcels: packages.map((p) => ({
        length_in: Math.round(p.length * 100) / 100,
        width_in: Math.round(p.width * 100) / 100,
        height_in: Math.round(p.height * 100) / 100,
        weight_lb: Math.max(0.1, Math.round(p.weight * 100) / 100),
      })),
      resolved_items: rows.length,
      missing_dims_skus: missingDims,
    });
  } catch (err) {
    console.error("[shipment-parcels]", err);
    return res.status(500).json({
      code: "unknown",
      message: err instanceof Error ? err.message : "Failed to suggest parcels",
    });
  }
}
