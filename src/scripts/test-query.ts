import { ContainerRegistrationKeys } from "@medusajs/utils"
export default async function myScript({ container }: { container: any }) {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const { data: [order] } = await query.graph({
        entity: "order",
        fields: [
            "id", "display_id", "status", "metadata", "tax_total",
            "customer_id",
            "items.*",
            "items.variant.*",
            "items.variant.metadata.*",
            "items.variant.product.metadata.*"
        ],
        filters: { id: "order_01KK1V61RHWZ5E9KMHY8ZC5B3K" }
    })
    console.log("---- QUERY RAW RESULTS ----")
    if (order?.items) {
        console.dir(order.items[0], { depth: null })
    } else {
        console.log("No items found")
    }
}
