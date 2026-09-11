import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";

import { syncCartBom, SyncCartBomError } from "../../../../../lib/bom";

/**
 * POST /store/carts/:id/sync-bom
 *
 * El BOM de un proyecto de Backlighting / Linear Lighting entra al carrito de
 * la web. Cliente AUTENTICADO (matcher en api/middlewares.ts:
 * `authenticate("customer", ["session","bearer"])`): el proyecto es de alguien
 * y el candado de la orden necesita saber de quién. El `customer_id` sale del
 * `auth_context`, nunca del body.
 *
 * Reemplaza las líneas que este proyecto ya había puesto (por
 * `source_project_id`) y deja el vínculo en `cart.metadata`, que la orden
 * hereda al completar. Las SKUs que no existen publicadas o no tienen stock
 * vuelven en `unresolved` con su motivo — la app se lo muestra al cliente.
 */
const bodySchema = z.object({
  source_app: z.enum(["backlighting", "linear-lighting"]),
  project_id: z.string().min(1).max(120),
  project_seq: z.string().min(1).max(40).nullable().optional(),
  lines: z
    .array(
      z.object({
        sku: z.string().min(1).max(120),
        quantity: z.number().int().positive().max(10_000),
      })
    )
    .max(200),
});

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const customerId = (req as { auth_context?: { actor_id?: string } }).auth_context?.actor_id;
  if (!customerId) {
    return res.status(401).json({ error: "Unauthorized", code: "UNAUTHENTICATED" });
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid BOM payload",
      code: "INVALID_BOM",
      details: parsed.error.issues.slice(0, 10),
    });
  }

  try {
    const result = await syncCartBom(req.scope, {
      cartId: req.params.id as string,
      customerId,
      app: parsed.data.source_app,
      projectId: parsed.data.project_id,
      projectSeq: parsed.data.project_seq ?? null,
      lines: parsed.data.lines,
    });
    return res.json(result);
  } catch (error) {
    if (error instanceof SyncCartBomError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[sync-bom] ❌ cart ${req.params.id}: ${message}`);
    return res.status(500).json({ error: "Failed to sync BOM into cart", code: "SYNC_FAILED" });
  }
};
