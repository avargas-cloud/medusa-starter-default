import { ExecArgs } from "@medusajs/framework/types"

export default async function debugEapThumbnail({ container }: ExecArgs) {
  const query = container.resolve("query")
  
  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: [
      "id",
      "sku",
      "thumbnail",
      "images.id",
      "images.url",
      "product.id",
      "product.thumbnail",
    ],
    filters: {
      sku: ["EAP-AS1-8B", "EAP-AS1-8S", "EAP-AS1-8W"],
    },
  })
  
  for (const v of variants as any[]) {
    console.log(`SKU: ${v.sku}`)
    console.log(`  variant.thumbnail: ${v.thumbnail}`)
    console.log(`  variant.images: ${JSON.stringify(v.images)}`)
    console.log(`  product.id: ${v.product?.id}`)
    console.log(`  product.thumbnail: ${v.product?.thumbnail}`)
    console.log("")
  }
}
