import { model } from "@medusajs/framework/utils"
import { AttributeSet } from "./attribute-set"
import { AttributeValue } from "./attribute-value"

export const AttributeKey = model.define("attribute_key", {
    id: model.id().primaryKey(),
    handle: model.text().unique(), // e.g., "material", "color"
    label: model.text(),           // e.g., "Material", "Color"
    // Stores allowed options as a simple array of strings for validation/dropdowns
    // e.g., ["Red", "Blue", "Green"]
    options: model.array().nullable(),

    // NEW: Display Configuration for UX
    display_name: model.text().nullable(),    // Override label for frontend display
    description: model.text().nullable(),     // Helper text for filter UI
    filter_type: model.text().nullable(),     // "checkbox", "range", "toggle", "dropdown", "color-swatch"
    filter_order: model.number().nullable(),  // Sort order in filter panel
    icon: model.text().nullable(),            // Icon identifier: "thermometer", "bolt", "ruler"
    unit: model.text().nullable(),            // Display unit: "K", "V", "W", "ft", "mm"

    metadata: model.json().nullable(),

    // Relation to AttributeSet (optional grouping)
    attribute_set: model.belongsTo(() => AttributeSet, {
        mappedBy: "attributes",
    }).nullable(),

    values: model.hasMany(() => AttributeValue, {
        mappedBy: "attribute_key"
    })
})
