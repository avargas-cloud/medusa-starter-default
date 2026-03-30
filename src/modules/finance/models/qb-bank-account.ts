import { model } from '@medusajs/utils'

/**
 * QbBankAccount - maps QuickBooks Bank/CreditCard accounts for automated Refund orchestration.
 */
const QbBankAccount = model.define('qb_bank_account', {
    id: model.id({ prefix: 'qbbank' }).primaryKey(),
    name: model.text(),
    list_id: model.text().unique(),
    type: model.enum(['Bank', 'CreditCard', 'OtherCurrentAsset']).default('Bank'),
    is_active: model.boolean().default(true),
    is_default: model.boolean().default(false),
})

export { QbBankAccount }
