import { model } from "@medusajs/framework/utils"
import { AttributeKey } from "./attribute-key"

export const AttributeSet = model.define("attribute_set", {
    id: model.id().primaryKey(),
    handle: model.text().unique(), // Auto-generated from title (kebab-case)
    title: model.text(),            // e.g., "Electrical Specifications"
    metadata: model.json().nullable(),

    // Relation to attributes (one-to-many)
    attributes: model.hasMany(() => AttributeKey, {
        mappedBy: "attribute_set",
    }),
})
