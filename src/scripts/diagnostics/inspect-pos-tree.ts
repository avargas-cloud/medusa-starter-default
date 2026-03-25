import { MedusaContainer } from "@medusajs/medusa"

export default async function inspectPosTree({ container }: { container: MedusaContainer }) {
  const query = container.resolve("query") as any
  const inventoryModule = container.resolve("inventory", { allowUnregistered: true }) as any
  const args = process.argv.slice(2)
  const queryId = args.find(a => !a.startsWith("-") && a !== "exec" && !a.endsWith(".ts") && !a.endsWith(".js"))

  if (!queryId) {
    console.error("❌ Please provide an ID (order_*, dord_*, inv_*, pay_*, papp_*, cm_*, or numeric display_id).")
    console.error("Example: npx tsx src/scripts/diagnostics/inspect-pos-tree.ts 1533")
    process.exit(1)
  }

  let orderId: string | undefined
  const isNumeric = /^\d+$/.test(queryId)

  console.log(`\n🔍 Resolving ID: ${queryId} ...`)

  try {
    if (isNumeric || queryId.startsWith("order_") || queryId.startsWith("dord_")) {
      // It's an order ID or display_id
      const filters = isNumeric ? { display_id: parseInt(queryId) } : { id: queryId }
      const { data: [order] } = await query.graph({ entity: "order", fields: ["id"], filters })
      if (!order) throw new Error(`Order ${queryId} not found`)
      orderId = order.id
    } else if (queryId.startsWith("inv_")) {
      const { data: [inv] } = await query.graph({ entity: "pos_invoice", fields: ["order_id"], filters: { id: queryId } })
      if (!inv) throw new Error(`Invoice ${queryId} not found`)
      orderId = inv.order_id
    } else if (queryId.startsWith("papp_")) {
      const { data: [app] } = await query.graph({ entity: "payment_application", fields: ["order_id"], filters: { id: queryId } })
      if (!app) throw new Error(`Application ${queryId} not found`)
      orderId = app.order_id
    } else if (queryId.startsWith("pay_")) {
      const { data: [app] } = await query.graph({ entity: "payment_application", fields: ["order_id"], filters: { payment: { id: queryId } } })
      if (!app) throw new Error(`No payment application found for Payment ${queryId}`)
      orderId = app.order_id
    } else if (queryId.startsWith("cm_")) {
      const { data: [cm] } = await query.graph({ entity: "pos_credit_memo", fields: ["order_id"], filters: { id: queryId } })
      if (!cm) throw new Error(`Credit Memo ${queryId} not found`)
      orderId = cm.order_id
    } else {
      throw new Error(`Unknown ID format: ${queryId}`)
    }

    console.log(`✅ Resolved to Order ID: ${orderId}\n`)

    // Fetch the Order Tree
    const { data: [order] } = await query.graph({
      entity: "order",
      fields: [
        "id", "display_id", "status", "payment_status", "fulfillment_status", "version",
        "total", "subtotal", "tax_total", "discount_total", "metadata",
        "created_at", "updated_at",
        "customer.*",
        "shipping_address.*",
        "items.*",
        "items.tax_lines.*",
        "items.adjustments.*",
        "fulfillments.*",
        "fulfillments.labels.*",
        "payment_collections.*",
        "shipping_methods.*"
      ],
      filters: { id: orderId }
    })

    if (!order) {
      console.log(`❌ Order ${orderId} missing data!`)
      return
    }

    // Fetch Custom Modules
    const { data: invoices } = await query.graph({
      entity: "pos_invoice",
      fields: ["*", "items.*", "tracking_links.*"],
      filters: { order_id: orderId }
    }).catch(() => ({ data: [] }))

    const { data: applications } = await query.graph({
      entity: "payment_application",
      fields: ["*", "payment.*"],
      filters: { order_id: orderId }
    }).catch(() => ({ data: [] }))

    const { data: creditMemos } = await query.graph({
      entity: "pos_credit_memo",
      fields: ["*", "items.*"],
      filters: { order_id: orderId }
    }).catch(() => ({ data: [] }))

    // Inventory matching
    let reservations: any[] = []
    const activeItems = order.items?.filter((i: any) => i.version === order.version || i.detail?.version === order.version) || []
    if (inventoryModule && activeItems.length) {
      try {
        const lineItemIds = activeItems.map((i: any) => i.detail?.item_id || i.id)
        reservations = await inventoryModule.listReservationItems({ line_item_id: lineItemIds })
      } catch (e) {
        // Ignored
      }
    }

    console.log("=========================================")
    console.log(`📦 ORDER (${order.id}) | # ${order.display_id}`)
    console.log(`   Status: ${String(order.status || 'UNKNOWN').toUpperCase()} | Fulfillment: ${String(order.fulfillment_status || 'UNKNOWN').toUpperCase()} | Payment: ${String(order.payment_status || 'UNKNOWN').toUpperCase()}`)
    console.log(`   Subtotal: $${Number(order.subtotal || 0).toFixed(2)}`)
    
    if (order.discount_total > 0) {
      console.log(`   Discounts: -$${Number(order.discount_total || 0).toFixed(2)}`)
    }

    if (order.shipping_methods?.length) {
      order.shipping_methods.forEach((sm: any) => {
        console.log(`   Shipping (${sm.name || 'Generic'}): +$${Number(sm.amount || 0).toFixed(2)}`)
      })
    } else {
      console.log(`   Shipping: None`)
    }

    console.log(`   Taxes: $${Number(order.tax_total || 0).toFixed(2)}`)
    console.log(`   GRAND TOTAL: $${Number(order.total || 0).toFixed(2)}`)
    console.log("")

    console.log("   📝 ITEMS:")
    activeItems.forEach((item: any) => {
      const taxRate = item.tax_lines?.[0]?.rate || 0
      const lineItemIdToMatch = item.detail?.item_id || item.id
      const itemReservations = reservations.filter(r => r.line_item_id === lineItemIdToMatch)
      const allocatedQty = itemReservations.reduce((acc, r) => acc + (r.quantity || 0), 0)
      const fulQty = item.detail?.fulfilled_quantity ?? (item.fulfilled_quantity || 0)

      const backorderQty = item.quantity - fulQty
      console.log(`     - [${item.variant_sku || 'N/A'}] ${item.title} (x${item.quantity})`)
      console.log(`       Price: $${Number(item.unit_price || 0).toFixed(2)} (Tax: ${taxRate}%)`)
      console.log(`       Status: Qty: ${item.quantity} | Fulfilled: ${fulQty} | Allocated: ${allocatedQty} | Backorder: ${backorderQty}`)
      if (order.status !== 'draft' && backorderQty !== allocatedQty) {
        console.log(`       ⚠️ ALLOCATION MISMATCH: Medusa reserved ${allocatedQty} but ${backorderQty} are pending!`)
      }
      
      if (item.adjustments?.length) {
        item.adjustments.forEach((adj: any) => {
          console.log(`       🎁 Discount [${adj.code}]: -$${Number(adj.amount || 0).toFixed(2)}`)
        })
      }
    })

    console.log("\n└── 🚚 FULFILLMENTS")
    if (order.fulfillments?.length) {
      order.fulfillments.forEach((f: any) => {
        const trackingLabels = f.labels?.map((l: any) => l.tracking_number).filter(Boolean) || []
        const allTracking = [...new Set([...trackingLabels])].join(", ")
        const trackingStr = allTracking ? ` | Tracking: ${allTracking}` : ''
        console.log(`    ├── Fulfillment (${f.id}) - Provider: ${f.provider_id || 'Unknown'}${trackingStr}`)
      })
    } else {
      console.log("    ├── No fulfillments yet")
    }

    console.log("\n└── 🧾 INVOICES")
    let invoiceSum = 0
    if (invoices?.length) {
      invoices.forEach((inv: any) => {
        const invTotal = Number(inv.total || 0) / 100
        const invPaid = Number(inv.amount_paid || 0) / 100
        const invDue = Number(inv.balance_due || 0) / 100
        const invShipping = Number(inv.shipping || 0) / 100
        invoiceSum += invTotal
        console.log(`    ├── Invoice (${inv.id}) | # ${inv.invoice_number}`)
        console.log(`    │   Status: ${inv.status.toUpperCase()} | Total: $${invTotal.toFixed(2)} | Shipping: $${invShipping.toFixed(2)} | Paid: $${invPaid.toFixed(2)} | Due: $${invDue.toFixed(2)}`)
        if (inv.items?.length) {
          inv.items.forEach((item: any) => {
            console.log(`    │     - [${item.sku || 'N/A'}] ${item.description || 'Item'} (x${item.quantity}) @ $${(Number(item.unit_price || 0) / 100).toFixed(2)}`)
          })
        }
      })
    } else {
      console.log("    ├── No POS invoices found")
    }

    console.log("\n└── 💳 FINANCE & PAYMENTS")
    let appliedSum = 0
    if (applications?.length) {
      applications.forEach((app: any) => {
        const amtApp = Number(app.amount_applied || 0) / 100
        let isVoided = app.voided_at != null
        if (!isVoided) appliedSum += amtApp

        console.log(`    ├── Application (${app.id}) ${isVoided ? '[VOID]' : ''} -> Applied: $${amtApp.toFixed(2)}`)
        if (app.payment) {
          console.log(`    │   From Payment (${app.payment.id}) | Method: ${app.payment.method} | Status: ${app.payment.status}`)
        }
      })
    } else {
      console.log("    ├── No payment applications found")
    }

    console.log("\n└── 🔄 CREDIT MEMOS")
    let cmSum = 0
    if (creditMemos?.length) {
      creditMemos.forEach((cm: any) => {
        const cmTotal = Number(cm.total || 0) / 100
        cmSum += cmTotal
        console.log(`    ├── Credit Memo (${cm.id}) | # ${cm.credit_memo_number}`)
        console.log(`    │   Status: ${cm.status.toUpperCase()} | Total Refund: -$${cmTotal.toFixed(2)}`)
        if (cm.items?.length) {
          cm.items.forEach((item: any) => {
            console.log(`    │     - [${item.sku || 'N/A'}] ${item.description || 'Item'} (x${item.quantity}) @ $${(Number(item.unit_price || 0) / 100).toFixed(2)}`)
          })
        }
      })
    } else {
      console.log("    ├── No credit memos found")
    }

    console.log("\n=========================================")
    console.log("📊 VALIDATION SUMMARY")
    console.log(`Order Total:      $${Number(order.total || 0).toFixed(2)}`)
    console.log(`Invoiced Total:   $${invoiceSum.toFixed(2)}`)
    console.log(`Payments Applied: $${appliedSum.toFixed(2)}`)
    console.log(`Credits Issued:   -$${cmSum.toFixed(2)}`)
    
    // Quick Math Checks
    const diffInv = Math.abs(Number(order.total || 0) - invoiceSum)
    if (diffInv < 0.05 && invoices?.length > 0) {
      console.log("✅ Order fully invoiced matching total.")
    } else if (invoices?.length === 0) {
      console.log("⏳ Order not yet invoiced.")
    } else {
      console.log("⚠️ Invoice total mismatch vs Order total.")
    }

    const diffPay = Math.abs(Number(order.total || 0) - appliedSum)
    if (diffPay < 0.05) {
      console.log("✅ Payments fully applied matching total.")
    } else {
      console.log(`⏳ Payment balance mismatch: $${(Number(order.total || 0) - appliedSum).toFixed(2)} remaining.`)
    }

    console.log("=========================================\n")

  } catch (error: any) {
    console.error(`\n❌ Error inspecting tree: ${error.message}`)
  }
}
