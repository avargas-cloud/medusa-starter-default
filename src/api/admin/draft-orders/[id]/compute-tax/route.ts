import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Modules } from "@medusajs/utils"
import { Pool } from "pg"

/** Simple unique ID generator for tax line records */
const genId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`


/**
 * GET /admin/draft-orders/:id/compute-tax
 *
 * Tax MODES (checked in order):
 *   1. order.metadata.tax_mode = "exempt" → $0
 *   2. order.metadata.tax_mode = "florida" → FL 7%
 *   3. order.metadata.tax_mode = "auto" | not set → auto-detect:
 *        a. shipping = local pickup → "florida"
 *        b. shipping address province → state rate
 *        c. no address → $0
 *
 * Response: { amount, rate, reason, exempt, mode, subtotal }
 */

const PICKUP_KEYWORDS = ["pickup", "store pickup", "local pickup", "in store", "in-store"]
const isPickup = (name: string) => PICKUP_KEYWORDS.some(k => name.toLowerCase().includes(k))
const FL_PROVINCE = "FL"

/**
 * Persists tax into Medusa's native draft order view by:
 * 1. Inserting/updating order_line_item_tax_line for each line item (proportional)
 * 2. Updating order_summary.totals JSONB to include tax in current_order_total
 *
 * This is what Medusa v2 reads to display Tax in the native draft order Summary.
 */
async function persistTaxToOrder(orderId: string, taxAmountDollars: number, taxRate: number): Promise<void> {
    const dbUrl = process.env.DATABASE_URL
    if (!dbUrl) return

    const pool = new Pool({ connectionString: dbUrl })
    try {
        // ── 1. Get DISTINCT active line item IDs for this order ───────────────────
        const itemsRes = await pool.query<{ item_id: string }>(
            `SELECT DISTINCT oi.item_id
             FROM order_item oi
             JOIN order_line_item oli ON oli.id = oi.item_id
             WHERE oi.order_id = $1 AND oi.deleted_at IS NULL AND oli.deleted_at IS NULL`,
            [orderId]
        )

        const itemIds = itemsRes.rows.map(r => r.item_id)

        if (itemIds.length === 0) {
            await updateOrderSummaryTax(pool, orderId, taxAmountDollars)
            return
        }

        // ── 2. Hard-delete ALL previous manual tax lines (no accumulation) ────────
        await pool.query(
            `DELETE FROM order_line_item_tax_line WHERE item_id = ANY($1) AND code = 'manual'`,
            [itemIds]
        )

        // ── 3. Insert ONE tax line per active item ────────────────────────────────
        if (taxAmountDollars > 0 && taxRate > 0) {
            const rawRate = JSON.stringify({ value: String(taxRate), precision: 20 })

            for (const itemId of itemIds) {
                const lineId = genId("taxline")
                await pool.query(
                    `INSERT INTO order_line_item_tax_line (id, item_id, code, rate, raw_rate, description, created_at, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
                    [lineId, itemId, "manual", taxRate, rawRate, "Sales Tax"]
                )
            }
        }

        // ── 4. Update order_summary.totals JSONB with tax ─────────────────────────
        await updateOrderSummaryTax(pool, orderId, taxAmountDollars)

    } catch (e: any) {
        console.error("[compute-tax] persistTaxToOrder failed:", e?.message)
    } finally {
        await pool.end()
    }
}


async function updateOrderSummaryTax(pool: Pool, orderId: string, taxAmountDollars: number): Promise<void> {
    // Get the latest order_summary entry
    const summaryRes = await pool.query<{ id: string; totals: any; version: number }>(
        `SELECT id, totals, version FROM order_summary
         WHERE order_id = $1 AND deleted_at IS NULL
         ORDER BY version DESC LIMIT 1`,
        [orderId]
    )

    if (!summaryRes.rows[0]) return
    const { id: summaryId, totals } = summaryRes.rows[0]

    // Parse existing totals and add/replace tax_total
    const currentTotal: number = parseFloat(totals?.current_order_total ?? "0") || 0

    // Use original_order_total as base (= subtotal without tax)
    // If not available, fall back to current_order_total
    const subTotal: number = parseFloat(totals?.raw_original_order_total?.value ?? "0") || currentTotal
    const newCurrentTotal = subTotal + taxAmountDollars

    const updatedTotals = {
        ...totals,
        tax_total: taxAmountDollars,
        current_order_total: newCurrentTotal,
        accounting_total: newCurrentTotal,
        raw_tax_total: { value: String(taxAmountDollars), precision: 20 },
        raw_current_order_total: { value: String(newCurrentTotal), precision: 20 },
        raw_accounting_total: { value: String(newCurrentTotal), precision: 20 },
        // Keep pending_difference in sync
        pending_difference: newCurrentTotal,
        raw_pending_difference: { value: String(newCurrentTotal), precision: 20 },
    }

    await pool.query(
        `UPDATE order_summary SET totals = $1, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(updatedTotals), summaryId]
    )
}

async function getFlRate(req: MedusaRequest, province: string): Promise<{ rate: number; reason: string }> {
    try {
        const taxModule = req.scope.resolve(Modules.TAX) as any
        let regions: any[] = []
        try { regions = await taxModule.listTaxRegions({ province_code: province }, {}) as any[] } catch { }
        if (!regions?.length) {
            try { regions = await taxModule.listTaxRegions({ province_code: province.toLowerCase() }, {}) as any[] } catch { }
        }
        if (regions?.length > 0) {
            const rates = await taxModule.listTaxRates({ tax_region_id: [regions[0].id] }, {}) as any[]
            const mainRate = rates?.find((r: any) => r.rate > 0)
            if (mainRate?.rate) {
                return { rate: mainRate.rate, reason: `${regions[0].name ?? province} (${mainRate.rate}%)` }
            }
        }
    } catch { /* fall through */ }
    // Hardcoded FL fallback (confirmed 7% in Medusa)
    if (province === FL_PROVINCE) return { rate: 7, reason: "Florida Sales Tax (7%)" }
    return { rate: 0, reason: `${province} — no rate configured` }
}

export async function GET(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const { id } = req.params as { id: string }

    try {
        // Use admin REST API — reliable for draft orders
        const orderRes = await fetch(
            `http://localhost:9000/admin/orders/${id}?fields=+items.*,+shipping_methods.*,+shipping_address.*,+customer_id,+metadata`,
            {
                headers: {
                    "Cookie": req.headers["cookie"] ?? "",
                    "Authorization": req.headers["authorization"] ?? "",
                },
            }
        )
        if (!orderRes.ok) return void res.status(404).json({ message: "Order not found" })
        const { order } = await orderRes.json()

        // Subtotal from items (unit_price in dollars)
        const subtotal = (order?.items ?? []).reduce((sum: number, item: any) =>
            sum + ((item.unit_price ?? 0) * (item.quantity ?? 1)), 0)

        // Explicit per-order tax mode (set by user override)
        const savedMode: string | undefined = order?.metadata?.tax_mode

        // Auto-detect the correct mode if not explicitly set
        let autoMode = "auto"
        const shippingMethods: any[] = order?.shipping_methods ?? []
        const hasPickup = shippingMethods.some(m => isPickup(m.name ?? ""))
        const province = hasPickup
            ? FL_PROVINCE
            : ((order?.shipping_address?.province ?? "").toUpperCase() || null)

        if (hasPickup || province === FL_PROVINCE) autoMode = "florida"

        // Resolve effective mode
        const mode = savedMode && savedMode !== "auto" ? savedMode : autoMode

        // Compute tax based on mode
        let amount = 0, rate = 0, reason = "", exempt = false

        if (mode === "exempt") {
            exempt = true; reason = "Tax Exempt"; rate = 0; amount = 0
        } else if (mode === "florida") {
            const fl = await getFlRate(req, FL_PROVINCE)
            rate = fl.rate; reason = fl.reason
            amount = Math.round(subtotal * rate / 100 * 100) / 100
        } else if (province && province !== FL_PROVINCE) {
            // Auto with specific province
            const st = await getFlRate(req, province)
            rate = st.rate; reason = st.reason
            amount = Math.round(subtotal * rate / 100 * 100) / 100
        } else {
            reason = "No shipping address yet"
        }

        // Persist tax into Medusa's native order tables so the native draft order
        // page shows the correct tax and total.
        await persistTaxToOrder(id, amount, rate)

        // Save computed values to metadata for reference
        try {
            const orderModule = req.scope.resolve(Modules.ORDER) as any
            const orders = await orderModule.listOrders({ id: [id] }, { select: ["id", "metadata"] }) as any[]
            if (orders?.[0]) {
                await orderModule.updateOrders({
                    id,
                    metadata: {
                        ...(orders[0].metadata ?? {}),
                        computed_tax_amount: amount,
                        computed_tax_rate: rate,
                        computed_tax_reason: reason,
                        ...((!savedMode || savedMode === "auto") ? { tax_mode: mode } : {}),
                    }
                })
            }
        } catch { /* non-critical */ }

        res.status(200).json({ amount, rate, reason, exempt, mode, subtotal, autoMode })
    } catch (e: any) {
        console.error("[compute-tax]", e?.message)
        res.status(500).json({ message: e?.message ?? "Failed to compute tax" })
    }
}

/**
 * POST /admin/draft-orders/:id/compute-tax
 * Set tax mode for this specific order.
 * Body: { mode: "florida" | "exempt" | "auto" }
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const { id } = req.params as { id: string }
    const { mode } = req.body as { mode: "florida" | "exempt" | "auto" }

    if (!["florida", "exempt", "auto"].includes(mode)) {
        return void res.status(400).json({ message: "Invalid mode. Use: florida | exempt | auto" })
    }

    try {
        const orderModule = req.scope.resolve(Modules.ORDER) as any
        const orders = await orderModule.listOrders({ id: [id] }, { select: ["id", "metadata"] }) as any[]
        if (!orders?.[0]) return void res.status(404).json({ message: "Order not found" })

        await orderModule.updateOrders({
            id,
            metadata: { ...(orders[0].metadata ?? {}), tax_mode: mode }
        })

        // Re-trigger full compute to persist the new tax amount with updated mode
        fetch(`http://localhost:${process.env.PORT ?? 9000}/admin/draft-orders/${id}/compute-tax`, {
            headers: {
                "Cookie": (req as any).headers["cookie"] ?? "",
                "Authorization": (req as any).headers["authorization"] ?? "",
            },
        }).catch(() => { })

        res.status(200).json({ success: true, mode })
    } catch (e: any) {
        console.error("[compute-tax POST]", e?.message)
        res.status(500).json({ message: e?.message ?? "Failed to set tax mode" })
    }
}
