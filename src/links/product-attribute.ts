
import ProductModule from "@medusajs/medusa/product"
import AttributeModule from "../modules/product-attributes"
import { defineLink } from "@medusajs/framework/utils"

export default defineLink(
    ProductModule.linkable.product,
    AttributeModule.linkable.attributeValue
)
