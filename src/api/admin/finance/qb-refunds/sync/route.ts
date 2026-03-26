import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { qbRefunds } from "../../../../../lib/quickbooks/client"

export const POST = async (
  req: MedusaRequest,
  res: MedusaResponse
) => {
  const { refund_id, qb_bank_account_id } = req.body as { refund_id: string; qb_bank_account_id: string }
  if (!refund_id || !qb_bank_account_id) {
      return res.status(400).json({ error: "Missing refund_id or qb_bank_account_id" })
  }

  const query = req.scope.resolve("query")
  
  // 1. Fetch the refund to ensure it exists and get amount/payment linkage
  const { data: refunds } = await query.graph({
    entity: "refund",
    filters: { id: refund_id },
    fields: [
        "id", 
        "amount", 
        "payment.*", 
        "payment.order.*",
        "payment.order.customer.*",
        "metadata"
    ]
  })
  const refund = refunds[0]
  if (!refund) return res.status(404).json({ error: "Refund not found" })
  if (refund.metadata?.qb_synced) return res.status(400).json({ error: "Refund is already synced to QuickBooks" })

  // 2. Fetch the Bank Account ListID
  const { data: banks } = await query.graph({
      entity: "qb_bank_account",
      filters: { id: qb_bank_account_id },
      fields: ["id", "list_id"]
  })
  const bank = banks[0]
  if (!bank) return res.status(404).json({ error: "Bank Account not found" })

  // 3. Extract necessary fields
  const customerListId = (refund.payment as any)?.order?.customer?.metadata?.qb_list_id
  const originalPaymentTxnId = (refund.payment as any)?.metadata?.qb_txn_id

  if (!customerListId) return res.status(400).json({ error: "Original customer does not have a QB List ID mapped." })
  if (!originalPaymentTxnId) return res.status(400).json({ error: "Original payment was never synced to QB, cannot orchestrate refund." })

  // Convert amount from cents to dollars
  const amountDollars = refund.amount / 100

  try {
      // 4. Call the bridge orchestration
      const syncResult = await qbRefunds.syncRefund({
          refundId: refund.id,
          amount: amountDollars,
          originalPaymentTxnId: originalPaymentTxnId as string,
          customerListId: customerListId as string,
          bankAccountListId: bank.list_id
      })

      // 5. If successful, update the Refund's metadata in Medusa
      // In Medusa v2 natively, we use the payment module or directly update it via modules.
      // But we can use the remote link or query. Actually, we use the Payment Module to update the refund.
      const paymentModule = req.scope.resolve("payment")
      
      const newMetadata = {
          ...(refund.metadata || {}),
          qb_synced: true,
          qb_check_txn_id: syncResult.checkTxnId,
          qb_zero_payment_txn_id: syncResult.receivePaymentTxnId
      }

      await (paymentModule as any).updatePaymentRefunds({
          id: refund.id,
          metadata: newMetadata
      })

      return res.json({ success: true, result: syncResult })

  } catch (e: any) {
      console.error("[QB-SYNC-REFUND] Failed:", e)
      return res.status(500).json({ error: e.message })
  }
}
