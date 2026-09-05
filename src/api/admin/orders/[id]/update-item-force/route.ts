import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { assertOrderEditable } from "../_lib/assert-order-editable";
import { assertWebOrderAuthorized } from "../_lib/assert-web-order-authorized";
import { Modules } from "@medusajs/utils";
import { getDbPool } from "../../../../utils/db-pool";
import { floorDenial, loadLineFloors } from "../_lib/line-floors";

/**
 * POST /admin/draft-orders/:id/update-item-force
 *
 * Updates quantity and/or unit_price of an existing line item in a draft order
 * WITHOUT going through the order-edit workflow (which silently fails for draft orders).
 *
 * Uses orderModule.updateOrderLineItems() directly — pure data layer,
 * bypasses workflow validation including inventory checks.
 *
 * Body: { line_item_id: string, quantity?: number, unit_price?: number, sort_order?: number }
 *
 * NOTE: unit_price should be in DOLLARS (decimal), matching Medusa v2 API convention.
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const archivedBlock = await assertOrderEditable(req.scope, String(req.params.id));
  if (archivedBlock) {
    res.status(409).json({ error: archivedBlock, code: "ORDER_ARCHIVED" });
    return;
  }

  // Una orden que vino de la WEB exige PIN de supervisor para editarse. El gate
  // vivia solo en la pantalla (useWebOrderLock) y comparaba en el navegador, asi
  // que un POST directo a esta ruta la editaba sin encontrar ninguna puerta.
  const webAuth = await assertWebOrderAuthorized(req.scope, String(req.params.id), req);
  if (webAuth.denial) {
    res.status(webAuth.denial.status).json(webAuth.denial.body);
    return;
  }
  const {
    line_item_id,
    quantity,
    unit_price,
    sort_order,
    line_discount,
    original_unit_price,
    custom_title,
    custom_description,
    source_app,
    source_project_id,
    source_key,
  } = req.body as {
    line_item_id: string;
    quantity?: number;
    unit_price?: number; // effective (post-discount) price in DOLLARS
    sort_order?: number; // 0-indexed display position
    line_discount?: { type: "percent" | "fixed"; value: number } | null; // POS discount descriptor
    original_unit_price?: number | null; // pre-discount price for POS rehydration
    custom_title?: string; // User-edited title for "Special Items"
    custom_description?: string; // User-edited description for "Special Items"
    source_app?: string | null; // provenance: originating app ('bl' | 'll')
    source_project_id?: string | null; // provenance: originating project id
    source_key?: string | null; // provenance: BOM row identity (SKU)
  };

  if (!line_item_id) {
    res.status(400).json({ message: "line_item_id is required" });
    return;
  }

  if (
    quantity === undefined &&
    unit_price === undefined &&
    sort_order === undefined &&
    line_discount === undefined &&
    original_unit_price === undefined &&
    custom_title === undefined &&
    custom_description === undefined &&
    source_app === undefined &&
    source_project_id === undefined &&
    source_key === undefined
  ) {
    res
      .status(400)
      .json({ message: "At least one field to update is required" });
    return;
  }

  // La cantidad no puede bajar de lo facturado/entregado (regla del operador
  // 2026-09-05). Se evalua el EFECTO, no el estado: una edicion que no toca la
  // cantidad —titulo, precio, descuento, provenance— nunca se bloquea, y una
  // linea que YA estaba bajo su piso (14 en produccion, dato roto anterior)
  // sigue siendo editable en todo lo que no la baje mas.
  if (quantity !== undefined) {
    const floors = await loadLineFloors(getDbPool(), String(req.params.id));
    const denial = floorDenial(floors.get(line_item_id), quantity);
    if (denial) {
      res.status(409).json(denial);
      return;
    }
  }

  try {
    const orderModule = req.scope.resolve(Modules.ORDER) as any;

    const updateData: Record<string, any> = {};
    if (quantity !== undefined) updateData.quantity = quantity;
    if (unit_price !== undefined) updateData.unit_price = unit_price;
    if (custom_title !== undefined) {
      updateData.title = custom_title;
      updateData.product_title = custom_title; // Keep denormalized field in sync
    }

    // Persist sort_order, line_discount, and original_unit_price in metadata.
    // Always merge with existing metadata to avoid overwriting sales_description or other keys.
    const needsMetadataUpdate =
      sort_order !== undefined ||
      line_discount !== undefined ||
      original_unit_price !== undefined ||
      custom_description !== undefined ||
      source_app !== undefined ||
      source_project_id !== undefined ||
      source_key !== undefined;
    if (needsMetadataUpdate) {
      let existingMeta: Record<string, any> = {};
      if (typeof orderModule.retrieveOrderLineItem === "function") {
        try {
          const existing =
            await orderModule.retrieveOrderLineItem(line_item_id);
          existingMeta = existing?.metadata ?? {};
        } catch {
          /* ignore — will overwrite gracefully */
        }
      }
      updateData.metadata = {
        ...existingMeta,
        ...(sort_order !== undefined ? { sort_order } : {}),
        ...(custom_description !== undefined
          ? { sales_description: custom_description }
          : {}),
        // null explicitly clears the key (discount removed); undefined = no change
        ...(line_discount !== undefined
          ? { line_discount: line_discount ?? null }
          : {}),
        ...(original_unit_price !== undefined
          ? { original_unit_price: original_unit_price ?? null }
          : {}),
        ...(source_app !== undefined ? { source_app: source_app ?? null } : {}),
        ...(source_project_id !== undefined
          ? { source_project_id: source_project_id ?? null }
          : {}),
        ...(source_key !== undefined ? { source_key: source_key ?? null } : {}),
      };
    }
    if (typeof orderModule.updateOrderLineItems === "function") {
      await orderModule.updateOrderLineItems(line_item_id, updateData);
      console.log(
        `[update-item-force] updateOrderLineItems OK: ${line_item_id} → qty=${quantity} price=${unit_price}`
      );
      res.status(200).json({ success: true, method: "updateOrderLineItems" });
      return;
    }

    if (typeof orderModule.updateLineItems === "function") {
      await orderModule.updateLineItems([{ id: line_item_id, ...updateData }]);
      console.log(`[update-item-force] updateLineItems OK: ${line_item_id}`);
      res.status(200).json({ success: true, method: "updateLineItems" });
      return;
    }

    res
      .status(500)
      .json({ message: "No suitable update method found on order module" });
  } catch (e: any) {
    console.error("[update-item-force] Error:", e?.message);
    res.status(500).json({ message: e?.message ?? "Failed to update item" });
  }
}
