import { model } from "@medusajs/utils"
import PosCreditMemo from './pos-credit-memo'

const PosCreditMemoItem = model.define('pos_credit_memo_item', {
    id:          model.id().primaryKey(),
    credit_memo: model.belongsTo(() => PosCreditMemo, { mappedBy: 'items' }),
    
    variant_id:  model.text().nullable(),
    sku:         model.text().nullable(),
    title:       model.text().nullable(),         // Base product title
    description: model.text(),                    // Variant title / Sales description
    thumbnail:   model.text().nullable(),
    
    quantity:     model.number(),
    damaged_qty:  model.number().default(0),      // Units returned but NOT restocked (defective)
    unit_price:   model.bigNumber(),              // In DOLLARS (matching posStore expectations, or cents) -> Usually we store cents in DB for Medusa v2. Let's strictly use BIG NUMBER cents in DB.
    line_total:   model.bigNumber(),              // quantity * unit_price (optional store)
})

export default PosCreditMemoItem
