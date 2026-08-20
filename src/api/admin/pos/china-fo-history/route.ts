import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";
import { purchaseCostDollars } from "../../../../lib/cost/cost-sql";

/**
 * GET /admin/pos/china-fo-history
 *
 * Whole-warehouse feed for the Inventory Timeline FO-history export: every FO
 * receipt into China, every transfer shipped out of China, and every manual
 * China adjustment — for ALL variants at once. This is the same three sources
 * `china-product-history` reads for one variant; the FIFO attribution of
 * transfers to FO rows happens client-side in the shared export lib
 * (store-pos/lib/china-fo-history-export.ts), so the sheet and its tests share
 * one derivation.
 *
 * Read-only. Cost is the FACTORY cost (factory_order_line.unit_cost_cents,
 * receipt-line override first) — the number the China agent's own ledger sees;
 * our freight never enters this comparison.
 *
 * `stock` and `manual_lots` exist because FO receipts alone under-cover the
 * warehouse: a large share of China stock predates the FO system (the timeline's
 * MANUAL lots + unattributed surplus). The export lib reconciles its FIFO
 * pending against `stock`'s physical China (stocked − in-transit, the same
 * arithmetic as reports/inventory-timeline) and surfaces the residual through
 * the manual lots / UNATTRIBUTED / DEFICIT rows — so the On Hand sheet covers
 * every SKU with units in China, not just the FO-era ones. `purchase_cost`
 * (variant metadata, dollars — the China valuation basis, via cost-sql) values
 * those rows, which have no FO line to take a cost from.
 */

const CHINA_LOCATION_ID = "sloc_01KQ14C1CFX30EDD722BF87HDM";

type RawConnection = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

const toInt = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const pg = req.scope.resolve(
    ContainerRegistrationKeys.PG_CONNECTION
  ) as RawConnection;

  // Units on shipped-but-not-received CN transfers: physically left China but
  // still carried in stocked_quantity (stock only drops at RECEIVE). Mirrors
  // reports/inventory-timeline's IN_TRANSIT_CTE, keyed by variant.
  const IN_TRANSIT_CTE = `
    in_transit AS (
      SELECT itl.product_variant_id AS variant_id,
             SUM(GREATEST(0, itl.qty - COALESCE(itl.qty_received, 0)))::int AS in_transit_qty
        FROM inventory_transfer_line itl
        JOIN inventory_transfer it ON it.id = itl.transfer_id AND it.deleted_at IS NULL
       WHERE itl.deleted_at IS NULL
         AND it.status = 'shipped' AND it.origin_country = 'CN'
       GROUP BY itl.product_variant_id
      HAVING SUM(GREATEST(0, itl.qty - COALESCE(itl.qty_received, 0))) > 0
    )`;

  const [rcRes, trRes, adjRes, stRes, mlRes] = await Promise.all([
    // FO receipt lines INTO China (+qty), applied and non-void, line grain so
    // each arrival keeps its own date. Cost: receipt override wins over the FO
    // line's factory cost.
    pg.raw(
      `SELECT fo.number AS fo_number, fore.number AS receipt_number,
              fore.received_at,
              forl.product_variant_id AS variant_id,
              COALESCE(pv.sku, forl.sku_snapshot) AS sku,
              forl.qty_received_now::int AS qty,
              COALESCE(forl.unit_cost_cents_override, fol.unit_cost_cents)::int
                AS unit_cost_cents
         FROM factory_order_receipt_line forl
         JOIN factory_order_receipt fore ON fore.id = forl.factory_order_receipt_id
         JOIN factory_order fo ON fo.id = forl.factory_order_id
         JOIN factory_order_line fol ON fol.id = forl.factory_order_line_id
         LEFT JOIN product_variant pv
           ON pv.id = forl.product_variant_id AND pv.deleted_at IS NULL
        WHERE forl.deleted_at IS NULL AND fore.deleted_at IS NULL
          AND fo.deleted_at IS NULL AND fol.deleted_at IS NULL
          AND fore.status = 'applied' AND fore.voided_at IS NULL
          AND fore.stock_location_id = ?
          AND COALESCE(forl.qty_received_now, 0) <> 0
        ORDER BY fore.received_at ASC, fo.number ASC, forl.id ASC`,
      [CHINA_LOCATION_ID]
    ),
    // Transfers shipped OUT of China (−qty), one row per transfer × variant.
    pg.raw(
      `SELECT it.number AS transfer_number, it.shipped_at,
              itl.product_variant_id AS variant_id, MIN(itl.sku) AS sku,
              SUM(itl.qty)::int AS qty
         FROM inventory_transfer_line itl
         JOIN inventory_transfer it ON it.id = itl.transfer_id
        WHERE itl.deleted_at IS NULL AND it.deleted_at IS NULL
          AND it.origin_country = 'CN' AND it.voided_at IS NULL
          AND it.shipped_at IS NOT NULL
        GROUP BY it.id, it.number, it.shipped_at, itl.product_variant_id
        ORDER BY it.shipped_at ASC, it.number ASC`,
      []
    ),
    // Manual China adjustments (±delta), keyed to the variant via the
    // inventory-item link table.
    pg.raw(
      `SELECT ca.created_at, pvii.variant_id, cl.delta::int AS delta
         FROM china_adjustment_line cl
         JOIN china_adjustment ca ON ca.id = cl.china_adjustment_id
         JOIN product_variant_inventory_item pvii
           ON pvii.inventory_item_id = cl.inventory_item_id
          AND pvii.deleted_at IS NULL
        WHERE ca.voided_at IS NULL AND COALESCE(cl.delta, 0) <> 0
        ORDER BY ca.created_at ASC`,
      []
    ),
    // Live China stock per variant + the factory-cost fallback for rows that
    // have no FO line to price from.
    pg.raw(
      `WITH ${IN_TRANSIT_CTE}
       SELECT pvii.variant_id, pv.sku,
              il.stocked_quantity::int AS stocked,
              COALESCE(itr.in_transit_qty, 0) AS in_transit,
              ${purchaseCostDollars("pv")} AS purchase_cost,
              NULLIF(NULLIF(pv.metadata->>'average_cost', ''), '0')::numeric
                AS average_cost
         FROM inventory_level il
         JOIN product_variant_inventory_item pvii
           ON pvii.inventory_item_id = il.inventory_item_id AND pvii.deleted_at IS NULL
         JOIN product_variant pv ON pv.id = pvii.variant_id AND pv.deleted_at IS NULL
         LEFT JOIN in_transit itr ON itr.variant_id = pvii.variant_id
        WHERE il.location_id = ? AND il.deleted_at IS NULL
          AND (il.stocked_quantity <> 0 OR itr.in_transit_qty IS NOT NULL)`,
      [CHINA_LOCATION_ID]
    ),
    // Operator-assigned manual lots over unattributed legacy stock.
    pg.raw(
      `SELECT pvii.variant_id, ii.metadata->'china_manual_lots' AS lots
         FROM inventory_item ii
         JOIN product_variant_inventory_item pvii
           ON pvii.inventory_item_id = ii.id AND pvii.deleted_at IS NULL
        WHERE ii.deleted_at IS NULL AND ii.metadata->'china_manual_lots' IS NOT NULL`,
      []
    ),
  ]);

  const receipts = (rcRes.rows as Record<string, unknown>[]).map((r) => ({
    fo_number: String(r.fo_number ?? ""),
    receipt_number: r.receipt_number != null ? String(r.receipt_number) : null,
    received_at: r.received_at,
    variant_id: String(r.variant_id ?? ""),
    sku: String(r.sku ?? ""),
    qty: toInt(r.qty),
    unit_cost_cents: toInt(r.unit_cost_cents),
  }));
  const transfers = (trRes.rows as Record<string, unknown>[]).map((r) => ({
    transfer_number: r.transfer_number != null ? String(r.transfer_number) : null,
    shipped_at: r.shipped_at,
    variant_id: String(r.variant_id ?? ""),
    sku: String(r.sku ?? ""),
    qty: toInt(r.qty),
  }));
  const adjustments = (adjRes.rows as Record<string, unknown>[]).map((r) => ({
    created_at: r.created_at,
    variant_id: String(r.variant_id ?? ""),
    delta: toInt(r.delta),
  }));
  const stock = (stRes.rows as Record<string, unknown>[]).map((r) => {
    const cost = r.purchase_cost != null ? Number(r.purchase_cost) : NaN;
    const avg = r.average_cost != null ? Number(r.average_cost) : NaN;
    return {
      variant_id: String(r.variant_id ?? ""),
      sku: String(r.sku ?? ""),
      stocked: toInt(r.stocked),
      in_transit: toInt(r.in_transit),
      purchase_cost: Number.isFinite(cost) ? cost : null,
      average_cost: Number.isFinite(avg) ? avg : null,
    };
  });
  const manual_lots = (mlRes.rows as Record<string, unknown>[]).flatMap((r) => {
    const variantId = String(r.variant_id ?? "");
    if (!variantId || !Array.isArray(r.lots)) return [];
    return (r.lots as unknown[])
      .map((raw) => {
        const l = raw as Record<string, unknown>;
        return {
          variant_id: variantId,
          fo_number: String(l.fo_number ?? "").trim(),
          received_at: l.received_at != null ? String(l.received_at) : null,
          qty: Math.max(0, Math.round(Number(l.qty ?? 0))),
        };
      })
      .filter((l) => l.fo_number && l.qty > 0);
  });

  return res.json({ receipts, transfers, adjustments, stock, manual_lots });
}
