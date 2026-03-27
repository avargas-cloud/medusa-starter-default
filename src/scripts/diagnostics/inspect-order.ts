import { MedusaContainer } from "@medusajs/framework/types"

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

    console.log("\n--- FULL METADATA DUMP ---")
    console.log(JSON.stringify(order.metadata, null, 2))
    
    // console.log("\n--- FULL RAW OBJECT DUMP ---")
    // console.log(JSON.stringify(order, null, 2))

  } catch (error) {
    console.error("❌ Error fetching order:", error)
  }
}
