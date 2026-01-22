import { model } from "@medusajs/framework/utils"
import { AttributeKey } from "./attribute-key"

export const AttributeValue = model.define("attribute_value", {
    id: model.id().primaryKey(),
    value: model.text(), // The specific value, e.g., "Red"
    // Relationship to the Definition
    attribute_key: model.belongsTo(() => AttributeKey, {
        mappedBy: "values",
    }),
    metadata: model.json().nullable(),
})
