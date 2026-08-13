import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";

import { assertOrderEditable } from "../_lib/assert-order-editable";
import { assertWebOrderAuthorized } from "../_lib/assert-web-order-authorized";
import { applyOrderDiscount } from "../../../../../lib/order-discount/apply-order-discount";
import { resolveCposPromotion } from "../../../../../lib/order-discount/resolve-cpos-promotion";
import { getDbPool } from "../../../../utils/db-pool";

/**
 * POST /admin/orders/:id/apply-discount-force — adapter fino del chokepoint.
 *
 * Históricamente esta ruta aplicaba el descuento con el baile draft-flip
 * (is_draft_order=true → workflow nativo de promos → flip back), con zombies
 * de order_change y payment collection por module service afuera de toda
 * transacción. Desde descuentos-canonicos-v1 el ÚNICO escritor es
 * `applyOrderDiscount` (lib/order-discount): adjustments + metadata + tax +
 * totales + payment_collection en UNA transacción, allocation con paridad
 * medida 23/23 contra prod. Esta ruta queda como superficie HTTP compatible.
 *
 * Body: { discount_type: 'percent'|'fixed', discount_value: number,
 *         pos_total?: number, pos_tax_rate?: number, pos_tax_amount?: number }
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { id } = req.params as { id: string };
  const archivedBlock = await assertOrderEditable(req.scope, id);
  if (archivedBlock) {
    res.status(409).json({ error: archivedBlock, code: "ORDER_ARCHIVED" });
    return;
  }

  // Una orden que vino de la WEB exige PIN de supervisor para editarse.
  const webAuth = await assertWebOrderAuthorized(req.scope, id, req);
  if (webAuth.denial) {
    res.status(webAuth.denial.status).json(webAuth.denial.body);
    return;
  }

  const { discount_type, discount_value, pos_tax_rate, pos_tax_amount } =
    req.body as {
      discount_type: "percent" | "fixed";
      discount_value: number;
      pos_total?: number;
      pos_tax_rate?: number;
      pos_tax_amount?: number;
    };

  if (!discount_type || !discount_value || discount_value <= 0) {
    res
      .status(400)
      .json({ message: "discount_type and discount_value are required" });
    return;
  }

  const logger = req.scope.resolve("logger");
  const intent = {
    type: discount_type === "percent" ? ("percent" as const) : ("fixed" as const),
    value: Number(discount_value),
  };

  try {
    const promo = await resolveCposPromotion(req.scope, intent);
    // Sin pos_tax_amount el facade recomputa el tax desde las líneas taxable
    // (rama isZeroTaxSafe): mandar 0 acá NO fuerza exempt salvo que el rate
    // también sea 0 — la misma semántica que tenía la ruta.
    const applied = await applyOrderDiscount(getDbPool(), id, {
      intent,
      tax: {
        ratePercent: pos_tax_rate ?? 7,
        posTaxAmount: pos_tax_amount ?? 0,
      },
      promo,
      logger,
    });
    res.status(200).json({
      success: true,
      promotion_code: promo.code,
      discount: applied.discountDollars,
      tax: applied.taxDollars,
      total: applied.totalDollars,
      adjustment_lines: applied.adjustmentLines,
    });
  } catch (e: any) {
    logger.error(`[apply-discount-force] ❌ ${e.message}`);
    res.status(500).json({ message: e.message });
  }
}
