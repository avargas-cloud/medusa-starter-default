import { Column } from "typeorm"
import { ProductCategory as MedusaProductCategory } from "@medusajs/framework/types"

/**
 * Extended ProductCategory entity with additional thumbnail column.
 * This replaces the previous metadata.thumbnail approach with a native column.
 */
export default class ProductCategory extends MedusaProductCategory {
    @Column({ type: "text", nullable: true })
    thumbnail?: string | null
}
