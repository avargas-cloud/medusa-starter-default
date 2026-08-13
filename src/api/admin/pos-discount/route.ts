import {
  createPromotionsWorkflow,
  addDraftOrderPromotionWorkflow,
  removeDraftOrderPromotionsWorkflow,
  beginDraftOrderEditWorkflow,
  confirmDraftOrderEditWorkflow,
  cancelDraftOrderEditWorkflow,
} from "@medusajs/core-flows";
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { IOrderModuleService } from "@medusajs/types";
import {
  Modules,
  PromotionType,
  PromotionStatus,
  ApplicationMethodType,
  ApplicationMethodTargetType,
} from "@medusajs/utils";

import { getDbPool } from "../../utils/db-pool";

/**
 * POST /admin/pos-discount
 *
 * Creates a real Medusa promotion (active, unique code) then applies it to the
 * draft order using the proper Order Edit workflow:
 *   1. Cancel any pending edits
 *   2. Begin a new draft order edit
 *   3. Apply the promotion
 *   4. Confirm the edit
 *
 * Body:
 *   order_id            — draft order ID (order_XXXXX)
 *   discount_type       — 'percent' | 'fixed'
 *   discount_value      — number (% as 5 for 5%, or dollar amount for fixed)
 *   existing_promo_code — optional existing code to remove first
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { order_id, discount_type, discount_value, existing_promo_code } =
    req.body as {
      order_id?: string;
      discount_type?: "percent" | "fixed";
      discount_value?: number;
      existing_promo_code?: string;
    };

  if (!order_id) return res.status(400).json({ error: "order_id is required" });
  if (!discount_type || !discount_value || discount_value <= 0) {
    return res
      .status(400)
      .json({ error: "discount_type and discount_value are required" });
  }

  const orderModule = req.scope.resolve("order") as IOrderModuleService;
  const promotionModule = req.scope.resolve(Modules.PROMOTION) as any;
  const logger = req.scope.resolve("logger");

  try {
    // 0. Fetch the order to get the currency code (required for fixed discounts)
    const order = await orderModule.retrieveOrder(order_id, {
      select: ["currency_code"],
    });

    // 1. Find-or-create: use a deterministic code derived from type+value so the
    //    same discount reuses one promotion record instead of creating a new one each time.
    const valueInt = Math.round(discount_value * 100);
    const promoCode =
      discount_type === "percent"
        ? `CPOS-PCT-${valueInt}`
        : `CPOS-FIXED-${valueInt}`;

    const [existingPromo] = await promotionModule.listPromotions(
      { code: [promoCode] },
      { select: ["id", "code", "status"] }
    );

    let promotion: { id: string; code: string };
    if (existingPromo) {
      // Reuse existing promotion — ensure it's active
      if (existingPromo.status !== PromotionStatus.ACTIVE) {
        await promotionModule.updatePromotions([
          { id: existingPromo.id, status: PromotionStatus.ACTIVE },
        ]);
      }
      promotion = {
        id: existingPromo.id,
        code: existingPromo.code ?? promoCode,
      };
      logger.info(
        `[POS Discount] Reusing promotion ${promoCode} (${existingPromo.id})`
      );
    } else {
      // Create once — this code has never been seen before
      const promotionData = {
        code: promoCode,
        type: PromotionType.STANDARD,
        status: PromotionStatus.ACTIVE,
        is_automatic: false,
        is_tax_inclusive: false, // CRITICAL: apply % to pre-tax subtotal only (not subtotal+tax)
        application_method: {
          type:
            discount_type === "percent"
              ? ApplicationMethodType.PERCENTAGE
              : ApplicationMethodType.FIXED,
          target_type: ApplicationMethodTargetType.ITEMS, // CRITICAL: "order" uses subtotal+tax as base (wrong); "items" uses unit_price×qty (pre-tax, correct)
          allocation: "across" as const, // REQUIRED by Medusa v2 — splits discount proportionally across items
          is_tax_inclusive: false, // Belt-and-suspenders: also set at application_method level
          value: discount_value,
          currency_code:
            discount_type === "fixed" ? order.currency_code : undefined,
        },
      };
      const { result: createdPromos } = await createPromotionsWorkflow(
        req.scope
      ).run({
        input: { promotionsData: [promotionData] },
      });
      const created = createdPromos[0];
      if (!created) throw new Error("Failed to create promotion");
      promotion = { id: created.id, code: created.code ?? promoCode };
      logger.info(`[POS Discount] Created promotion ${promoCode}`);
    }

    // 2. Cancel any existing open draft order edits
    try {
      await cancelDraftOrderEditWorkflow(req.scope).run({
        input: { order_id },
      });
    } catch {
      /* no existing edit */
    }

    // 3. Begin a new draft order edit
    await beginDraftOrderEditWorkflow(req.scope).run({ input: { order_id } });

    // 4. Remove EVERY order-level promo already on the order, inside the edit.
    //
    // Esto NO puede depender de que el caller mande `existing_promo_code`: el POS
    // no lo manda (manda sólo order_id/discount_type/discount_value), así que el
    // descuento anterior seguía vivo cuando se aplicaba el nuevo — y Medusa
    // calcula el porcentaje nuevo sobre el total que YA trae descontado el viejo.
    //
    // Reproducido en sandbox (`e2e-order-discount-lifecycle-sandbox.ts`): con un
    // subtotal de 480.00 y un 10% ya aplicado, cambiar a 5% guardaba 21.60 —que
    // es 5% de 432.00— en vez de los 24.00 que muestra el documento. Después la
    // limpieza de `sync-pos` borra el código viejo y queda UNA fila con el monto
    // compuesto, indistinguible de un descuento legítimo. Es la firma exacta de
    // E2146 en producción: 10% de 19.607,76 = 1.960,78, cuando el documento dice
    // 10% de 21.786,40 = 2.178,64.
    //
    // Se descubren por los adjustments vivos y no por la metadata porque la
    // metadata es justamente lo que en esos documentos está vacío.
    const codesToDrop = new Set<string>();
    if (existing_promo_code) codesToDrop.add(existing_promo_code);
    try {
      const { rows } = await getDbPool().query<{ code: string | null }>(
        `SELECT DISTINCT a.code
           FROM order_item oi
           JOIN order_line_item_adjustment a ON a.item_id = oi.item_id
          WHERE oi.order_id = $1
            AND a.deleted_at IS NULL
            AND a.code IS NOT NULL`,
        [order_id]
      );
      for (const r of rows) if (r.code) codesToDrop.add(r.code);
    } catch (e: any) {
      logger.warn(
        `[POS Discount] Could not read live adjustment codes: ${e.message}`
      );
    }
    // Re-aplicar el MISMO código no necesita removerlo (medido: no compone), y
    // sacarlo para volver a ponerlo agrega una escritura que puede fallar sola.
    codesToDrop.delete(promoCode);

    if (codesToDrop.size > 0) {
      const promo_codes = [...codesToDrop];
      try {
        await removeDraftOrderPromotionsWorkflow(req.scope).run({
          input: { order_id, promo_codes },
        });
        logger.info(
          `[POS Discount] Removed ${promo_codes.length} stale promo(s) before applying ${promoCode}: ${promo_codes.join(", ")}`
        );
        // El workflow saca la PROMOCIÓN, no necesariamente sus filas: las que
        // escribió `apply-existing` vienen de `posOverrideAdjustmentsWorkflow`,
        // que las pone a mano fuera del workflow de promociones y por lo tanto
        // sobreviven a la remoción. Si sobreviven, el porcentaje nuevo se calcula
        // sobre el neto que todavía las tiene restadas — medido: 43.20 en vez de
        // 48.00. Borrarlas acá es lo que deja la base limpia ANTES de aplicar.
        const del = await getDbPool().query(
          `DELETE FROM order_line_item_adjustment
            WHERE deleted_at IS NULL
              AND code = ANY($2::text[])
              AND item_id IN (SELECT DISTINCT item_id FROM order_item WHERE order_id = $1)`,
          [order_id, promo_codes]
        );
        if ((del.rowCount ?? 0) > 0) {
          logger.info(
            `[POS Discount] Also hard-deleted ${del.rowCount} leftover adjustment row(s) for ${promo_codes.join(", ")}`
          );
        }
      } catch (e: any) {
        // Falla CERRADO a propósito: si el descuento viejo sigue vivo, el nuevo
        // se calcula sobre una base contaminada y el documento queda mintiendo.
        // Mejor que el POS reciba un error a que guarde un total equivocado.
        logger.error(
          `[POS Discount] Could not remove stale promos (${promo_codes.join(", ")}): ${e.message}`
        );
        throw new Error(
          `no se pudo quitar el descuento anterior (${promo_codes.join(", ")}) — el nuevo se habría calculado sobre un subtotal ya descontado: ${e.message}`
        );
      }
    }

    // 5. Apply the new promotion
    await addDraftOrderPromotionWorkflow(req.scope).run({
      input: { order_id, promo_codes: [promoCode] },
    });

    // 6. Confirm the edit
    await confirmDraftOrderEditWorkflow(req.scope).run({
      input: { order_id, confirmed_by: "pos-system" },
    });

    logger.info(`[POS Discount] Applied ${promoCode} to order ${order_id}`);
    return res.status(200).json({
      success: true,
      promotion_code: promoCode,
      promotion_id: promotion.id,
    });
  } catch (error: any) {
    logger.error(`[POS Discount] Error: ${error.message}`);
    return res.status(500).json({ error: error.message });
  }
}

export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  const { order_id, promotion_code } = req.body as {
    order_id?: string;
    promotion_code?: string;
  };

  if (!order_id) return res.status(400).json({ error: "order_id is required" });

  const logger = req.scope.resolve("logger");

  try {
    // Step 1: Cancel any existing pending edits (clean state)
    try {
      await cancelDraftOrderEditWorkflow(req.scope).run({
        input: { order_id },
      });
    } catch {
      /* no existing edit to cancel */
    }

    // Step 2: Begin a new draft order edit
    await beginDraftOrderEditWorkflow(req.scope).run({ input: { order_id } });

    // Step 3: Remove the promotion
    if (promotion_code) {
      await removeDraftOrderPromotionsWorkflow(req.scope).run({
        input: { order_id, promo_codes: [promotion_code] },
      });
      // El workflow devuelve OK y DEJA VIVAS las filas de adjustment (las
      // escribe posOverrideAdjustmentsWorkflow por fuera, gotcha 2026-07-30) y
      // el link order_promotion. Sin este barrido el descuento "quitado" sigue
      // restando en loadOrderMoneyBase y el total guardado sale envenenado.
      const pool = getDbPool();
      const adjDel = await pool.query(
        `DELETE FROM order_line_item_adjustment
          WHERE code = $1
            AND item_id IN (SELECT item_id FROM order_item WHERE order_id = $2)`,
        [promotion_code, order_id]
      );
      await pool.query(
        `DELETE FROM order_promotion
          WHERE order_id = $1
            AND promotion_id IN (SELECT id FROM promotion WHERE code = $2)`,
        [order_id, promotion_code]
      );
      logger.info(
        `[POS Discount DELETE] Removed ${promotion_code} (+${adjDel.rowCount ?? 0} adjustment(s) barridas)`
      );
    }

    // Step 4: Confirm the edit
    await confirmDraftOrderEditWorkflow(req.scope).run({
      input: { order_id, confirmed_by: "pos-system" },
    });

    return res.status(200).json({ success: true });
  } catch (error: any) {
    logger.error(`[POS Discount DELETE] Error: ${error.message}`);
    return res.status(500).json({ error: error.message });
  }
}
