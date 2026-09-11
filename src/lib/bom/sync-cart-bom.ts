import {
  addToCartWorkflow,
  deleteLineItemsWorkflow,
  updateCartWorkflow,
} from "@medusajs/core-flows";
import type { MedusaContainer } from "@medusajs/framework/types";

import { getDbPool } from "../../api/utils/db-pool";

import { cartLinkMetadata, lineProvenance, normalizeBomLines } from "./normalize";
import { resolveBomSkus, type BomDb } from "./resolve-bom-skus";
import {
  SyncCartBomError,
  type SyncCartBomInput,
  type SyncCartBomResult,
  type UnresolvedBomLine,
} from "./types";

interface CartRow {
  id: string;
  customer_id: string | null;
  sales_channel_id: string | null;
  completed_at: Date | null;
  deleted_at: Date | null;
  metadata: Record<string, unknown> | null;
}

/**
 * BOM de un proyecto → carrito de la web. Semántica de REEMPLAZO: se borran
 * las líneas que este proyecto ya había puesto en el carrito y se cargan las
 * del BOM actual. Un carrito no tiene pisos de facturado/entregado (eso es lo
 * que obliga al POS a reconciliar línea por línea con `planBomSync`), así que
 * borrar-y-cargar es idempotente y no puede dejar una línea vieja colgada.
 *
 * Lo que NO hace: tocar líneas que el cliente agregó a mano (no llevan
 * `source_project_id`), ni líneas de OTRO proyecto en el mismo carrito.
 *
 * Cada línea se agrega en su propio workflow: si una variante no tiene stock,
 * esa línea vuelve como `unavailable` y las demás entran. El cliente ve qué
 * le faltó en vez de un carrito vacío con un 500.
 */
export async function syncCartBom(
  container: MedusaContainer,
  input: SyncCartBomInput,
  db: BomDb = getDbPool()
): Promise<SyncCartBomResult> {
  const lines = normalizeBomLines(input.app, input.projectId, input.lines);

  const cartRes = await db.query<CartRow>(
    `SELECT id, customer_id, sales_channel_id, completed_at, deleted_at, metadata
       FROM cart WHERE id = $1`,
    [input.cartId]
  );
  const cart = cartRes.rows[0];
  if (!cart || cart.deleted_at) {
    throw new SyncCartBomError(404, "CART_NOT_FOUND", "Cart not found");
  }
  if (cart.completed_at) {
    throw new SyncCartBomError(409, "CART_COMPLETED", "Cart is already completed");
  }
  // El carrito es del cliente autenticado o de nadie todavía; nunca de otro.
  if (cart.customer_id && cart.customer_id !== input.customerId) {
    throw new SyncCartBomError(409, "CART_CUSTOMER_MISMATCH", "Cart belongs to another customer");
  }
  if (!cart.customer_id) {
    await updateCartWorkflow(container).run({
      input: { id: cart.id, customer_id: input.customerId },
    });
  }

  const resolved = await resolveBomSkus(
    db,
    lines.map((l) => l.sku),
    cart.sales_channel_id
  );
  const unresolved: UnresolvedBomLine[] = [];

  // 1. Borrar lo que este proyecto ya había puesto.
  const existingRes = await db.query<{ id: string }>(
    `SELECT id FROM cart_line_item
      WHERE cart_id = $1
        AND deleted_at IS NULL
        AND metadata->>'source_app' = $2
        AND metadata->>'source_project_id' = $3`,
    [cart.id, input.app, input.projectId]
  );
  const removed = existingRes.rows.length;
  if (removed > 0) {
    await deleteLineItemsWorkflow(container).run({
      input: { cart_id: cart.id, ids: existingRes.rows.map((r) => r.id) },
    });
  }

  // 2. Cargar el BOM actual, línea por línea.
  let added = 0;
  for (const line of lines) {
    const variant = resolved.get(line.sku);
    if (!variant) {
      unresolved.push({ sku: line.sku, quantity: line.quantity, reason: "not_found" });
      continue;
    }
    try {
      await addToCartWorkflow(container).run({
        input: {
          cart_id: cart.id,
          items: [
            {
              variant_id: variant.variantId,
              quantity: line.quantity,
              metadata: lineProvenance(input.app, input.projectId, line),
            },
          ],
        },
      });
      added += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[sync-bom] ${line.sku} x${line.quantity} unavailable: ${message}`);
      unresolved.push({
        sku: line.sku,
        quantity: line.quantity,
        reason: "unavailable",
        message: message.slice(0, 200),
      });
    }
  }

  // 3. El vínculo proyecto↔carrito, que la orden hereda al completar.
  //    Read-modify-write: nunca se pisa lo que otro ya escribió en metadata.
  const metadata = {
    ...(cart.metadata ?? {}),
    ...cartLinkMetadata(input.app, input.projectId, input.projectSeq),
  };
  await updateCartWorkflow(container).run({ input: { id: cart.id, metadata } });

  console.log(
    `[sync-bom] cart ${cart.id} ← ${input.app}:${input.projectId} added=${added} removed=${removed} unresolved=${unresolved.length}`
  );
  return {
    cart_id: cart.id,
    app: input.app,
    project_id: input.projectId,
    added,
    removed,
    unresolved,
    metadata,
  };
}
