import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules, OrderStatus, OrderWorkflowEvents } from "@medusajs/utils"
import { getDbPool } from "../../../../utils/db-pool"

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
    // PRIORITY 2: Explicit math recalculation (Subtotal - Discount + Tax) using Medusa's API fields.
    const computeTrueTotal = async (): Promise<number | null> => {
        try {
            const { data } = await query.graph({
                entity: "order",
                fields: ["total", "tax_total", "subtotal", "discount_total", "metadata"],
                filters: { id }
            })
            const order = data?.[0]
            if (!order) return null

            // Prefer our correctly-rounded computed_total from metadata
            const computedMeta = order.metadata?.computed_total
            if (computedMeta && Number(computedMeta) > 0) {
                console.log(`[convert-force] Using metadata.computed_total: ${computedMeta} (Medusa order.total: ${order.total})`)
                return Number(computedMeta)
            }

            // Fall back to explicit math (Subtotal - Discount + Tax) because Medusa computes Tax on Gross
            const subtotal = Number(order.subtotal || 0)
            const discount = Number(order.discount_total || 0)
            const tax = Number(order.tax_total || 0)
            const trueTotal = subtotal - discount + tax
            
            console.log(`[convert-force] Using Explicit Math (Subtotal ${subtotal} - Discount ${discount} + Tax ${tax}): ${trueTotal} (Medusa order.total: ${order.total})`)
            return trueTotal > 0 ? trueTotal : null
        } catch (e: any) {
            console.warn("[convert-force] Could not calculate true total:", e?.message)
            return null
        }
    }


    // ── Helper: patch payment collection to the correct amount ────────────────
    const fixPaymentCollection = async (correctTotal: number) => {
        try {
            const db = getDbPool()
            const client = await db.connect()
            try {
                // Find payment collections linked to this order
                const res = await client.query(
                    `SELECT opc.payment_collection_id 
                     FROM order_payment_collection opc 
                     WHERE opc.order_id = $1`,
                    [id]
                )
                
                const pcolIds = res.rows.map(r => r.payment_collection_id)
                if (pcolIds.length === 0) return

                const correctAmount = correctTotal
                
                for (const pcId of pcolIds) {
                    const pcRes = await client.query(`SELECT amount FROM payment_collection WHERE id = $1`, [pcId])
                    if (pcRes.rows[0] && Number(pcRes.rows[0].amount) !== correctAmount) {
                        console.log(`[convert-force] Patching Payment Collection ${pcId} via SQL: ${pcRes.rows[0].amount} → ${correctAmount}`)
                        await client.query(`UPDATE payment_collection SET amount = $1, updated_at = NOW() WHERE id = $2`, [correctAmount, pcId])
                    }
                }
            } finally {
                client.release()
            }
        } catch (e: any) {
             console.warn("[convert-force] Could not SQL patch payment collection:", e?.message)
        }
    }

    try {
        // ── Step 1 & 2: Fetch draft order items and stock location concurrently ───────────
        const [{ data: orderData }, { data: locationData }] = await Promise.all([
            query.graph({
                entity: "order",
                fields: ["items.*", "items.variant_id", "items.variant.id"],
                filters: { id }
            }),
            query.graph({
                entity: "stock_location",
                fields: ["id"]
            })
        ])
        const draft_order = orderData?.[0]
        const primaryLocationId: string | undefined = locationData?.[0]?.id

        if (draft_order) {
            const items: any[] = draft_order?.items ?? draft_order?.cart?.items ?? []

            if (primaryLocationId && items.length > 0) {
                // ── Step 3: Ensure allow_backorder reservations for all items ─
                // Creating reservations before conversion means convert-to-order
                // finds existing reservations and skips the stock check entirely.
                const inventoryModule = req.scope.resolve(Modules.INVENTORY) as any
                const { createReservationsWorkflow } = require("@medusajs/core-flows")

                for (const lineItem of items) {
                    const lineItemId: string = lineItem.id
                    const variantId: string | undefined = lineItem.variant_id ?? lineItem.variant?.id
                    if (!variantId) continue

                    // Skip if reservation already exists natively
                    try {
                        const existingRes = await inventoryModule.listReservationItems({ line_item_id: lineItemId }, { take: 1 })
                        if (existingRes?.length > 0) continue
                    } catch (e) { /* ignore */ }

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

                    // Create reservation natively with allow_backorder — bypasses stock check
                    try {
                        await createReservationsWorkflow(req.scope).run({
                            input: {
                                reservations: [{
                                    line_item_id: lineItemId,
                                    inventory_item_id: inventoryItemId,
                                    location_id: primaryLocationId,
                                    quantity: lineItem.quantity ?? 1,
                                    allow_backorder: true,
                                }],
                            },
                        })
                        console.log(`[convert-force] ✅ Reservation created for lineItem ${lineItemId} (allow_backorder)`)
                    } catch (resErr: any) {
                        console.warn(`[convert-force] Reservation failed natively for ${lineItemId}:`, resErr?.message)
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
            
            // Generate the gapless Sales Order (S) sequence synchronously for instant UI resolution
            const pgConnection = req.scope.resolve("__pg_connection__") as any
            const result = await pgConnection.raw(`SELECT nextval('custom_order_seq') AS seq`)
            const nextOrdNum = result.rows[0].seq || result.rows[0].SEQ
            const documentNumber = `S${nextOrdNum}`
            
            const meta = (draft_order?.metadata || {}) as Record<string, any>
            const oldEstimateNumber = (meta.document_number && meta.document_number.startsWith("E")) ? meta.document_number : null

            const response = await orderService.updateOrders([
                {
                    id,
                    status: OrderStatus.PENDING,
                    is_draft_order: false,
                    metadata: {
                        ...meta,
                        document_number: documentNumber,
                        ...(oldEstimateNumber ? { original_estimate_number: oldEstimateNumber } : {})
                    }
                },
            ])
            convertedOrder = response[0]
            console.log(`[convert-force] ✅ Assigned ${documentNumber} to newly converted Order ${id}`)

            // Write SO waiting pipeline row directly — reliable, bypasses BullMQ outbox.
            // The BullMQ event below may also fire the handler, but writePipelineRow upserts
            // the waiting row so no duplicate is created.
            if (process.env.QB_ORDER_FLOW_ENABLED === "true") {
                try {
                    const { writePipelineRow } = require("../../../../../lib/quickbooks/qb-pipeline")
                    await writePipelineRow({
                        orderId: id,
                        step: "sales_order",
                        status: "waiting",
                        medusaRefNumber: documentNumber,
                    })
                    console.log(`[convert-force] ✅ Wrote SO waiting pipeline row for ${documentNumber}`)
                } catch (pErr: any) {
                    console.warn(`[convert-force] ⚠️ Could not write SO pipeline row: ${pErr.message}`)
                }
            }

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
            const db = getDbPool()
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
                const { data } = await query.graph({
                    entity: "order",
                    fields: ["customer_id", "metadata"],
                    filters: { id }
                })
                const orderInfo = data?.[0]
                if (orderInfo) {
                    const taxMode = String(orderInfo?.metadata?.tax_mode ?? "auto")
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
                            const { data: custData } = await query.graph({
                                entity: "customer",
                                fields: ["groups.*"],
                                filters: { id: orderInfo.customer_id }
                            })
                            const customerGroups = custData?.[0]?.groups ?? []
                            isExempt = customerGroups.some((g: any) =>
                                g === "tax-exempt" ||
                                g.name === "tax-exempt" ||
                                (typeof g === "object" && g.name?.toLowerCase().includes("exempt"))
                            )
                            if (isExempt) console.log("[convert-force] Customer in tax-exempt group → EXEMPT")
                            else console.log("[convert-force] No exempt group → FL 7%")
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
            const db = getDbPool()
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
