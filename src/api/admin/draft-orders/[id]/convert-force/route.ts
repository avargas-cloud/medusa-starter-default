import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules, OrderStatus, OrderWorkflowEvents } from "@medusajs/utils"
import { Pool } from "pg"

// Lazy singleton pg pool for post-conversion tax line cleanup
let _pool: Pool | null = null
function getConvertPool(): Pool {
    if (!_pool) {
        _pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false },
            max: 2,
        })
    }
    return _pool
}

/**
 * POST /admin/draft-orders/:id/convert-force
 *
 * Converts a draft order to a confirmed order with two key guarantees:
 *
 * 1. BACKORDER SUPPORT: Items with 0 stock are accepted. If Medusa's native
 *    conversion fails due to insufficient inventory, we temporarily enable
 *    allow_backorder on the affected inventory items, retry, then restore.
 *
 * 2. TAX FIDELITY: After conversion, Medusa may re-run its own tax calculation
 *    (e.g., FL Tax Region at 7%) on top of our custom tax_lines, causing the
 *    payment collection amount to be inflated (double-counted tax).
 *    We fix this by reading the `current_order_total` that our compute-tax
 *    already stored in order_summary, then patching the payment collection
 *    to use that exact value—preserving the exact tax decision made in the
 *    draft (including 0% for tax-exempt customers, non-FL addresses, etc).
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const { id } = req.params as { id: string }
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

    const base = `http://localhost:${process.env.PORT ?? 9000}`
    const authHeaders: Record<string, string> = {
        "Cookie": String(req.headers["cookie"] ?? ""),
        "Authorization": String(req.headers["authorization"] ?? ""),
        "Content-Type": "application/json",
    }

    // ── Helper: compute the true order total ──────────────────────────────────
    // PRIORITY 1: metadata.computed_total — saved by compute-tax using correctly-rounded
    //             discount logic (Math.round per component), avoiding Medusa's fractional
    //             accumulation that can cause 1 cent errors (e.g. $84.28 instead of $84.27).
    // PRIORITY 2: order.total from Medusa API — fallback if compute-tax was never called.
    const computeTrueTotal = async (): Promise<number | null> => {
        try {
            const orderRes = await fetch(
                `${base}/admin/orders/${id}?fields=total,tax_total,subtotal,discount_total,+metadata`,
                { headers: authHeaders }
            )
            if (!orderRes.ok) return null
            const { order } = await orderRes.json()
            if (!order) return null

            // Prefer our correctly-rounded computed_total from metadata
            const computedMeta = order.metadata?.computed_total
            if (computedMeta && Number(computedMeta) > 0) {
                console.log(`[convert-force] Using metadata.computed_total: ${computedMeta} (Medusa order.total: ${order.total})`)
                return Number(computedMeta)
            }

            // Fall back to Medusa's order.total (may be 1 cent off due to fractional promotions)
            console.log(`[convert-force] Using Medusa order.total: ${order.total} (no computed_total in metadata)`)
            return order.total > 0 ? order.total : null
        } catch (e: any) {
            console.warn("[convert-force] Could not fetch order total:", e?.message)
            return null
        }
    }


    // ── Helper: patch payment collection to the correct amount ────────────────
    const fixPaymentCollection = async (correctTotal: number) => {
        try {
            // Fetch the order's payment collections
            const pcRes = await fetch(
                `${base}/admin/payment-collections?order_id=${id}`,
                { headers: authHeaders }
            )
            if (!pcRes.ok) return

            const pcJson = await pcRes.json()
            const collections: any[] = pcJson.payment_collections ?? []

            for (const col of collections) {
                // Amount in payment collection is in cents; our total is in dollars
                const correctCents = Math.round(correctTotal * 100)
                if (col.amount === correctCents) continue  // already correct

                console.log(`[convert-force] Patching payment collection ${col.id}: ${col.amount} → ${correctCents} cents`)
                await fetch(`${base}/admin/payment-collections/${col.id}`, {
                    method: "POST",
                    headers: authHeaders,
                    body: JSON.stringify({ amount: correctCents }),
                })
            }
        } catch (e: any) {
            console.warn("[convert-force] Could not patch payment collection:", e?.message)
        }
    }

    try {
        // ── Step 1: Fetch draft order items ───────────────────────────────────
        // Get items from the DRAFT (not confirmed order) to create reservations
        // proactively — avoids the try → fail → fix → retry anti-pattern.
        const draftRes = await fetch(`${base}/admin/draft-orders/${id}`, { headers: authHeaders })
        if (draftRes.ok) {
            const { draft_order } = await draftRes.json()
            const items: any[] = draft_order?.items ?? draft_order?.cart?.items ?? []

            // ── Step 2: Get the primary stock location ────────────────────────
            const slRes = await fetch(`${base}/admin/stock-locations?limit=100`, { headers: authHeaders })
            const slJson = slRes.ok ? await slRes.json() : {}
            const primaryLocationId: string | undefined = (slJson.stock_locations ?? [])[0]?.id

            if (primaryLocationId && items.length > 0) {
                // ── Step 3: Ensure allow_backorder reservations for all items ─
                // Creating reservations before conversion means convert-to-order
                // finds existing reservations and skips the stock check entirely.
                for (const lineItem of items) {
                    const lineItemId: string = lineItem.id
                    const variantId: string | undefined = lineItem.variant_id ?? lineItem.variant?.id
                    if (!variantId) continue

                    // Skip if reservation already exists
                    const resRes = await fetch(`${base}/admin/reservations?line_item_id[]=${lineItemId}&limit=5`, { headers: authHeaders })
                    const resJson = resRes.ok ? await resRes.json() : {}
                    if ((resJson.reservations ?? []).length > 0) continue

                    // Find the inventory item for this variant
                    const { data: variants } = await query.graph({
                        entity: "variant",
                        fields: ["id", "inventory_items.inventory_item_id"],
                        filters: { id: variantId }
                    })
                    const inventoryItemId = variants[0]?.inventory_items?.[0]?.inventory_item_id
                    if (!inventoryItemId) {
                        console.warn(`[convert-force] No inventory item for variant ${variantId}, skipping reservation`)
                        continue
                    }

                    // Create reservation with allow_backorder — bypasses stock check
                    const createRes = await fetch(`${base}/admin/reservations`, {
                        method: "POST",
                        headers: authHeaders,
                        body: JSON.stringify({
                            line_item_id: lineItemId,
                            inventory_item_id: inventoryItemId,
                            location_id: primaryLocationId,
                            quantity: lineItem.quantity ?? 1,
                            allow_backorder: true,
                        }),
                    })
                    if (!createRes.ok) {
                        const err = await createRes.json().catch(() => ({}))
                        console.warn(`[convert-force] Reservation failed for ${lineItemId}:`, err?.message)
                    } else {
                        console.log(`[convert-force] ✅ Reservation created for lineItem ${lineItemId} (allow_backorder)`)
                    }
                }
            }
        } else {
            console.warn(`[convert-force] Could not fetch draft order ${id} — proceeding without reservation pre-creation`)
        }

        // ── Step 4: Convert draft → confirmed order natively (bypassing stock reservation block) ────────
        let convertedOrder
        try {
            const orderService = req.scope.resolve(Modules.ORDER)
            const response = await orderService.updateOrders([
                {
                    id,
                    status: OrderStatus.PENDING,
                    is_draft_order: false,
                },
            ])
            convertedOrder = response[0]
            
            // Emit the PLACED event purely natively so subscribers like QBDraftOrderSync react properly.
            if (convertedOrder) {
                const eventBus = req.scope.resolve(Modules.EVENT_BUS)
                await eventBus.emit({
                    name: OrderWorkflowEvents.PLACED,
                    data: { id: convertedOrder.id }
                })
            }
            
        } catch (cvErr: any) {
            console.error(`[convert-force] Direct API Conversion failed:`, cvErr?.message)
            return void res.status(500).json({ message: cvErr?.message ?? "Conversion failed natively" })
        }

        // ── Step 5: Fix payment collection total (post-conversion) ───────────
        const correctTotal = await computeTrueTotal()
        if (correctTotal !== null) {
            await fixPaymentCollection(correctTotal)
        }

        // ── Step 6: Remove duplicate tax lines (defensive) ────────────────────
        // Deletes any 'manual' or other non-POS-generated tax lines that may
        // have been added by Medusa's engine before or during conversion.
        // Note: order_line_item_tax_line has no 'amount' column — amounts are
        // computed dynamically. The tax-fix-subscriber also handles this
        // asynchronously after order.placed fires.
        try {
            const db = getConvertPool()
            const client = await db.connect()
            try {
                const del = await client.query(
                    `DELETE FROM order_line_item_tax_line
                     WHERE item_id IN (SELECT item_id FROM order_item WHERE order_id = $1)
                     AND code NOT IN ('FL', 'FL-SHIPPING', 'EXEMPT')`,
                    [id]
                )
                if (del.rowCount && del.rowCount > 0) {
                    console.log(`[convert-force] ✅ Removed ${del.rowCount} duplicate tax lines post-conversion`)
                }
            } finally {
                client.release()
            }
        } catch (taxFixErr: any) {
            console.warn(`[convert-force] ⚠️ Post-conversion tax fix soft-failed: ${taxFixErr?.message}`)
        }

        // ── Step 7: Inject tax lines using pos-tax provider logic ─────────────
        // Primary source: order.metadata.tax_mode ('exempt' | 'florida' | 'auto')
        // set by the POS tax dropdown. Fallback: customer "tax-exempt" group.
        try {
            // 7a. Read order metadata and customer info
            let isExempt = false
            try {
                const orderInfoRes = await fetch(
                    `${base}/admin/orders/${id}?fields=customer_id,+metadata`,
                    { headers: authHeaders }
                )
                if (orderInfoRes.ok) {
                    const { order: orderInfo } = await orderInfoRes.json()
                    const taxMode: string = orderInfo?.metadata?.tax_mode ?? "auto"
                    console.log(`[convert-force] order.metadata.tax_mode = "${taxMode}"`)

                    if (taxMode === "exempt") {
                        // Explicitly set to exempt in POS dropdown
                        isExempt = true
                        console.log("[convert-force] tax_mode=exempt → EXEMPT")
                    } else if (taxMode === "florida") {
                        // Explicitly set to FL → force FL regardless of customer group
                        isExempt = false
                        console.log("[convert-force] tax_mode=florida → FL 7%")
                    } else {
                        // 'auto' or missing → check customer group (mirrors pos-tax service.ts)
                        if (orderInfo?.customer_id) {
                            const custRes = await fetch(
                                `${base}/admin/customers/${orderInfo.customer_id}?fields=id,+groups`,
                                { headers: authHeaders }
                            )
                            if (custRes.ok) {
                                const { customer } = await custRes.json()
                                const groups: any[] = customer?.groups ?? []
                                isExempt = groups.some(g =>
                                    g === "tax-exempt" ||
                                    g.name === "tax-exempt" ||
                                    (typeof g === "object" && g.name?.toLowerCase().includes("exempt"))
                                )
                                if (isExempt) console.log("[convert-force] Customer in tax-exempt group → EXEMPT")
                                else console.log("[convert-force] No exempt group → FL 7%")
                            }
                        }
                    }
                }
            } catch { /* non-fatal, fall through to FL */ }

            // 7b. Tax parameters (mirrors pos-tax service.ts identifier constants)
            const taxRate = isExempt ? 0 : 7
            const taxCode = isExempt ? "EXEMPT" : "FL"
            const taxDesc = isExempt ? "Tax Exempt" : "Florida Sales Tax"
            console.log(`[convert-force] Tax decision: ${taxCode} @ ${taxRate}%`)


            // 7c. Insert tax lines via SQL
            const db = getConvertPool()
            const client = await db.connect()
            try {
                const itemsRes = await client.query<{ item_id: string }>(
                    `SELECT DISTINCT oi.item_id FROM order_item oi WHERE oi.order_id = $1 AND oi.deleted_at IS NULL`,
                    [id]
                )
                const itemIds = itemsRes.rows.map(r => r.item_id)

                if (itemIds.length > 0) {
                    // Delete existing tax lines (belt-and-suspenders after Step 6)
                    await client.query(
                        `DELETE FROM order_line_item_tax_line WHERE item_id = ANY($1)`,
                        [itemIds]
                    )

                    const rawRate = JSON.stringify({ value: String(taxRate), precision: 20 })
                    const genId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

                    for (const itemId of itemIds) {
                        await client.query(
                            `INSERT INTO order_line_item_tax_line (id, item_id, code, rate, raw_rate, description, created_at, updated_at)
                             VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
                            [genId("taxline"), itemId, taxCode, taxRate, rawRate, taxDesc]
                        )
                    }
                    console.log(`[convert-force] ✅ Inserted ${taxCode} @ ${taxRate}% for ${itemIds.length} items`)

                    // 7d. Re-fetch live tax_total — decorateCartTotals with adjustments
                    // computes the correct post-discount amount: rate × (subtotal − discount)
                    let liveTaxTotal = 0
                    try {
                        const taxFetch = await fetch(`${base}/admin/orders/${id}?fields=tax_total`, { headers: authHeaders })
                        if (taxFetch.ok) {
                            const { order: taxOrder } = await taxFetch.json()
                            liveTaxTotal = Number(taxOrder?.tax_total ?? 0)
                            console.log(`[convert-force] Live tax_total = $${liveTaxTotal.toFixed(2)}`)
                        }
                    } catch { /* non-fatal */ }

                    // 7e. Update order_summary with tax and corrected totals
                    const sumRes = await client.query<{ id: string; totals: any }>(
                        `SELECT id, totals FROM order_summary
                         WHERE order_id = $1 AND deleted_at IS NULL
                         ORDER BY version DESC LIMIT 1`,
                        [id]
                    )
                    if (sumRes.rows[0]) {
                        const { id: sumId, totals } = sumRes.rows[0]
                        const discountTotal = Number(totals.discount_total || 0)
                        const newTotal = Number(totals.original_order_total || 0) + liveTaxTotal - discountTotal
                        await client.query(
                            `UPDATE order_summary SET totals = $1, updated_at = NOW() WHERE id = $2`,
                            [JSON.stringify({
                                ...totals,
                                tax_total: liveTaxTotal,
                                raw_tax_total: { value: String(liveTaxTotal), precision: 20 },
                                accounting_total: newTotal,
                                raw_accounting_total: { value: String(newTotal), precision: 20 },
                                current_order_total: newTotal,
                                raw_current_order_total: { value: String(newTotal), precision: 20 },
                                pending_difference: newTotal,
                                raw_pending_difference: { value: String(newTotal), precision: 20 },
                            }), sumId]
                        )
                        console.log(`[convert-force] ✅ order_summary: tax=$${liveTaxTotal.toFixed(2)} total=$${newTotal.toFixed(2)}`)
                        await fixPaymentCollection(newTotal)
                    }
                }
            } finally {
                client.release()
            }
        } catch (taxInjErr: any) {
            console.warn(`[convert-force] ⚠️ Tax injection soft-failed: ${taxInjErr?.message}`)
        }


        // Stamp order_placed_at so POS activity log shows correct creation time

        try {
            await fetch(`${base}/admin/orders/${id}`, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify({ metadata: { order_placed_at: new Date().toISOString() } }),
            })
            console.log(`[convert-force] ✅ Stamped order_placed_at on order ${id}`)
        } catch (metaErr: any) {
            console.warn(`[convert-force] ⚠️ Could not stamp order_placed_at: ${metaErr?.message}`)
        }

        return void res.status(200).json({ order: convertedOrder })
    } catch (e: any) {
        console.error("[convert-force]", e?.message)
        res.status(500).json({ message: e?.message ?? "Conversion failed" })
    }
}
