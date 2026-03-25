import { MedusaContainer } from "@medusajs/medusa"
import { buildQbItems } from "../../lib/quickbooks/order-flow-core"

export default async function testAmounts({ container }: { container: MedusaContainer }) {
  const query = container.resolve("query") as any

  const { data: [order] } = await query.graph({
    entity: "order",
    fields: [
      "id", "display_id", "status", "version",
      "total", "metadata",
      "items.*", "items.variant.*", "items.variant.metadata"
    ],
    filters: { display_id: 1240 }
  })

  // 1. Raw unit_price logging
  console.log("Raw unit_price type:", typeof order.items[0].unit_price)
  console.log("Raw unit_price value:", JSON.stringify(order.items[0].unit_price))

  const modItems = buildQbItems(order.items, order.metadata)
  
  console.log("\n--- Payload to QB Bridge ---")
  console.log(JSON.stringify(modItems, null, 2))
}
