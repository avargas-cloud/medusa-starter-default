/**
 * order-flow-core.ts
 *
 * Orchestrates the complete QuickBooks flow when an order is placed in Medusa.
 *
 * DISABLED BY DEFAULT: Controlled by QB_ORDER_FLOW_ENABLED env var.
 * DRY RUN: Set QB_DRY_RUN=true to simulate without writing to QuickBooks.
 *
 * Flow:
 *   1. Check if customer already has qb_list_id in metadata
 *   2. If not → create customer in QB (bridge) → save ListID to customer metadata
 *   3. Create Sales Order in QB → save TxnID to order metadata
 *
 * Future (when QB_INVENTORY_DEDUCT_ENABLED=true):
 *   4. Adjust inventory in QB for each ordered item
 *
 * Called from: src/api/middlewares.ts (POST /store/orders interceptor)
 *
 * Env vars:
 *   QB_ORDER_FLOW_ENABLED=false   — set to "true" to activate
 *   QB_DRY_RUN=false              — set to "true" to simulate without writing to QB
 *   QB_INVENTORY_DEDUCT_ENABLED=false — set to "true" to deduct inventory per order in QB
 */

import { buildQbCustomerName } from "./build-customer-name"
import {
    checkBridgeHealth,
    createCustomerInQb,
    createSalesOrderInQb,
    QbOrderItem
} from "./qb-bridge-client"
import { isQbIntegrationEnabled } from "./qb-integration-guard"

const ORDER_FLOW_ENABLED = process.env.QB_ORDER_FLOW_ENABLED === "true"
const DRY_RUN = process.env.QB_DRY_RUN === "true"

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface MedusaOrderForQb {
    id: string
    display_id?: number
    metadata?: Record<string, any>
    customer?: {
        id: string
        email?: string
        first_name?: string | null
        last_name?: string | null
        company_name?: string | null
        phone?: string | null
        metadata?: Record<string, any>
        addresses?: Array<{
            address_1?: string
            city?: string
            province?: string
            postal_code?: string
        }>
    }
    items?: Array<{
        variant?: {
            sku?: string
            metadata?: Record<string, any>
        }
        product_title?: string
        quantity: number
        unit_price: number   // in cents (Medusa v2)
        metadata?: Record<string, any>
    }>
    created_at?: string | Date
}

export interface OrderFlowResult {
    enabled: boolean
    dryRun?: boolean
    skipped?: boolean
    skipReason?: string
    customerId?: string   // QB ListID (new or existing)
    soTxnId?: string      // QB Sales Order TxnID
    error?: string
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

export async function processOrderInQb(
    order: MedusaOrderForQb,
    customerModule: any   // Medusa ICustomerModuleService
): Promise<OrderFlowResult> {
    // Guard: feature flag
    if (!ORDER_FLOW_ENABLED) {
        return { enabled: false, skipped: true, skipReason: "QB_ORDER_FLOW_ENABLED is false" }
    }

    // Guard: master integration kill switch
    if (!(await isQbIntegrationEnabled())) {
        return { enabled: false, skipped: true, skipReason: "QB integration is disabled globally" }
    }

    const prefix = DRY_RUN ? "[QB DRY RUN]" : "[QB]"
    console.log(`${prefix} Processing order #${order.display_id || order.id} in QuickBooks...`)

    try {
        // 1. Health check (fast — non-blocking if bridge is down)
        const healthy = await checkBridgeHealth()
        if (!healthy && !DRY_RUN) {
            console.warn(`[QB] ⚠️ Bridge health check failed. Order #${order.display_id} will NOT be sent to QB.`)
            return { enabled: true, skipped: true, skipReason: "Bridge unreachable" }
        }

        // 2. Ensure customer exists in QB
        const customer = order.customer
        if (!customer) {
            return { enabled: true, skipped: true, skipReason: "Order has no customer data" }
        }

        let qbCustomerId: string = customer.metadata?.qb_list_id

        if (!qbCustomerId) {
            console.log(`${prefix} Customer ${customer.id} has no qb_list_id — creating in QB...`)

            const billingAddress = customer.addresses?.[0]
            const qbName = buildQbCustomerName(customer)

            const createResult = await createCustomerInQb({
                Name: qbName,
                CompanyName: customer.company_name || undefined,
                Email: customer.email,
                Phone: customer.phone || undefined,
                BillAddress: billingAddress ? {
                    Addr1: billingAddress.address_1,
                    City: billingAddress.city,
                    State: billingAddress.province,
                    PostalCode: billingAddress.postal_code,
                } : undefined,
            })

            if (!createResult.success) {
                console.error(`[QB] ❌ Failed to create customer in QB: ${createResult.error}`)
                return { enabled: true, error: `Customer creation failed: ${createResult.error}` }
            }

            qbCustomerId = createResult.data!.listId

            // Save QB ListID back to Medusa customer metadata (skip on dry run)
            if (!DRY_RUN && qbCustomerId !== "DRY_RUN_ID") {
                try {
                    await customerModule.updateCustomers(customer.id, {
                        metadata: {
                            ...(customer.metadata || {}),
                            qb_list_id: qbCustomerId,
                            qb_name: qbName,
                        }
                    })
                    console.log(`${prefix} ✅ Saved qb_list_id="${qbCustomerId}" to customer ${customer.id}`)
                } catch (metaErr: any) {
                    console.error(`[QB] ⚠️ Could not save qb_list_id to customer: ${metaErr.message}`)
                    // Non-fatal — QB customer was created, just metadata save failed
                }
            }
        } else {
            console.log(`${prefix} Customer already in QB: ${qbCustomerId}`)
        }

        // 3. Build QB customer display name (must match exactly what's stored in QB)
        const qbCustomerName: string = (customer.metadata?.qb_name as string | undefined) || buildQbCustomerName(customer)

        // 4. Build Sales Order items
        // Medusa prices are in cents → convert to dollars for QB
        const soItems: QbOrderItem[] = (order.items || [])
            .filter(item => item.variant?.metadata?.quickbooks_id)
            .map(item => ({
                productId: item.variant!.metadata!.quickbooks_id as string,
                quantity: item.quantity,
                price: (item.unit_price || 0) / 100,  // cents → dollars
                desc: item.product_title,
            }))

        if (soItems.length === 0) {
            console.warn(`${prefix} ⚠️ Order #${order.display_id} has no items with quickbooks_id — skipping SO creation`)
            return { enabled: true, dryRun: DRY_RUN, customerId: qbCustomerId, skipReason: "No QB-linked items in order" }
        }

        // 5. Create Sales Order in QB
        const orderDate = order.created_at
            ? new Date(order.created_at).toISOString().split("T")[0]
            : new Date().toISOString().split("T")[0]

        const soResult = await createSalesOrderInQb({
            customerName: qbCustomerName,
            date: orderDate as string,  // always a string — has fallback to new Date()
            items: soItems,
            memo: `Medusa Web Order #${order.display_id || order.id}`,
        })

        if (!soResult.success) {
            console.error(`[QB] ❌ Failed to create Sales Order: ${soResult.error}`)
            return { enabled: true, dryRun: DRY_RUN, customerId: qbCustomerId, error: `SO creation failed: ${soResult.error}` }
        }

        console.log(`${prefix} ✅ Sales Order created in QB. TxnID: ${soResult.data?.txnId}`)

        return {
            enabled: true,
            dryRun: DRY_RUN,
            customerId: qbCustomerId,
            soTxnId: soResult.data?.txnId,
        }

    } catch (err: any) {
        console.error(`[QB] ❌ Unexpected error in processOrderInQb: ${err.message}`)
        return { enabled: true, error: err.message }
    }
}

// ─── Payment capture flow ─────────────────────────────────────────────────────

/**
 * Called when a payment is captured in Medusa.
 * Records the payment in QB as an unapplied credit (Step 2 of the QB flow).
 *
 * DISABLED BY DEFAULT: Same QB_ORDER_FLOW_ENABLED flag.
 */
export async function processPaymentCaptureInQb(capture: {
    orderId: string
    orderDisplayId?: number
    amount: number        // in cents (Medusa v2)
    paymentMethod: string // e.g., "Visa", "MasterCard", "Cash"
    qbCustomerName: string
    qbSoTxnId?: string
}): Promise<{ enabled: boolean; txnId?: string; error?: string; skipped?: boolean }> {
    if (!ORDER_FLOW_ENABLED) {
        return { enabled: false, skipped: true }
    }

    const { receivePaymentInQb } = await import("./qb-bridge-client.js")
    const prefix = DRY_RUN ? "[QB DRY RUN]" : "[QB]"
    const amountDollars = (capture.amount / 100).toFixed(2)

    console.log(`${prefix} Recording payment of $${amountDollars} for order #${capture.orderDisplayId || capture.orderId}...`)

    const result = await receivePaymentInQb({
        customerName: capture.qbCustomerName,
        amount: amountDollars,
        paymentMethod: capture.paymentMethod,
        memo: `Web Order #${capture.orderDisplayId || capture.orderId}`,
        autoApply: false,  // Keep as open credit; will be applied when Invoice is created
    })

    if (!result.success) {
        console.error(`[QB] ❌ Failed to record payment: ${result.error}`)
        return { enabled: true, error: result.error }
    }

    console.log(`${prefix} ✅ Payment recorded in QB. TxnID: ${result.data?.txnId}`)
    return { enabled: true, txnId: result.data?.txnId }
}
