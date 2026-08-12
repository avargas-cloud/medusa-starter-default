import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import {
  extractSupervisorPin,
  guardSupervisorPin,
  pinGuardResponse,
  resolveActorId,
} from "../../../../../lib/pos/supervisor-pin-guard";
import type { PinConn } from "../../../../../lib/pos/verify-supervisor-pin";
import {
  WHOLESALE_PRICE_LIST_ID,
  writeVariantPrices,
} from "../../../../../lib/pos/price-write";

interface PriceUpdateBody {
  retail_price: number;
  wholesale_price: number;
  variant_id?: string;
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve("logger");
  const productId = req.params.productId;
  const { retail_price, wholesale_price, variant_id: bodyVariantId } = req.body as PriceUpdateBody;

  if (typeof retail_price !== "number" || typeof wholesale_price !== "number") {
    return res
      .status(400)
      .json({ error: "retail_price and wholesale_price must be numbers" });
  }
  if (retail_price < 0 || wholesale_price < 0) {
    return res.status(400).json({ error: "Prices cannot be negative" });
  }
  if (wholesale_price > retail_price) {
    return res
      .status(400)
      .json({ error: "Wholesale price cannot exceed retail price" });
  }

  // __pg_connection__ is a Knex instance in Medusa v2
  const knex = (req.scope as any).resolve("__pg_connection__");
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);

  // ── Supervisor PIN ──────────────────────────────────────────────────────────
  // Esta ruta escribe el precio retail Y el wholesale de un ítem. Hasta ahora no
  // pedía NADA: el único gate era una comparación de PIN en React dentro de
  // ItemDetailModal, o sea legible con F12 y salteable editando el estado. Y como
  // todo cajero es un usuario admin (así está diseñada la auth del POS), cualquier
  // token válido podía repreciar el catálogo con un POST directo.
  //
  // Va DESPUÉS de la validación de forma a propósito: un body malformado no debe
  // gastar un intento del contador de PIN.
  const guard = await guardSupervisorPin({
    scope: req.scope as unknown as { resolve: (k: string) => unknown },
    db: knex as PinConn,
    pin: extractSupervisorPin(req),
    actorId: resolveActorId(req),
  });
  if (!guard.ok) {
    const { status, body } = pinGuardResponse(guard);
    return res.status(status).json(body);
  }

  try {
    // 1. Get variant + price_set via Medusa graph.
    // Prefer the explicit variant_id from the body; fall back to first variant for backward compat.
    const variantFilters = bodyVariantId
      ? { id: bodyVariantId }
      : { product_id: productId };

    const { data: variants } = await query.graph({
      entity: "product_variant",
      fields: ["id", "price_set.id"],
      filters: variantFilters,
    });

    if (!variants || variants.length === 0) {
      return res
        .status(404)
        .json({ error: "Variant not found for this product" });
    }

    const variant = variants[0] as {
      id: string;
      price_set: { id: string } | { id: string }[] | null;
    };
    const variant_id = variant.id;
    // The graph may return an array when multiple price_sets are linked (data corruption).
    // Normalize to a single id, preferring the first non-empty one.
    const rawPriceSet = variant.price_set;
    const price_set_id = Array.isArray(rawPriceSet)
      ? rawPriceSet[0]?.id
      : rawPriceSet?.id;

    if (!price_set_id) {
      return res
        .status(404)
        .json({ error: "No price set linked to this variant" });
    }

    // 2-4. Write retail + wholesale price rows (shared with the bulk editor).
    const { price_row_count: priceCountAfterWrite } = await writeVariantPrices(
      knex,
      logger,
      price_set_id,
      retail_price,
      wholesale_price
    );

    // 5. Targeted Meilisearch update (wait for indexing before returning)
    try {
      const { data: invItems } = await query.graph({
        entity: "product_variant",
        fields: ["inventory_items.inventory.id"],
        filters: { id: variant_id },
      });

      const invId: string | undefined = (invItems?.[0] as any)
        ?.inventory_items?.[0]?.inventory?.id;
      const docId = invId ?? variant_id;

      const { MeiliSearch } = await import("meilisearch");
      const client = new MeiliSearch({
        host: process.env.MEILISEARCH_HOST!,
        apiKey: process.env.MEILISEARCH_API_KEY!,
      });

      const task = await client.index("inventory").updateDocuments([
        {
          id: docId,
          price: retail_price,
          pricesByList: { [WHOLESALE_PRICE_LIST_ID]: wholesale_price },
        },
      ]);

      await client.tasks.waitForTask(task.taskUid, { timeout: 8000 });
      logger.info(
        `[pos-prices] Meilisearch doc ${docId} updated (taskUid: ${task.taskUid})`
      );
    } catch (meiliErr: unknown) {
      const msg =
        meiliErr instanceof Error ? meiliErr.message : String(meiliErr);
      logger.warn(
        `[pos-prices] Meilisearch update failed (non-blocking): ${msg}`
      );
    }

    // 6. Verify: count price rows to detect zombies (writeVariantPrices already
    // recounts after the write, so this is just surfacing that count).
    logger.info(
      `[pos-prices] price_set ${price_set_id} now has ${priceCountAfterWrite} active price rows`
    );

    return res.status(200).json({
      success: true,
      variant_id,
      price_set_id,
      price_rows: priceCountAfterWrite,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[pos-prices] Failed to update prices: ${msg}`);
    return res.status(500).json({ error: msg });
  }
};
