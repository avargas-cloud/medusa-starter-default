import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Modules } from "@medusajs/utils"
import { Pool } from "pg"

/** Simple unique ID generator for tax line records */
const genId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

const PICKUP_KEYWORDS = ["pickup", "store pickup", "local pickup", "in store", "in-store"]
const isPickup = (name: string) => PICKUP_KEYWORDS.some(k => name.toLowerCase().includes(k))
const FL_PROVINCE = "FL"

/**
 * Save metadata fields on the draft order via the REST admin API.
 * This is more reliable than orderModule.updateOrders() which has been observed
 * to drop metadata fields in some Medusa v2 versions.
 * Merges with existing metadata (reads current state first, then patches).
 */
async function saveOrderMeta(
    req: MedusaRequest,
    id: string,
    fields: Record<string, any>
): Promise<void> {
    const base = `http://localhost:${process.env.PORT ?? 9000}`
    const headers = {
        "Cookie": req.headers["cookie"] ?? "",
        "Authorization": req.headers["authorization"] ?? "",
        "Content-Type": "application/json",
    }

    // Read current metadata first so we can merge (not replace)
    const r = await fetch(`${base}/admin/orders/${id}?fields=id,+metadata`, { headers })
    if (!r.ok) return
    const { order: current } = await r.json()
    const prevMeta = current?.metadata ?? {}

    // Patch with merged metadata
    await fetch(`${base}/admin/draft-orders/${id}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ metadata: { ...prevMeta, ...fields } }),
    })
}

/**
 * Persists tax into Medusa's native draft order view by:
 * 1. Inserting/updating order_line_item_tax_line for each line item (proportional)
 * 2. Updating order_summary.totals JSONB to include tax in current_order_total
 */
async function persistTaxToOrder(orderId: string, taxAmountDollars: number, taxRate: number): Promise<void> {
    const dbUrl = process.env.DATABASE_URL
    if (!dbUrl) return

    const pool = new Pool({ connectionString: dbUrl })
    try {
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

        await pool.query(
            `DELETE FROM order_line_item_tax_line WHERE item_id = ANY($1) AND code = 'manual'`,
            [itemIds]
        )

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

        await updateOrderSummaryTax(pool, orderId, taxAmountDollars)
    } catch (e: any) {
        console.error("[compute-tax] persistTaxToOrder failed:", e?.message)
    } finally {
        await pool.end()
    }
}

async function updateOrderSummaryTax(pool: Pool, orderId: string, taxAmountDollars: number): Promise<void> {
    const summaryRes = await pool.query<{ id: string; totals: any; version: number }>(
        `SELECT id, totals, version FROM order_summary
         WHERE order_id = $1 AND deleted_at IS NULL
         ORDER BY version DESC LIMIT 1`,
        [orderId]
    )
    if (!summaryRes.rows[0]) return
    const { id: summaryId, totals } = summaryRes.rows[0]
    const currentTotal: number = parseFloat(totals?.current_order_total ?? "0") || 0
    const subTotal: number = parseFloat(totals?.raw_original_order_total?.value ?? "0") || currentTotal
    const newCurrentTotal = subTotal + taxAmountDollars

    await pool.query(
        `UPDATE order_summary SET totals = $1, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify({
            ...totals,
            tax_total: taxAmountDollars,
            current_order_total: newCurrentTotal,
            accounting_total: newCurrentTotal,
            raw_tax_total: { value: String(taxAmountDollars), precision: 20 },
            raw_current_order_total: { value: String(newCurrentTotal), precision: 20 },
            raw_accounting_total: { value: String(newCurrentTotal), precision: 20 },
            pending_difference: newCurrentTotal,
            raw_pending_difference: { value: String(newCurrentTotal), precision: 20 },
        }), summaryId]
    )
}

async function getStateRate(req: MedusaRequest, province: string): Promise<{ rate: number; reason: string }> {
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
    } catch { }
    if (province === FL_PROVINCE) return { rate: 7, reason: "Florida Sales Tax (7%)" }
    return { rate: 0, reason: `${province} — no rate configured` }
}

/**
 * GET /admin/draft-orders/:id/compute-tax
 *
 * CRITICAL RULE: The GET **never writes** `tax_mode` to metadata.
 * `tax_mode` is a user-only field — only the POST writes it.
 * This prevents any auto-detection from overwriting a manual user choice.
 *
 * Tax mode priority:
 *  1. metadata.tax_mode is set → USE IT ALWAYS (sticky)
 *  2. Not set → auto-detect from customer + address for display only (but don't save)
 *
 * Tax base = items + shipping (FL taxes shipping too)
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const { id } = req.params as { id: string }

    try {
        const base = `http://localhost:${process.env.PORT ?? 9000}`
        const headers = {
            "Cookie": req.headers["cookie"] ?? "",
            "Authorization": req.headers["authorization"] ?? "",
        }

        const orderRes = await fetch(
            `${base}/admin/orders/${id}?fields=+items.*,+items.adjustments.*,+shipping_methods.*,+shipping_address.*,+customer_id,+metadata,+customer.*`,
            { headers }
        )
        if (!orderRes.ok) return void res.status(404).json({ message: "Order not found" })
        const { order } = await orderRes.json()

        // NOTE: /admin/orders returns monetary values in DOLLARS/DECIMALS for draft orders in v2.
        const itemsSubtotal: number = (order?.items ?? []).reduce((sum: number, item: any) =>
            sum + ((item.unit_price ?? 0) * (item.quantity ?? 1)), 0)

        // Compute order-level discount from item adjustments (pre-tax amount stored in DB).
        // This ensures tax is applied on the POST-DISCOUNT subtotal, matching standard accounting.
        const discountTotal: number = (order?.items ?? []).reduce((sum: number, item: any) =>
            sum + (item.adjustments ?? []).reduce((a: number, adj: any) => a + (Number(adj.amount) || 0), 0), 0)
        const discountedSubtotal: number = Math.max(0, itemsSubtotal - discountTotal)

        const shippingMethods: any[] = order?.shipping_methods ?? []
        const hasPickup = shippingMethods.some(m => isPickup(m.name ?? ""))
        const shippingSubtotal: number = shippingMethods.reduce((sum: number, m: any) => sum + (m.amount ?? 0), 0)

        // ── Determine province ─────────────────────────────────────────────────
        const province = hasPickup
            ? FL_PROVINCE
            : ((order?.shipping_address?.province ?? "").toUpperCase() || null)

        // ── Read saved tax_mode (USER-SET ONLY — sticky) ───────────────────────
        const savedMode: string | undefined = order?.metadata?.tax_mode

        // ── Auto-detect for first-time and display (NEVER writes to DB via GET) ─
        let customerIsExempt = false
        try {
            const customerId: string | undefined = order?.customer_id ?? order?.customer?.id
            if (customerId) {
                const custRes = await fetch(`${base}/admin/customers/${customerId}`, { headers })
                if (custRes.ok) {
                    const { customer } = await custRes.json()
                    customerIsExempt = String(customer?.metadata?.is_tax_exempt ?? "").toLowerCase() === "yes"
                }
            }
        } catch { }

        let autoMode: "florida" | "exempt" | "auto" = "auto"
        if (customerIsExempt) autoMode = "exempt"
        else if (hasPickup || province === FL_PROVINCE) autoMode = "florida"
        else if (province && province !== FL_PROVINCE) autoMode = "exempt"

        // Effective mode: respect user override if set, otherwise use auto-detect
        const effectiveMode: string = savedMode && savedMode !== "auto" ? savedMode : autoMode

        // ── Compute amount ─────────────────────────────────────────────────────
        let amount = 0, rate = 0, reason = "", exempt = false

        if (effectiveMode === "exempt") {
            exempt = true
            reason = customerIsExempt ? "Tax Exempt (customer)" : "Tax Exempt (out-of-state)"
            rate = 0; amount = 0
        } else if (effectiveMode === "florida") {
            const fl = await getStateRate(req, FL_PROVINCE)
            rate = fl.rate; reason = fl.reason
            // Tax is computed on the POST-DISCOUNT item subtotal (standard accounting: discount first, then tax).
            const taxableBase = discountedSubtotal
            amount = Math.round(taxableBase * rate / 100 * 100) / 100
        } else {
            reason = "No shipping address set"
        }

        // ── Persist to native Medusa tables ────────────────────────────────────
        await persistTaxToOrder(id, amount, rate)

        // ── Save only computed_tax_* + computed_total via REST — NEVER tax_mode ──
        // tax_mode is only written by the POST endpoint
        const computedTotal = discountedSubtotal + shippingSubtotal + amount
        saveOrderMeta(req, id, {
            computed_tax_amount: amount,
            computed_tax_rate: rate,
            computed_tax_reason: reason,
            computed_total: computedTotal,
            computed_subtotal: itemsSubtotal,
            computed_discount: discountTotal,
        }).catch(() => { }) // fire-and-forget: the computed values are informational

        res.status(200).json({ amount, rate, reason, exempt, mode: effectiveMode, subtotal: itemsSubtotal, shippingSubtotal, autoMode })
    } catch (e: any) {
        console.error("[compute-tax]", e?.message)
        res.status(500).json({ message: e?.message ?? "Failed to compute tax" })
    }
}

/**
 * POST /admin/draft-orders/:id/compute-tax
 * Explicitly set a tax mode override for this order.
 * Body: { mode: "florida" | "exempt" }
 *
 * This is the ONLY way tax_mode gets written to metadata.
 * Uses the admin REST API (draft-orders PATCH) for reliable persistence.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const { id } = req.params as { id: string }
    const { mode } = req.body as { mode: "florida" | "exempt" }

    if (!["florida", "exempt"].includes(mode)) {
        return void res.status(400).json({ message: "Invalid mode. Use: florida | exempt" })
    }

    try {
        // Save tax_mode via the REST admin API — proven reliable for metadata persistence
        await saveOrderMeta(req, id, { tax_mode: mode })
        res.status(200).json({ success: true, mode })
    } catch (e: any) {
        console.error("[compute-tax POST]", e?.message)
        res.status(500).json({ message: e?.message ?? "Failed to set tax mode" })
    }
}
