/**
 * Find-or-create del promo-vehículo CPOS — FUERA de la transacción del facade.
 *
 * La promo es un vehículo técnico de Medusa (el código que llevan los
 * adjustments y el link order_promotion), no una decisión de negocio. Se
 * resuelve ANTES de `applyOrderDiscount` a propósito: crearla vía workflow no
 * es transaccional, y un promo sin usar tras un rollback es residuo inocuo —
 * exactamente el trade-off que el plan aceptó (nunca crear las tablas internas
 * de promociones por SQL para fingir atomicidad).
 *
 * Código determinista por tipo+valor (`CPOS-PCT-500` = 5%, `CPOS-FIXED-1234` =
 * $12.34) para reusar promos entre órdenes — misma convención que
 * apply-discount-force desde siempre.
 */
import { createPromotionsWorkflow } from "@medusajs/core-flows";
import type { MedusaContainer } from "@medusajs/framework/types";
import {
  ApplicationMethodTargetType,
  ApplicationMethodType,
  Modules,
  PromotionStatus,
  PromotionType,
} from "@medusajs/utils";

import type { DiscountIntent } from "./allocation";
import type { PromoVehicle } from "./apply-order-discount";

export async function resolveCposPromotion(
  scope: MedusaContainer,
  intent: DiscountIntent,
  opts: { currencyCode?: string; preferredCode?: string | null } = {}
): Promise<PromoVehicle> {
  const promotionModule = scope.resolve(Modules.PROMOTION) as any;
  const currencyCode = opts.currencyCode ?? "usd";

  // Un preset del POS (p.ej. `ORDER-DISCOUNT-10%`) conserva su identidad como
  // vehículo: si el código declarado existe, se usa ése — el monto lo decide
  // igual la allocation, nunca la promo.
  if (opts.preferredCode) {
    const [preferred] = await promotionModule.listPromotions(
      { code: [opts.preferredCode] },
      { select: ["id", "code", "status"] }
    );
    if (preferred) {
      if (preferred.status !== PromotionStatus.ACTIVE) {
        await promotionModule.updatePromotions([
          { id: preferred.id, status: PromotionStatus.ACTIVE },
        ]);
      }
      return { id: preferred.id, code: preferred.code ?? opts.preferredCode };
    }
  }

  const valueInt = Math.round(intent.value * 100);
  const promoCode =
    intent.type === "percent" ? `CPOS-PCT-${valueInt}` : `CPOS-FIXED-${valueInt}`;

  const [existing] = await promotionModule.listPromotions(
    { code: [promoCode] },
    { select: ["id", "code", "status"] }
  );
  if (existing) {
    if (existing.status !== PromotionStatus.ACTIVE) {
      await promotionModule.updatePromotions([
        { id: existing.id, status: PromotionStatus.ACTIVE },
      ]);
    }
    return { id: existing.id, code: existing.code ?? promoCode };
  }

  const { result: created } = await createPromotionsWorkflow(scope).run({
    input: {
      promotionsData: [
        {
          code: promoCode,
          type: PromotionType.STANDARD,
          status: PromotionStatus.ACTIVE,
          is_automatic: false,
          is_tax_inclusive: false,
          application_method: {
            type:
              intent.type === "percent"
                ? ApplicationMethodType.PERCENTAGE
                : ApplicationMethodType.FIXED,
            target_type: ApplicationMethodTargetType.ITEMS,
            allocation: "across" as const,
            value: intent.value,
            currency_code: intent.type === "fixed" ? currencyCode : undefined,
          },
        },
      ],
    },
  });
  const promo = created?.[0];
  if (!promo) throw new Error(`no se pudo crear la promo ${promoCode}`);
  return { id: promo.id, code: promo.code ?? promoCode };
}
