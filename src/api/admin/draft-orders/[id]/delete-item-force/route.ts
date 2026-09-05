import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { Modules } from "@medusajs/utils";

import { getDbPool } from "../../../../utils/db-pool";
import { floorDenial, loadLineFloors } from "../../../orders/[id]/_lib/line-floors";

/**
 * DELETE /admin/draft-orders/:id/delete-item-force
 * POST   /admin/draft-orders/:id/delete-item-force  (POS compat alias)
 *
 * Hard-deletes a line item — physically removes the record from the DB.
 *
 * Body: { line_item_id: string }
 * Query param: ?line_item_id=xxx  (fallback)
 */
async function handleDelete(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const body = req.body as Record<string, any> | undefined;
  const line_item_id: string | undefined =
    body?.line_item_id ?? (req.query?.line_item_id as string | undefined);

  if (!line_item_id) {
    res.status(400).json({ message: "line_item_id is required" });
    return;
  }


  // ── El piso, y a quién pertenece la línea (2026-09-05) ────────────────────
  //
  // Esta ruta es la GEMELA de `orders/[id]/delete-item-force`, y hasta hoy no
  // miraba nada: no leía `req.params.id` (el `:id` del path era decorativo — el
  // handler tomaba el `line_item_id` del body y borraba), no verificaba
  // `is_draft_order`, y el middleware `protectClosedDocument` sólo tiene matcher
  // para `/admin/orders/`. Draft y orden confirmada viven en la MISMA tabla, así
  // que el guard del piso se salteaba cambiando un segmento del path. Reproducido
  // contra el sandbox: la misma línea facturada daba 409 por `orders/` y 200 por
  // acá, y quedaba borrada.
  //
  // No se rechaza "porque no es draft": eso rompería el guardado de una pestaña
  // vieja de un estimate ya convertido, caso que `sync-pos` nombra explícitamente.
  // Se aplica el MISMO piso, que para un estimate genuino siempre es 0 — medido
  // el 2026-09-05: de 1.876 líneas de estimates, CERO tienen piso. O sea que este
  // guard no puede cambiar el comportamiento de ningún estimate real; sólo muerde
  // cuando por acá llega una orden confirmada, que es exactamente el abuso.
  const floors = await loadLineFloors(getDbPool(), String(req.params.id));

  // Y de paso el `:id` pasa a significar algo: una línea que no está entre las
  // de esta orden no se toca. Sin esto, `floorDenial(undefined)` deja pasar y
  // se puede operar sobre la línea de OTRA orden.
  if (!floors.has(line_item_id)) {
    res.status(409).json({
      error: "Esa línea no pertenece a este documento.",
      code: "LINE_NOT_IN_ORDER",
      line_item_id,
    });
    return;
  }

  const denial = floorDenial(floors.get(line_item_id), null, { deleting: true });
  if (denial) {
    res.status(409).json(denial);
    return;
  }

  try {
    const orderModule = req.scope.resolve(Modules.ORDER) as any;

    // Hard delete — physically removes the row from order_line_item
    if (typeof orderModule.deleteOrderLineItems === "function") {
      await orderModule.deleteOrderLineItems([line_item_id]);
      console.log("[delete-item-force] hard-deleted:", line_item_id);
      res.status(200).json({ success: true });
      return;
    }

    // Fallback: soft-delete (better than qty=0)
    if (typeof orderModule.softDeleteOrderLineItems === "function") {
      await orderModule.softDeleteOrderLineItems([line_item_id]);
      console.log("[delete-item-force] soft-deleted:", line_item_id);
      res.status(200).json({ success: true, method: "softDelete" });
      return;
    }

    res
      .status(500)
      .json({ message: "No delete method available on order module" });
  } catch (e: any) {
    console.error("[delete-item-force]", e?.message);
    res.status(500).json({ message: e?.message ?? "Failed to delete item" });
  }
}

export const DELETE = handleDelete;
export const POST = handleDelete; // POS calls via POST, admin panel via DELETE
