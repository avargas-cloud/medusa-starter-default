import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/utils"
import { ICartModuleService } from "@medusajs/types"
import { removeDraftOrderPromotionsWorkflow } from "@medusajs/core-flows"

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
) {
  const { cart_id, order_id, discounts, discount_type, discount_value } = req.body as {
    cart_id?: string
    order_id?: string
    discounts?: {
      variant_id: string
      amount: number // in cents
    }[]
    discount_type?: 'percent' | 'fixed'
    discount_value?: number
  }

  const targetId = cart_id || order_id
  if (!targetId) {
    return res.status(400).json({ error: "cart_id or order_id is required" })
  }

  const cartModule = req.scope.resolve(Modules.CART) as ICartModuleService

  try {
    // Fetch cart/order via the native module service.
    // If order_id was provided (like from pos/estimates), we still manipulate the cart if it's a draft
    // In Medusa v2, adjustments are typically still attached to the cart items or the cart itself.
    // For simplicity, we apply order-level discounts as a separate module action if needed, or distribute it.
    // In Medusa v2, you can add an adjustment to the *cart* not just the line items.
    let cartIdToUse = targetId

    // Note: If order_id is passed, we might need to find its associated cart, or just assume the frontend passes the cart_id.
    // The POS frontend passes `order_id: doc.medusaId` which is often the cart_id for Draft Orders.
    const cart = await cartModule.retrieveCart(cartIdToUse, {
      relations: ["items", "items.adjustments"]
    })

    const lineAdjustmentsPayload: any[] = []
    const discountsPayload = discounts || []

    // Iterate through all cart items
    for (const item of cart.items || []) {
      // Keep existing non-POS discounts (e.g. Medusa Promotions)
      const existingPromos = (item.adjustments || []).filter((a: any) => a.code !== "POS_DISCOUNT" && a.code !== "POS_ORDER_DISCOUNT")
      for (const adj of existingPromos) {
        lineAdjustmentsPayload.push({
          id: adj.id,
          item_id: item.id
        })
      }

      // Find matching manual line item discount from POS payload
      const matchingDiscount = discountsPayload.find(d => d.variant_id === item.variant_id)
      if (matchingDiscount && matchingDiscount.amount > 0) {
        // Ensure we don't exceed the total amount of the item
        const maxDiscount = Number(item.unit_price) * Number(item.quantity)
        const finalAmount = Math.min(matchingDiscount.amount, maxDiscount)

        lineAdjustmentsPayload.push({
          item_id: item.id,
          code: "POS_DISCOUNT",
          amount: finalAmount,
          description: "Manual Line Discount"
        })
      }
    }

    // Handle Order-Level Manual Discount (distribute or attach)
    // The easiest way to handle a custom order discount is to proportionally distribute it across line items.
    if (discount_type && discount_value && discount_value > 0) {
      // 1. Calculate subtotal after line discounts
      let subtotalAfterLineDiscounts = 0
      for (const item of cart.items || []) {
        const base = Number(item.unit_price) * Number(item.quantity)
        const lineAdj = lineAdjustmentsPayload.filter(a => a.item_id === item.id).reduce((sum, a) => sum + a.amount, 0)
        subtotalAfterLineDiscounts += (base - lineAdj)
      }

      // 2. Distribute Order Discount
      if (subtotalAfterLineDiscounts > 0) {
        for (const item of cart.items || []) {
          const base = Number(item.unit_price) * Number(item.quantity)
          const lineAdj = lineAdjustmentsPayload.filter(a => a.item_id === item.id).reduce((sum, a) => sum + a.amount, 0)
          const itemSubtotal = base - lineAdj

          if (itemSubtotal <= 0) continue

          let orderDiscountAmount = 0
          if (discount_type === 'percent') {
            orderDiscountAmount = Math.round(itemSubtotal * (discount_value / 100))
          } else if (discount_type === 'fixed') {
            const totalDiscountCents = discount_value * 100
            const proportion = itemSubtotal / subtotalAfterLineDiscounts
            orderDiscountAmount = Math.round(totalDiscountCents * proportion)
          }

          if (orderDiscountAmount > 0) {
            lineAdjustmentsPayload.push({
              item_id: item.id,
              code: "POS_ORDER_DISCOUNT",
              amount: Math.min(orderDiscountAmount, itemSubtotal), // never discount more than remaining item value
              description: "Manual Order Discount"
            })
          }
        }
      }
    }

    if (lineAdjustmentsPayload.length > 0) {
      await cartModule.setLineItemAdjustments(cart.id, lineAdjustmentsPayload)
    } else {
      await cartModule.setLineItemAdjustments(cart.id, [])
    }

    return res.status(200).json({
      success: true,
      cart_id: cart.id,
      promotion_code: discount_value ? 'CUSTOM' : undefined
    })
  } catch (error: any) {
    req.scope.resolve("logger").error(`[POS Discount] Error: ${error.message}`)
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
    promotion_id?: string
  }

  if (!order_id) {
    return res.status(400).json({ error: "order_id is required" })
  }

  try {
    if (promotion_code === 'CUSTOM') {
      // Remove manual POS_ORDER_DISCOUNT from cart
      const cartModule = req.scope.resolve(Modules.CART) as ICartModuleService
      const cart = await cartModule.retrieveCart(order_id, {
        relations: ["items", "items.adjustments"]
      })

      const lineAdjustmentsPayload: any[] = []
      for (const item of cart.items || []) {
        const existingPromos = (item.adjustments || []).filter((a: any) => a.code !== "POS_ORDER_DISCOUNT")
        for (const adj of existingPromos) {
          lineAdjustmentsPayload.push({
            id: adj.id,
            item_id: item.id
          })
        }
      }

      if (lineAdjustmentsPayload.length > 0) {
        await cartModule.setLineItemAdjustments(cart.id, lineAdjustmentsPayload)
      } else {
        await cartModule.setLineItemAdjustments(cart.id, [])
      }
    } else if (order_id.startsWith('cart_') || order_id.startsWith('dorder_')) {
      // Native Draft Order Promotion (Draft orders use cart_ IDs initially)
      await removeDraftOrderPromotionsWorkflow(req.scope).run({
        input: {
          order_id: order_id,
          promo_codes: [promotion_code || '']
        }
      })
    }

    return res.status(200).json({ success: true })
  } catch (error: any) {
    req.scope.resolve("logger").error(`[POS Discount DELETE] Error: ${error.message}`)
    return res.status(500).json({ error: error.message })
  }
}
