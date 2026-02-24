import { defineMiddlewares } from "@medusajs/medusa"
import type { MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http"

/**
 * Intercepts the response of the Admin Orders API to fix the 
 * "current_order_total" bug in Medusa v2.13 where line items
 * are missing from the relational cache when listing orders and
 * only shipping/taxes are calculated.
 */
function fixAdminOrderTotals(
    _req: MedusaRequest,
    res: MedusaResponse,
    next: MedusaNextFunction
) {
    const originalSend = res.send

    res.send = function (body: any) {
        if (body) {
            try {
                let parsedBody = typeof body === "string" ? JSON.parse(body) : body
                if (parsedBody && Array.isArray(parsedBody.orders)) {
                    // Loop through orders and force the summary.current_order_total 
                    // to reflect the real final 'total', 'original_total', or 'accounting_total'
                    parsedBody.orders = parsedBody.orders.map((order: any) => {
                        if (order.summary && typeof order.total !== 'undefined') {
                            // If it's a completely canceled order where Medusa natively zeroes the total,
                            // we show the actual original amount it was worth or 0.
                            if (order.status === 'canceled') {
                                // Keep native canceled behavior or use original total if required
                                // order.summary.current_order_total = order.summary.original_order_total || 0;
                            } else {
                                // For pending/completed orders, use the REAL total instead of the broken summary calculation.
                                // We use original_total if total is 0 (which happens due to the bug missing items)
                                const realTotal = order.total > 0 ? order.total : (order.original_total > 0 ? order.original_total : order.summary.original_order_total);
                                if (realTotal !== undefined && realTotal !== order.summary.current_order_total) {
                                    order.summary.current_order_total = realTotal;
                                }
                            }
                        }
                        return order;
                    })
                    arguments[0] = JSON.stringify(parsedBody)
                }
            } catch (e) {
                console.error("[Hooks] Failed to parse admin orders payload for total fix:", e)
            }
        }
        return originalSend.apply(res, arguments as any)
    }

    next()
}

export default defineMiddlewares({
    routes: [
        {
            matcher: "/admin/orders",
            method: ["GET"],
            middlewares: [fixAdminOrderTotals],
        }
    ]
})
