import { completeCartWorkflow } from "@medusajs/medusa/core-flows"
import { StepResponse } from "@medusajs/framework/workflows-sdk"
import { Modules } from "@medusajs/utils"
import { FINANCE_MODULE } from "../../modules/finance"
import { processPaymentCaptureInQb, ensureCustomerInQb } from "../../lib/quickbooks/order-flow-core"
import { writePipelineRow } from "../../lib/quickbooks/qb-pipeline"
// Workaround for Medusa's exported types missing the internal hooks:
const hooks = completeCartWorkflow.hooks as any

hooks.orderCreated(
    async ({ order_id }: { order_id: string }, { container }: { container: any }) => {
        const query = container.resolve("query")
        const orderModuleService = container.resolve("order")

        console.log(`\n================================================`)
        console.log(`Evento 1: Hook 'orderCreated' (maintain-cart-prices.ts) INTERCEPTING Order`)
        console.log(`================================================`)
        console.log(`Order ID: ${order_id}`)

        // 1. Fetch the newly created order along with its line items
        const { data: orders } = await query.graph({
            entity: "order",
            fields: [
                "id",
                "customer_id",
                "metadata",
                "total",
                "subtotal",
                "tax_total",
                "shipping_total",
                "items.*",
                "items.item.*"
            ],
            filters: { id: order_id }
        })

        if (!orders.length) return new StepResponse(null)
        const order = orders[0]

        console.log(`\nOrder Current Totals:`)
        console.log(`  Subtotal:       ${order.subtotal}`)
        console.log(`  Tax Total:      ${order.tax_total}`)
        console.log(`  Shipping Total: ${order.shipping_total}`)
        console.log(`  Total Final:    ${order.total}`)

        if (order.items && order.items.length > 0) {
            order.items.forEach((item: any, i: number) => {
                console.log(`\n--- [Item ${i + 1}] Estado Inicial del order_item ---`)
                console.log(`  Título:        ${item.title || item.item?.title}`)
                console.log(`  Variant ID:    ${item.variant_id || item.item?.variant_id}`)
                console.log(`  Quantity:      ${item.quantity}`)
                console.log(`  Raw Quantity:  `, JSON.stringify(item.raw_quantity))
                console.log(`  Unit Price     (order_item): ${item.unit_price}`)
                console.log(`  Raw Unit Price (order_item):`, JSON.stringify(item.raw_unit_price))
                console.log(`  Unit Price     (order_line_item): ${item.item?.unit_price}`)
                console.log(`------------------------------------\n`)
            })
        }

        // 2. Prepare the updates
        const itemsToUpdate = order.items
            .filter((orderItem: any) => orderItem.unit_price == null && orderItem.item?.unit_price != null)
            .map((orderItem: any) => ({
                id: orderItem.id,
                unit_price: orderItem.item.unit_price,
            }))

        if (itemsToUpdate.length > 0) {
            console.log(`\n================================================`)
            console.log(`Evento 2: Fix de precios en Hook (Ejecutando updateOrderItems)`)
            console.log(`================================================`)
            console.log(`Se detectaron ${itemsToUpdate.length} items con unit_price nulo.`)
            console.log(`Datos a enviar a updateOrderItems:`, JSON.stringify(itemsToUpdate, null, 2))

            // 3. Update the items natively
            await orderModuleService.updateOrderItems(itemsToUpdate)

            console.log(`================================================\n`)
        } else {
            console.log(`\n================================================`)
            console.log(`Evento 2: Evaluación Completada (Ningún fix requerido)`)
            console.log(`================================================`)
            console.log(`Todos los ítems nacieron con unit_price persistido. No se necesita alterar nada.\n`)
        }

        // Re-emit order.placed so subscribers receive it reliably.
        // Medusa's internal emitEventStep goes to Redis async and is not
        // consistently delivered in the dev environment.
        try {
            const eventBusService = container.resolve(Modules.EVENT_BUS) as any
            await eventBusService.emit({ eventName: "order.placed", data: { id: order_id } })
            console.log(`[maintain-cart-prices] 📡 Emitted order.placed for ${order_id}`)
        } catch (emitErr: any) {
            console.warn(`[maintain-cart-prices] ⚠️ Could not emit order.placed: ${emitErr.message}`)
        }

        // ── Finance AR Ledger + QB Sync ──────────────────────────────────────────
        // Mirror web payments into the Finance ledger synchronously here, since
        // the Redis event bus does not reliably deliver payment.captured to subscribers.
        // Safety: this hook only runs when the order was successfully created (payment passed).
        // Declined payments abort the workflow before orderCreated fires.
        try {
            // Skip POS orders — their payments are handled via pos.payment.created
            if (order.metadata?.pos_created === true) {
                console.log(`[finance-hook] Skipping POS order ${order_id}`)
            } else if (!order.customer_id) {
                console.log(`[finance-hook] Guest checkout (no customer_id) — skipping AR ledger for ${order_id}`)
            } else {
                // Fetch order with payment data
                const { data: ordersWithPayments } = await query.graph({
                    entity: "order",
                    fields: [
                        "id",
                        "display_id",
                        "customer_id",
                        "metadata",
                        "payment_collections.payments.id",
                        "payment_collections.payments.amount",
                        "payment_collections.payments.provider_id",
                        "payment_collections.payments.captured_at",
                    ],
                    filters: { id: order_id },
                })

                const orderWithPayments = ordersWithPayments?.[0]
                const payments: Array<any> = []
                for (const pc of orderWithPayments?.payment_collections ?? []) {
                    for (const p of pc?.payments ?? []) {
                        if (p?.id) payments.push(p)
                    }
                }

                if (payments.length === 0) {
                    console.warn(`[finance-hook] No payments found for order ${order_id}`)
                } else {
                    const financeService = container.resolve(FINANCE_MODULE)
                    const customerModule = container.resolve(Modules.CUSTOMER)

                    // Get customer QB ID (for QB sync)
                    let qbCustomerId: string | null = null
                    try {
                        const customer = await customerModule.retrieveCustomer(order.customer_id as string, { select: ["id", "metadata", "first_name", "last_name", "email", "phone"] as any })
                        qbCustomerId = (customer as any).metadata?.qb_list_id ?? null
                        if (!qbCustomerId) {
                            const custResult = await ensureCustomerInQb(customer as any, customerModule as any, (msg: string) => console.log(msg))
                            qbCustomerId = custResult?.qbCustomerId ?? null
                        }
                    } catch (custErr: any) {
                        console.warn(`[finance-hook] Could not get QB customer ID: ${custErr.message}`)
                    }

                    for (const payment of payments) {
                        // Medusa v2 stores payment.amount in dollars (e.g. 69.8275)
                        // Finance ledger stores in cents to match POS convention
                        const amountCents = Math.round(Number(payment.amount) * 100)
                        const amountDollars = amountCents / 100

                        // Idempotency check
                        const existing = await financeService.listCustomerPayments({ medusa_payment_id: payment.id })
                        if (existing && existing.length > 0) {
                            console.log(`[finance-hook] Payment ${payment.id} already in ledger — skipping`)
                            continue
                        }

                        const cpay = await financeService.createCustomerPayments({
                            customer_id: order.customer_id as string,
                            amount: amountCents,
                            method: 'card',
                            reference: payment.provider_id || null,
                            received_at: payment.captured_at ? new Date(payment.captured_at as string) : new Date(),
                            created_by: 'system',
                            source: 'web',
                            type: 'payment',
                            status: 'available',
                            medusa_payment_id: payment.id,
                            medusa_payment_synced: true,
                            locked_order_id: order_id,
                        })

                        const cpayId = Array.isArray(cpay) ? cpay[0]?.id : (cpay as any)?.id
                        console.log(`[finance-hook] ✅ Finance ledger entry created: $${amountDollars} (${amountCents}¢) — payment ${payment.id} → customer ${order.customer_id}`)

                        // ── QB Sync ──────────────────────────────────────────────
                        if (qbCustomerId && cpayId) {
                            try {
                                await writePipelineRow({
                                    orderId: order_id,
                                    referenceId: cpayId,
                                    referenceType: "customer_payment",
                                    step: "payment",
                                    status: "pending",
                                    medusaRefNumber: order.metadata?.document_number as string || undefined,
                                })

                                const qbResult = await processPaymentCaptureInQb({
                                    orderId: order_id,
                                    orderDisplayId: orderWithPayments?.display_id,
                                    amount: amountDollars,
                                    paymentMethod: "Credit Card",
                                    qbCustomerId,
                                    memo: `Web Order ${order.metadata?.document_number || order_id}`,
                                    onSubmitted: async (operationId) => {
                                        await writePipelineRow({
                                            orderId: order_id,
                                            referenceId: cpayId,
                                            referenceType: "customer_payment",
                                            step: "payment",
                                            status: "submitted",
                                            bridgeOpId: operationId,
                                        })
                                    },
                                })

                                if (qbResult.error) {
                                    console.error(`[finance-hook] ❌ QB sync failed: ${qbResult.error}`)
                                    await writePipelineRow({ orderId: order_id, referenceId: cpayId, step: "payment", status: "failed", error: qbResult.error })
                                } else if (!qbResult.skipped) {
                                    console.log(`[finance-hook] ✅ QB payment synced — txnId: ${qbResult.txnId}`)
                                    await writePipelineRow({ orderId: order_id, referenceId: cpayId, step: "payment", status: "confirmed" })
                                }
                            } catch (qbErr: any) {
                                console.error(`[finance-hook] ❌ QB sync error: ${qbErr.message}`)
                            }
                        } else {
                            console.warn(`[finance-hook] ⚠️ QB sync skipped — no qbCustomerId for customer ${order.customer_id}`)
                        }
                        // ─────────────────────────────────────────────────────────
                    }
                }
            }
        } catch (financeErr: any) {
            // Non-fatal: log but don't fail the order creation
            console.error(`[finance-hook] ❌ Error in finance/QB sync for ${order_id}:`, financeErr.message)
        }
        // ────────────────────────────────────────────────────────────────────────

        return new StepResponse(null)
    }
)
