import { MedusaContainer } from "@medusajs/framework/types"
import { Client } from "pg"

export default async function inspectOrder({ container }: { container: MedusaContainer }) {
  const query = container.resolve("query") as any
  const inventoryModule = container.resolve("inventory", { allowUnregistered: true }) as any
  const args = process.argv.slice(2)
  const orderId = args.find(a => a.startsWith("order_") || a.startsWith("dord_") || /^\d+$/.test(a))

  if (!orderId) {
    console.error("❌ Please provide an Order ID (order_... or 1533).")
    console.error("Example: npx medusa exec ./src/scripts/diagnostics/inspect-order.ts 1533")
    process.exit(1)
  }

  const isNumeric = /^\d+$/.test(orderId)
  const filters = isNumeric ? { display_id: parseInt(orderId) } : { id: orderId }

  console.log(`\n🔍 Inspecting Order: ${orderId} ...\n`)

  try {
    const { data: [order] } = await query.graph({
      entity: "order",
      fields: [
        "id", "display_id", "status", "payment_status", "fulfillment_status", "version",
        "is_draft_order",
        "total", "subtotal", "tax_total", "discount_total", "metadata",
        "created_at", "updated_at",
        "customer.*",
        "shipping_address.*",
        "items.*",
        "items.tax_lines.*",
        "items.adjustments.*",
        "fulfillments.*",
        "payment_collections.*",
        "shipping_methods.*"
      ],
      filters
    })

    if (!order) {
      console.log(`❌ Order ${orderId} not found in the database.`)
      // Try to dump raw query output if it's a draft order that behaves differently
      return
    }

    console.log("=========================================")
    console.log("📋 GENERAL INFO")
    console.log(`ID: ${order.id}`)
    console.log(`Display ID: ${order.display_id}`)
    console.log(`Is Draft Order: ${order.is_draft_order ? '✅ YES' : '❌ NO'}`)
    console.log(`Status: ${order.status}`)
    console.log(`Fulfillment Status: ${order.fulfillment_status}`)
    console.log(`Payment Status: ${order.payment_status}`)
    console.log(`Metadata:`, order.metadata || {})
    console.log()

    console.log("👤 CUSTOMER & SHIPPING")
    console.log(`Customer: ${order.customer?.first_name || ''} ${order.customer?.last_name || ''} (${order.customer?.email})`)
    const addr = order.shipping_address
    if (addr) {
      console.log(`Address: ${addr.address_1}, ${addr.city}, ${addr.province} ${addr.postal_code}`)
    } else {
      console.log(`Address: Not provided`)
    }
    console.log()

    console.log("🚚 SHIPPING METHOD")
    if (order.shipping_methods?.length) {
      order.shipping_methods.forEach((sm: any) => {
        console.log(`- ${sm.name || 'Unknown'} (Amount: ${Number(sm.amount || 0).toFixed(2)})`)
      })
    } else {
      console.log(`No shipping method attached.`)
    }
    console.log()

    console.log("💰 TOTALS (Order Object)")
    console.log(`Subtotal: ${Number(order.subtotal || 0).toFixed(2)}`)
    console.log(`Tax Total: ${Number(order.tax_total || 0).toFixed(2)}`)
    console.log(`Discount Total: ${Number(order.discount_total || 0).toFixed(2)}`)
    console.log(`★ GRAND TOTAL: ${Number(order.total || 0).toFixed(2)}`)
    console.log()

    console.log("💳 PAYMENT COLLECTIONS")
    if (order.payment_collections?.length) {
      order.payment_collections.forEach((pc: any) => {
        console.log(`- [${pc.status.toUpperCase()}] Amount: ${Number(pc.amount || 0).toFixed(2)} (ID: ${pc.id})`)
      })
    } else {
      console.log(`No payment collections found.`)
    }
    console.log()

    console.log("📦 ITEMS")
    
    let reservations: any[] = []
    
    // FILTER ITEMS BY LATEST ORDER VERSION!
    const activeItems = order.items?.filter((i: any) => i.version === order.version || i.detail?.version === order.version) || []

    if (inventoryModule && activeItems.length) {
      try {
        const lineItemIds = activeItems.map((i: any) => i.detail?.item_id || i.id)
        reservations = await inventoryModule.listReservationItems({ line_item_id: lineItemIds })
      } catch (e) {
        // Ignored if syntax changed or module unavailable
      }
    }

    activeItems.forEach((item: any) => {
      const taxRate = item.tax_lines?.[0]?.rate || 0
      const lineItemIdToMatch = item.detail?.item_id || item.id
      const itemReservations = reservations.filter(r => r.line_item_id === lineItemIdToMatch)
      const allocatedQty = itemReservations.reduce((acc, r) => acc + (r.quantity || 0), 0)

      console.log(`- [${item.variant_sku || 'N/A'}] ${item.title}`)
      console.log(`    Requested Qty: ${item.quantity}`)
      console.log(`    Fulfilled Qty: ${item.detail?.fulfilled_quantity ?? (item.fulfilled_quantity || 0)}`)
      console.log(`    Allocated/Reserved Qty: ${allocatedQty} (Reservations: ${itemReservations.length})`)
      if (allocatedQty < item.quantity && !order.is_draft_order) {
        console.log(`    ⚠️ BACKORDERED/MISSING ALLOCATION: ${item.quantity - allocatedQty}`)
      }
      console.log(`    Unit Price: ${Number(item.unit_price || 0).toFixed(2)}`)
      console.log(`    Tax applied: ${taxRate}%`)
      if (item.adjustments?.length) {
        item.adjustments.forEach((adj: any) => {
          console.log(`    🎁 Discount applied [${adj.code}]: -${Number(adj.amount || 0).toFixed(2)}`)
        })
      }
      console.log(`    (Note: For deep inventory/stock/allocated tracing, you can expand the query)`)
    })
    console.log("=========================================")

    // ─── QuickBooks Status ──────────────────────────────────────────────────
    console.log("\n🔗 QUICKBOOKS STATUS")
    const meta = order.metadata || {}
    const qbSyncStatus = meta.qb_sync_status ?? null

    // Support both old flat format and new nested format
    const estimateTxnId  = meta.qb_estimate?.txn_id  ?? meta.qb_estimate_txn_id  ?? null
    const estimateRef    = meta.qb_estimate?.ref_number ?? meta.qb_estimate_ref   ?? null
    const estimateEditSeq = meta.qb_estimate?.edit_sequence ?? null
    const soTxnId        = meta.qb_sales_order?.txn_id  ?? meta.qb_sales_order_txn_id ?? null
    const soRef          = meta.qb_sales_order?.ref_number ?? meta.qb_sales_order_ref  ?? null
    const soEditSeq      = meta.qb_sales_order?.edit_sequence ?? null
    const invoices: any[] = Array.isArray(meta.qb_invoices) ? meta.qb_invoices : []
    const payments: any[] = Array.isArray(meta.qb_payments) ? meta.qb_payments : []
    const listId         = meta.qb_list_id ?? null
    const syncedAt       = meta.qb_synced_at ?? null

    console.log(`  Sync Status : ${qbSyncStatus ?? "— not set"}`)
    console.log(`  QB List ID  : ${listId ?? "— not set (customer not in QB)"}`)
    console.log(`  Last Synced : ${syncedAt ?? "—"}`)
    console.log()
    console.log(`  Estimate    : ${estimateTxnId ? `TxnID=${estimateTxnId}  Ref=${estimateRef}  EditSeq=${estimateEditSeq ?? "—"}` : "— not synced"}`)
    console.log(`  Sales Order : ${soTxnId       ? `TxnID=${soTxnId}        Ref=${soRef}        EditSeq=${soEditSeq ?? "—"}` : "— not synced"}`)
    if (invoices.length) {
      invoices.forEach((inv: any, i: number) => {
        console.log(`  Invoice[${i}]  : TxnID=${inv.txn_id}  Ref=${inv.ref_number}  EditSeq=${inv.edit_sequence ?? "—"}  FulfID=${inv.fulfillment_id ?? "—"}`)
      })
    } else {
      console.log(`  Invoices    : — none`)
    }
    if (payments.length) {
      payments.forEach((pay: any, i: number) => {
        console.log(`  Payment[${i}]  : TxnID=${pay.txn_id}  Amount=$${(pay.amount / 100).toFixed(2)}  Method=${pay.method}`)
      })
    } else {
      console.log(`  Payments    : — none`)
    }

    // ─── Pipeline rows for this order ──────────────────────────────────────
    console.log("\n📊 QB PIPELINE (qb_order_pipeline)")
    const dbClient = new Client({ connectionString: process.env.DATABASE_URL })
    try {
      await dbClient.connect()
      const { rows: pipelineRows } = await dbClient.query(
        `SELECT step, status, bridge_op_id, qb_txn_id, qb_ref_number, error, retry_count,
                created_at, submitted_at, confirmed_at, failed_at
         FROM qb_order_pipeline
         WHERE order_id = $1
         ORDER BY created_at ASC`,
        [order.id]
      )
      if (pipelineRows.length === 0) {
        console.log("  (no pipeline rows)")
      } else {
        pipelineRows.forEach((row: any) => {
          const ts = row.confirmed_at ?? row.failed_at ?? row.submitted_at ?? row.created_at
          const tsStr = ts ? new Date(ts).toISOString() : "—"
          const icon = row.status === "confirmed" ? "✅"
            : row.status === "failed"    ? "❌"
            : row.status === "submitted" ? "⏳"
            : row.status === "pending"   ? "🕐"
            : "⏭️"
          console.log(`  ${icon} [${row.step.padEnd(12)}] status=${row.status.padEnd(10)} retries=${row.retry_count}  TxnID=${row.qb_txn_id ?? "—"}  OpID=${row.bridge_op_id?.slice(0, 8) ?? "—"}  ts=${tsStr}`)
          if (row.error) console.log(`       error: ${row.error}`)
        })
      }
    } catch (pgErr: any) {
      console.log(`  ⚠️ Could not query pipeline: ${pgErr.message}`)
    } finally {
      await dbClient.end()
    }

    console.log("\n--- FULL METADATA DUMP ---")
    console.log(JSON.stringify(order.metadata, null, 2))

  } catch (error) {
    console.error("❌ Error fetching order:", error)
  }
}
