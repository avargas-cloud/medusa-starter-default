import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import {
  ContainerRegistrationKeys,
  getVariantAvailability,
} from "@medusajs/framework/utils";
import { z } from "zod";

import { resolveBomSkus } from "../../../lib/bom";
import { StockAlertService } from "../../../lib/stock-alerts";
import { getDbPool } from "../../utils/db-pool";

const bodySchema = z.object({
  sku: z.string().min(1).max(120),
  source_app: z.enum(["backlighting", "linear-lighting"]).nullable().optional(),
});

/**
 * POST /store/stock-alerts { sku } → { ok, status: 'pending' | 'already' }
 *
 * "Avisame cuando vuelva el stock" desde el BOM de las apps embebidas
 * (user-stated 2026-09-11). Sólo cliente autenticado (middleware); el email
 * sale de SU registro, nunca del body. El SKU se resuelve como en sync-bom
 * (variante publicada del canal de la publishable key): lo que no se vende
 * online contesta 404 `not_sold`; lo que ya tiene stock contesta 409
 * `in_stock` (no hay nada que esperar). Idempotente por (cliente, variante).
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const customerId = (req as { auth_context?: { actor_id?: string } })
    .auth_context?.actor_id;
  if (!customerId)
    return res
      .status(401)
      .json({ error: "Unauthorized", code: "UNAUTHENTICATED" });

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success)
    return res
      .status(400)
      .json({ error: "Invalid payload", code: "INVALID_ALERT" });

  const ctx = (
    req as { publishable_key_context?: { sales_channel_ids?: string[] } }
  ).publishable_key_context;
  const salesChannelId = ctx?.sales_channel_ids?.[0] ?? null;
  const db = getDbPool();

  const customer = await db.query<{ email: string | null }>(
    `SELECT email FROM customer WHERE id = $1 AND deleted_at IS NULL`,
    [customerId]
  );
  const email = customer.rows[0]?.email?.trim();
  if (!email)
    return res
      .status(400)
      .json({ error: "Your account has no email", code: "NO_EMAIL" });

  const resolved = await resolveBomSkus(db, [parsed.data.sku], salesChannelId);
  const variant = resolved.get(parsed.data.sku);
  if (!variant)
    return res.status(404).json({ error: "Not sold online", code: "not_sold" });

  if (salesChannelId) {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
    const availability = (await getVariantAvailability(query, {
      variant_ids: [variant.variantId],
      sales_channel_id: salesChannelId,
    })) as Record<string, { availability: number | null }>;
    const flags = await db.query<{
      manage_inventory: boolean | null;
      allow_backorder: boolean | null;
    }>(
      `SELECT manage_inventory, allow_backorder FROM product_variant WHERE id = $1`,
      [variant.variantId]
    );
    const f = flags.rows[0];
    const managed =
      f?.manage_inventory !== false && f?.allow_backorder !== true;
    const level = availability[variant.variantId]?.availability ?? 0;
    if (!managed || level > 0)
      return res
        .status(409)
        .json({ error: "In stock right now", code: "in_stock" });
  }

  const result = await StockAlertService.createAlert(db, {
    customerId,
    email,
    variantId: variant.variantId,
    sku: variant.sku,
    sourceApp: parsed.data.source_app ?? null,
  });
  res.set("Cache-Control", "no-store");
  return res.json({ ok: true, status: result.status, sku: variant.sku });
};
