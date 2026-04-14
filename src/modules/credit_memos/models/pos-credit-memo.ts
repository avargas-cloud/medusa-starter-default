import { model } from "@medusajs/utils"
import PosCreditMemoItem from './pos-credit-memo-item'

const PosCreditMemo = model.define('pos_credit_memo', {
    id:                 model.id().primaryKey(),
    credit_memo_number: model.text(),            // CM-{seq} or similar
    order_id:           model.text().nullable(), // FK -> Parent Order
    invoice_id:         model.text().nullable(), // FK -> Parent PosInvoice
    customer_id:        model.text().nullable(), // FK -> Medusa Customer
    
    // open (saved/created in POS), completed (inventory returned + synced to QB), voided
    status:             model.enum(['created', 'completed', 'voided']).default('created'),
    
    subtotal:           model.bigNumber().default(0), // pre-tax total of items
    discount:           model.bigNumber().default(0), // global discount
    tax:                model.bigNumber().default(0),
    shipping:           model.number().default(0),    // shipping refund
    total:              model.bigNumber().default(0), // final refund/credit total
    
    sales_rep:            model.json().nullable(),   // { initials: "AVP", name: "Alejandro Vargas" }
    shipping_option_id:   model.text().nullable(),
    shipping_option_name: model.text().nullable(),
    qb_txn_id:            model.text().nullable(),   // QB TxnID after sync — needed for void
    qb_edit_sequence:     model.text().nullable(),   // QB EditSequence — needed for void/mod

    completed_at:       model.dateTime().nullable(),
    voided_at:          model.dateTime().nullable(),
    void_reason:        model.text().nullable(),
    notes:              model.text().nullable(),
    created_by:         model.text().nullable(), // admin user

    items:              model.hasMany(() => PosCreditMemoItem, { mappedBy: 'credit_memo' })
})

export default PosCreditMemo
