import { model } from "@medusajs/framework/utils"


/**
 * Extended ProductCategory entity with additional thumbnail column.
 * This replaces the previous metadata.thumbnail approach with a native column.
 */
const ProductCategory = model.define("product_category", {
    thumbnail: model.text().nullable(),
})

export default ProductCategory
