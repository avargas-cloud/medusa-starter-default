import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Modules } from "@medusajs/utils"
import { updateOrderTaxLinesWorkflow } from "@medusajs/core-flows"
import { Pool } from "pg"

// Lazy DB pool singleton for idempotent tax line cleanup.
// Uses the same DATABASE_URL as the rest of the backend.
let _taxCleanupPool: Pool | null = null
function getTaxCleanupPool(): Pool {
    if (!_taxCleanupPool) {
        _taxCleanupPool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false },
            max: 2,
        })
    }
    return _taxCleanupPool
}

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
    const patchRes = await fetch(`${base}/admin/draft-orders/${id}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ metadata: { ...prevMeta, ...fields } }),
    })
    
    if (!patchRes.ok) {
        console.warn(`[compute-tax] Failed to save metadata on draft order: ${await patchRes.text()}`)
    }
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
        // To match POS and QuickBooks exactly, we MUST calculate in CENTS and match the POS rounding phases.
        const itemsSubtotalCents: number = (order?.items ?? []).reduce((sum: number, item: any) =>
            sum + (Math.round((item.unit_price ?? 0) * 100) * (item.quantity ?? 1)), 0)

        // POS MATH: Order discounts are accumulated unrounded, then ROUNDED BEFORE subtracting from subtotal.
        const unroundedDiscountCents: number = (order?.items ?? []).reduce((sum: number, item: any) =>
            sum + (item.adjustments ?? []).reduce((a: number, adj: any) => a + (Math.abs(Number(adj.amount) || 0) * 100), 0), 0)
        
        const roundedDiscountCents = Math.round(unroundedDiscountCents)
        const discountedSubtotalCents: number = Math.max(0, itemsSubtotalCents - roundedDiscountCents)

        const shippingMethods: any[] = order?.shipping_methods ?? []
        const hasPickup = shippingMethods.some(m => isPickup(m.name ?? ""))
        const shippingSubtotalCents: number = shippingMethods.reduce((sum: number, m: any) => sum + Math.round((m.amount ?? 0) * 100), 0)

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
            rate = 0
            amount = 0
            reason = customerIsExempt ? "Tax Exempt (customer)" : "Tax Exempt (out-of-state)"
        } else if (effectiveMode === "florida") {
            const fl = await getStateRate(req, FL_PROVINCE)
            rate = fl.rate
            reason = fl.reason
        } else {
            rate = 0
            amount = 0
            reason = "No shipping address set"
        }

        // ── Native Tax Recalculation (idempotent) ─────────────────────────────
        // CRITICAL: Delete existing tax lines BEFORE calling the workflow.
        // updateOrderTaxLinesWorkflow APPENDS new lines on every call — we
        // must wipe them first so each recalculation is idempotent.
        // We use pg directly because the Order Module service doesn't expose
        // list/delete tax line methods in this version of Medusa.
        try {
            const db = getTaxCleanupPool()
            const client = await db.connect()
            try {
                // Delete item tax lines via order_item join (confirmed schema)
                const delItemResult = await client.query(
                    `DELETE FROM order_line_item_tax_line
                     WHERE item_id IN (
                         SELECT item_id FROM order_item WHERE order_id = $1
                     )`,
                    [id]
                )
                if (delItemResult.rowCount && delItemResult.rowCount > 0) {
                    console.log(`[compute-tax] Cleared ${delItemResult.rowCount} stale item tax lines`)
                }

                // Delete shipping method tax lines (best-effort, soft schema)
                await client.query(
                    `DELETE FROM order_shipping_method_tax_line
                     WHERE shipping_method_id IN (
                         SELECT osm.id
                         FROM order_shipping_method osm
                         JOIN order_shipping os ON os.order_id = $1
                     )`,
                    [id]
                ).catch(() => { /* schema differences — ignore */ })
            } finally {
                client.release()
            }
        } catch (cleanupErr: any) {
            console.warn("[compute-tax] Tax line cleanup soft-failed:", cleanupErr?.message)
        }

        // Now call the workflow — pos-tax provider will create fresh, correct lines
        await updateOrderTaxLinesWorkflow(req.scope).run({
            input: { order_id: id }
        }).catch((e: any) => {
            console.error("[compute-tax] Native Tax workflow soft-failed:", e?.message)
        })

        // ── Fetch rate from the created tax lines ──────────────────────────────
        const taxLineRes = await fetch(
            `${base}/admin/orders/${id}?fields=id,+items.tax_lines.*`,
            { headers }
        )
        const { order: taxLineOrder } = taxLineRes.ok ? await taxLineRes.json() : { order: null }
        const sampleTaxLine = taxLineOrder?.items?.[0]?.tax_lines?.[0]
        rate = sampleTaxLine?.rate ?? (exempt ? 0 : 7)

        // ── Compute correct discount-aware amount ──────────────────────────────
        // POS parity: Tax applies on the aggregate rounded taxable amount.
        if (!exempt) {
            amount = Math.round(discountedSubtotalCents * (rate / 100)) / 100
        }

        // ── Post-workflow DB fix ───────────────────────────────────────────────
        // Problem: after the workflow, the DB has BOTH:
        //   • "FL" lines from pos-tax provider (code='FL', wrong amount — pre-discount)
        //   • "manual" lines from Medusa's own engine (duplicate!)
        // Fix: (1) delete the "manual" duplicates, (2) update FL amounts to correct value.
        try {
            const db = getTaxCleanupPool()
            const client = await db.connect()
            try {
                // 1. Remove "manual" / stray lines Medusa's engine added on top
                const delManual = await client.query(
                    `DELETE FROM order_line_item_tax_line
                     WHERE item_id IN (SELECT item_id FROM order_item WHERE order_id = $1)
                     AND code NOT IN ('FL', 'FL-SHIPPING', 'EXEMPT')`,
                    [id]
                )
                if (delManual.rowCount && delManual.rowCount > 0) {
                    console.log(`[compute-tax] Removed ${delManual.rowCount} duplicate "manual" tax lines`)
                }

                // 2. Note: order_line_item_tax_line only stores `rate`, not `amount`.
                //    Tax amounts shown in Medusa admin are computed dynamically as
                //    rate × unit_price × qty — we cannot update them via SQL.
                //    Our POS (computeTotals) and payment collection use
                //    metadata.computed_total which correctly accounts for discounts.
            } finally {
                client.release()
            }
        } catch (fixErr: any) {
            console.warn("[compute-tax] Post-workflow DB fix soft-failed:", fixErr?.message)
        }

        const itemsSubtotal = itemsSubtotalCents / 100
        const discountTotal = roundedDiscountCents / 100
        const shippingSubtotal = shippingSubtotalCents / 100
        
        console.log(`[compute-tax] Discount-aware tax: $${amount} @ ${rate}% | subtotal=$${itemsSubtotal} discount=$${discountTotal} taxable=$${discountedSubtotalCents/100} (mode: ${effectiveMode})`)

        // ── Save computed totals to metadata (fire-and-forget) ─────────────────
        const computedTotal = (discountedSubtotalCents + shippingSubtotalCents) / 100 + amount
        saveOrderMeta(req, id, {
            computed_tax_amount: amount,
            computed_tax_rate: rate,
            computed_tax_reason: reason,
            computed_total: computedTotal,
            computed_subtotal: itemsSubtotal,
            computed_discount: discountTotal,
        }).catch(() => {})

        res.status(200).json({ amount, rate, reason, exempt, mode: effectiveMode, subtotal: itemsSubtotal, shippingSubtotal, autoMode })
    } catch (e: any) {
        console.error("[compute-tax] GET Error:", e?.message)
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
