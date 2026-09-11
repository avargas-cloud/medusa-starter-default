import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys, getVariantAvailability } from "@medusajs/framework/utils";

import { getDbPool } from "../../../utils/db-pool";
import { resolveBomSkus } from "../../../../lib/bom";
import { classifyAvailability, type BomAvailabilityItem } from "../../../../lib/bom/availability";

/**
 * GET /store/bom/availability?skus=A,B,C → { sales_channel_id, items[] }
 *
 * Disponibilidad de cada SKU para el carrito de la web, dicha ANTES de
 * apretar Add to Cart (user-stated 2026-09-11): `ok` entra; `out_of_stock`
 * gestiona inventario y no tiene unidades en las ubicaciones del canal;
 * `not_sold` no resuelve a una variante publicada del canal. Misma resolución
 * que `POST /store/carts/:id/sync-bom` y misma regla de stock que el carrito.
 *
 * El canal sale de la publishable key de la request (el de la web). Sin canal
 * en la key no se inventa uno: se contesta con `not_sold`/`ok` sólo por
 * publicación y sin stock (available null).
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const raw = typeof req.query.skus === "string" ? req.query.skus : "";
  const skus = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))].slice(0, 200);
  if (skus.length === 0) {
    return res.status(400).json({ error: "skus required", code: "INVALID_SKUS" });
  }
  const ctx = (req as { publishable_key_context?: { sales_channel_ids?: string[] } }).publishable_key_context;
  const salesChannelId = ctx?.sales_channel_ids?.[0] ?? null;

  const db = getDbPool();
  const resolved = await resolveBomSkus(db, skus, salesChannelId);
  const variantIds = [...new Set([...resolved.values()].map((v) => v.variantId))];

  const flags = new Map<string, { manageInventory: boolean; allowBackorder: boolean }>();
  if (variantIds.length > 0) {
    const rows = await db.query<{ id: string; manage_inventory: boolean | null; allow_backorder: boolean | null }>(
      `SELECT id, manage_inventory, allow_backorder FROM product_variant WHERE id = ANY($1::text[])`,
      [variantIds]
    );
    for (const r of rows.rows) {
      flags.set(r.id, { manageInventory: r.manage_inventory !== false, allowBackorder: r.allow_backorder === true });
    }
  }

  let availability: Record<string, { availability: number | null }> = {};
  if (variantIds.length > 0 && salesChannelId) {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
    availability = (await getVariantAvailability(query, {
      variant_ids: variantIds,
      sales_channel_id: salesChannelId,
    })) as Record<string, { availability: number | null }>;
  }

  const items: BomAvailabilityItem[] = skus.map((sku) => {
    const variant = resolved.get(sku);
    if (!variant) return { sku, status: "not_sold", available: null };
    const f = flags.get(variant.variantId) ?? { manageInventory: true, allowBackorder: false };
    const level = availability[variant.variantId]?.availability;
    const verdict = classifyAvailability({
      manageInventory: f.manageInventory,
      allowBackorder: f.allowBackorder,
      // Sin canal no hay stock que mirar: no se afirma "sin stock" por un dato que falta.
      available: salesChannelId ? (typeof level === "number" ? level : 0) : null,
    });
    return { sku, status: salesChannelId ? verdict.status : "ok", available: verdict.available };
  });

  res.set("Cache-Control", "no-store");
  return res.json({ sales_channel_id: salesChannelId, items });
};
