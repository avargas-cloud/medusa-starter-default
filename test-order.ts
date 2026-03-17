export default async function myScript({ container }) {
    const query = container.resolve("query")
    const { data: [fetchedOrder] } = await query.graph({
        entity: "order",
        fields: ["id", "display_id", "subtotal", "discount_total", "tax_total", "total", "sales_channel_id", "metadata", "items.*", "items.item.unit_price"],
        filters: { display_id: 1119 }
    })
    console.log(JSON.stringify(fetchedOrder, null, 2))
}
