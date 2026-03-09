export default async function myScript({ container }) {
    const query = container.resolve("query")

    const { data: handleData } = await query.graph({
        entity: "product_category",
        fields: ["id", "handle", "is_active", "is_internal"],
        filters: { handle: "led-strips-white" }
    })
    console.log("Handle filters result:", handleData.length)

    const { data: nullParent } = await query.graph({
        entity: "product_category",
        fields: ["id", "handle", "is_active", "is_internal"],
        filters: { parent_category_id: "null" }
    })
    console.log("String null parent:", nullParent.length)

    const { data: realNull } = await query.graph({
        entity: "product_category",
        fields: ["id", "handle", "is_active", "is_internal"],
        filters: { parent_category_id: null }
    })
    console.log("Actual null parent:", realNull.length)
}
