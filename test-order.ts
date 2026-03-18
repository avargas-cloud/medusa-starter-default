export default async function({ container }) {
    const query = container.resolve("query")
    const { data } = await query.graph({
        entity: "order", 
        fields: ["id", "display_id", "total", "subtotal", "shipping_total", "tax_total", "shipping_methods.name", "shipping_methods.amount", "shipping_methods.subtotal", "shipping_methods.total", "shipping_methods.tax_total", "fulfillments.id"],
        filters: { display_id: 1119 }
    })
    console.log(JSON.stringify(data, null, 2))
}
