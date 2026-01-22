import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

export async function GET(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const productId = req.params.id
    const query = req.scope.resolve("query")

    try {
        const { data } = await query.graph({
            entity: "product",
            fields: ["id", "attribute_value.*", "attribute_value.attribute_key.*"],
            filters: { id: productId },
        })

        const product = data?.[0]
        const attributeValues = Array.isArray(product?.attribute_value)
            ? product.attribute_value
            : (product?.attribute_value ? [product.attribute_value] : [])

        const attributes = attributeValues.map((av: any) => ({
            id: av.id,
            value: av.value,
            label: av.attribute_key?.label,
            handle: av.attribute_key?.handle,
        }))

        res.json({ attributes })
    } catch (error) {
        res.json({ attributes: [] })
    }
}
