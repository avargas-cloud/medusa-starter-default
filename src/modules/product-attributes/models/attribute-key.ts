import { model } from "@medusajs/framework/utils"
import { AttributeSet } from "./attribute-set"

export const AttributeKey = model.define("attribute_key", {
    id: model.id().primaryKey(),
    handle: model.text().unique(), // e.g., "material", "color"
    label: model.text(),           // e.g., "Material", "Color"
    // Stores allowed options as a simple array of strings for validation/dropdowns
    // e.g., ["Red", "Blue", "Green"]
    options: model.array().nullable(),
    metadata: model.json().nullable(),

    // Relation to AttributeSet (optional grouping)
    attribute_set: model.belongsTo(() => AttributeSet, {
        mappedBy: "attributes",
    }).nullable(),
})
