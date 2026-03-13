import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { IOrderModuleService } from "@medusajs/types"
import {
  createPromotionsWorkflow,
  addDraftOrderPromotionWorkflow,
  removeDraftOrderPromotionsWorkflow,
  beginDraftOrderEditWorkflow,
  confirmDraftOrderEditWorkflow,
  cancelDraftOrderEditWorkflow,
} from "@medusajs/core-flows"

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
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
) {
  const { order_id, discount_type, discount_value, existing_promo_code } = req.body as {
    order_id?: string
    discount_type?: 'percent' | 'fixed'
    discount_value?: number
    existing_promo_code?: string
  }

  if (!order_id) return res.status(400).json({ error: "order_id is required" })
  if (!discount_type || !discount_value || discount_value <= 0) {
    return res.status(400).json({ error: "discount_type and discount_value are required" })
  }

  const orderModule = req.scope.resolve("order") as IOrderModuleService
  const logger = req.scope.resolve("logger")

  try {
    // 0. Fetch the order to get the currency code (required for fixed discounts)
    const order = await orderModule.retrieveOrder(order_id, { select: ["currency_code"] })

    // 1. Create the new promotion first
    const promoCode = `CUSTOM-DISC-${Date.now()}`
    const promotionData: any = {
      code: promoCode,
      type: "standard",
      status: "active",
      is_automatic: false,
      is_tax_inclusive: false,   // CRITICAL: apply % to pre-tax subtotal only (not subtotal+tax)
      application_method: {
        type: discount_type === "percent" ? "percentage" : "fixed",
        target_type: "items",   // CRITICAL: "order" uses subtotal+tax as base (wrong); "items" uses unit_price×qty (pre-tax, correct)
        value: discount_value,
        currency_code: discount_type === "fixed" ? order.currency_code : undefined
      }
    }

    const { result: createdPromos } = await createPromotionsWorkflow(req.scope).run({
      input: { promotionsData: [promotionData] }
    })
    const promotion = createdPromos[0]
    if (!promotion) throw new Error("Failed to create promotion")
    logger.info(`[POS Discount] Created promotion ${promoCode}`)

    // 2. Cancel any existing open draft order edits
    try {
      await cancelDraftOrderEditWorkflow(req.scope).run({ input: { order_id } })
    } catch { /* no existing edit */ }

    // 3. Begin a new draft order edit
    await beginDraftOrderEditWorkflow(req.scope).run({ input: { order_id } })

    // 4. If there was a previous custom promo to remove, remove it inside the edit
    if (existing_promo_code) {
      try {
        await removeDraftOrderPromotionsWorkflow(req.scope).run({
          input: { order_id, promo_codes: [existing_promo_code] }
        })
        logger.info(`[POS Discount] Removed existing promo ${existing_promo_code}`)
      } catch (e: any) {
        logger.warn(`[POS Discount] Could not remove old promo: ${e.message}`)
      }
    }

    // 5. Apply the new promotion
    await addDraftOrderPromotionWorkflow(req.scope).run({
      input: { order_id, promo_codes: [promoCode] }
    })

    // 6. Confirm the edit
    await confirmDraftOrderEditWorkflow(req.scope).run({ input: { order_id, confirmed_by: 'pos-system' } })

    logger.info(`[POS Discount] Applied ${promoCode} to order ${order_id}`)
    return res.status(200).json({
      success: true,
      promotion_code: promoCode,
      promotion_id: promotion.id
    })

  } catch (error: any) {
    logger.error(`[POS Discount] Error: ${error.message}`)
    return res.status(500).json({ error: error.message })
  }
}

export async function DELETE(
  req: MedusaRequest,
  res: MedusaResponse
) {
  const { order_id, promotion_code } = req.body as {
    order_id?: string
    promotion_code?: string
  }

  if (!order_id) return res.status(400).json({ error: "order_id is required" })

  const logger = req.scope.resolve("logger")

  try {
    // Step 1: Cancel any existing pending edits (clean state)
    try {
      await cancelDraftOrderEditWorkflow(req.scope).run({ input: { order_id } })
    } catch { /* no existing edit to cancel */ }

    // Step 2: Begin a new draft order edit
    await beginDraftOrderEditWorkflow(req.scope).run({ input: { order_id } })

    // Step 3: Remove the promotion
    if (promotion_code) {
      await removeDraftOrderPromotionsWorkflow(req.scope).run({
        input: { order_id, promo_codes: [promotion_code] }
      })
      logger.info(`[POS Discount DELETE] Removed ${promotion_code}`)
    }

    // Step 4: Confirm the edit
    await confirmDraftOrderEditWorkflow(req.scope).run({ input: { order_id, confirmed_by: 'pos-system' } })

    return res.status(200).json({ success: true })
  } catch (error: any) {
    logger.error(`[POS Discount DELETE] Error: ${error.message}`)
    return res.status(500).json({ error: error.message })
  }
}
