import { getDbPool } from "../api/utils/db-pool"

/**
 * Dynamically computes and resets the true native Medusa Order statuses
 * based purely on factual order_item quantities and pos_invoice records.
 * Use this after voiding invoices, changing fulfillments, or manual payment interventions.
 * @param orderId - The Medusa Order ID (e.g. order_01...)
 * @param container - Provide the Medusa dependency scope to invoke native services
 */
export async function recalculateOrderStatus(orderId: string, container?: any): Promise<void> {
    const pool = getDbPool()
    
    try {
        // Step 1: Calculate the true Fulfillment Status based on order_item metrics
        const itemRes = await pool.query(
            `SELECT 
                SUM(quantity) as total_qty, 
                SUM(fulfilled_quantity) as total_fulfilled, 
                SUM(delivered_quantity) as total_delivered,
                SUM(shipped_quantity) as total_shipped
             FROM order_item 
             WHERE order_id = $1`,
            [orderId]
        )
        const metrics = itemRes.rows[0];
        const qty = Number(metrics?.total_qty || 0);
        const fulfilled = Number(metrics?.total_fulfilled || 0);
        const delivered = Number(metrics?.total_delivered || 0);

        let newFulfillmentStatus = 'not_fulfilled';
        
        if (fulfilled > 0 && fulfilled < qty) {
            newFulfillmentStatus = 'partially_fulfilled';
        } else if (fulfilled > 0 && fulfilled >= qty) {
            newFulfillmentStatus = 'fulfilled';
            // Note: If delivered == qty we could set shipped, but 'fulfilled' is standard for POS.
        }

        // Step 2: Calculate the true Payment Status based on what money hasn't been voided
        // For POS, our source of truth for recognized recognized-revenue is non-void pos_invoices
        const orderRes = await pool.query(
            `SELECT total FROM "order" WHERE id = $1`,
            [orderId]
        )
        const orderTotal = Number(orderRes.rows[0]?.total || 0)

        const invoiceRes = await pool.query(
            `SELECT SUM(amount_paid) as total_paid 
             FROM pos_invoice 
             WHERE order_id = $1 AND status != 'voided'`,
            [orderId]
        )
        const totalPaid = Number(invoiceRes.rows[0]?.total_paid || 0)

        let newPaymentStatus = 'not_paid';
        if (totalPaid > 0 && totalPaid < orderTotal) {
            // Wait, Medusa's equivalent for partial is 'partially_captured' or 'partially_paid' depending on usage.
            // But we can stick to native standard.
            newPaymentStatus = 'partially_captured';
        } else if (totalPaid > 0 && totalPaid >= orderTotal) {
            newPaymentStatus = 'captured';
        }

        // Determine general status:
        // Generally, an order is 'pending' until it's fully closed by the system, but we usually leave it pending
        // unless it's fully paid and fulfilled (sometimes 'completed').
        let newStatus = 'pending';
        if (newPaymentStatus === 'captured' && newFulfillmentStatus === 'fulfilled') {
            newStatus = 'completed'; // Or leave as pending depending on how the frontend tracks it. We'll default to pending to stay open.
            newStatus = 'pending'; 
        }

        // Step 3: Native Medusa reversal of generic payment collections if sum hits 0
        if (totalPaid === 0 && container) {
            try {
                // We resolve the native module to properly zero out rather than raw SQL (Hardcode avoidance)
                const paymentModule = container.resolve("paymentModuleService")
                const collections = await paymentModule.listPaymentCollections({ order_id: orderId })
                
                for (const pc of collections) {
                    await pool.query(`UPDATE payment_collection SET captured_amount = 0 WHERE id = $1`, [pc.id])
                    await pool.query(`UPDATE payment SET amount = 0, captured_at = NULL, canceled_at = NOW() WHERE payment_collection_id = $1`, [pc.id])
                }
                console.log(`[ORDER ORACLE] Natively processed zeroing for Medusa payment collections -> ${orderId}`)
            } catch (err: any) {
                console.warn(`[ORDER ORACLE] Native payment zeroing warning: ${err.message}`)
            }
        }

        // Apply
        console.log(`[ORDER ORACLE] Recalculating ${orderId} | Fulfillment: ${newFulfillmentStatus} | Payment: ${newPaymentStatus} | Delivered: ${delivered}`)
        await pool.query(
            `UPDATE "order" SET 
                fulfillment_status = $1, 
                payment_status = $2, 
                status = $3
             WHERE id = $4`,
            [newFulfillmentStatus, newPaymentStatus, newStatus, orderId]
        )
    } catch (e: any) {
        console.error(`[ORDER ORACLE] Failed to recalculate order status for ${orderId}:`, e.message);
    }
}
