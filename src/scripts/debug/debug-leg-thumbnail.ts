import { ExecArgs } from "@medusajs/framework/types"

export default async function debugLegThumbnail({ container }: ExecArgs) {
  const query = container.resolve("query")
  
  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: [
      "id", "sku", "thumbnail",
      "images.id", "images.url",
      "product.id", "product.thumbnail",
      "product.images.id",
    ],
    filters: { sku: ["LEG-AWP1G2BR6", "LEG-AWP1G2NK4", "LEG-AWP1G2GR6"] },
  })
  
  for (const v of variants as any[]) {
    const productImageIds = new Set<string>(
      ((v.product?.images ?? []) as Array<{ id?: string }>)
        .map((img: any) => img.id).filter(Boolean)
    )
    const variantSpecific = ((v.images ?? []) as Array<{ id?: string; url?: string }>)
      .filter((img) => img.id && !productImageIds.has(img.id))
    
    console.log(`SKU: ${v.sku}`)
    console.log(`  variant.thumbnail: ${v.thumbnail}`)
    console.log(`  variant.images: ${JSON.stringify(v.images?.map((i: any) => i.id))}`)
    console.log(`  product.thumbnail: ${v.product?.thumbnail}`)
    console.log(`  product.images count: ${v.product?.images?.length}`)
    console.log(`  product.images IDs (first 3): ${JSON.stringify(v.product?.images?.slice(0,3)?.map((i: any) => i.id))}`)
    console.log(`  variantSpecificImages: ${JSON.stringify(variantSpecific)}`)
    console.log("")
  }
}
