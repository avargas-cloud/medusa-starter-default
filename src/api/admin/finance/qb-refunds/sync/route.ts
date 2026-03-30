import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { FINANCE_MODULE } from "../../../../../modules/finance"
import { Modules } from "@medusajs/utils"
import { bridgeFetch, DRY_RUN } from "../../../../../lib/quickbooks/client/core"
import { writePipelineRow } from "../../../../../lib/quickbooks/qb-pipeline"

/**
 * POST /admin/finance/qb-refunds/sync
 * Fire-and-forget: enqueues a WriteCheck to the bridge and writes a submitted
 * pipeline row. The consolidator cron confirms/fails it and updates CustomerPayment.qb.
 * Body: { customer_payment_id, qb_bank_account_id }
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const { customer_payment_id, qb_bank_account_id } = req.body as {
    customer_payment_id: string
    qb_bank_account_id: string
  }

  if (!customer_payment_id || !qb_bank_account_id) {
    return res.status(400).json({ error: "Missing customer_payment_id or qb_bank_account_id" })
  }

  const financeService = req.scope.resolve(FINANCE_MODULE)
  const customerModule = req.scope.resolve(Modules.CUSTOMER)

  // 1. Fetch the CustomerPayment
  const payments = await financeService.listCustomerPayments({ id: customer_payment_id } as any)
  const payment = (payments as any[])[0]
  if (!payment) return res.status(404).json({ error: "CustomerPayment not found" })
  if (payment.type !== "refund") return res.status(400).json({ error: "Payment is not a refund" })
  if (payment.qb?.status === "yes") return res.status(400).json({ error: "Already synced to QuickBooks" })

  // 2. Fetch the bank account
  const banks = await financeService.listQbBankAccounts({ id: qb_bank_account_id } as any)
  const bank = (banks as any[])[0]
  if (!bank) return res.status(404).json({ error: "Bank account not found" })

  // 3. Fetch customer QB ListID
  let customer: any
  try {
    customer = await customerModule.retrieveCustomer(payment.customer_id)
  } catch {
    return res.status(404).json({ error: "Customer not found" })
  }
  const customerListId = customer?.metadata?.qb_list_id
  if (!customerListId) {
    return res.status(400).json({ error: "Customer does not have a QB ListID — sync customer first" })
  }

  const amountDollars = (Number(payment.amount) / 100).toFixed(2)
  const payLabel = payment.display_id ? `PAY-${payment.display_id}` : customer_payment_id.slice(-8).toUpperCase()
  const refLabel = (payment.reference && payment.reference.length <= 20)
    ? payment.reference
    : payLabel
  const medusaRef = `Refund ${payLabel}`

  if (DRY_RUN) {
    await writePipelineRow({
      referenceId:     customer_payment_id,
      referenceType:   "customer_payment",
      step:            "write_check",
      status:          "confirmed",
      qbTxnId:         "DRY-RUN-CHECK-TXN",
      medusaRefNumber: refLabel,
    })
    return res.json({ success: true, dry_run: true })
  }

  // 4. Enqueue CheckAdd to bridge
  let enqueueRes: any
  try {
    enqueueRes = await bridgeFetch("POST", "/api/sync/enqueue", {
      type: "check",
      action: "add",
      data: {
        AccountRef:     { ListID: bank.list_id },
        PayeeEntityRef: { ListID: customerListId },
        TxnDate:        new Date().toISOString().split("T")[0],
        RefNumber:      refLabel,
        Memo:           `POS Refund — ${refLabel}`,
        ExpenseLineAdd: [{
          AccountRef: { FullName: "Accounts Receivable" },
          Amount:     amountDollars,
          Memo:       `Refund for ${refLabel}`,
          CustomerRef: { ListID: customerListId },
        }],
      },
    })
  } catch (e: any) {
    return res.status(500).json({ error: `Bridge enqueue failed: ${e.message}` })
  }

  if (!enqueueRes?.operation_id) {
    return res.status(500).json({ error: "Bridge did not return operation_id" })
  }

  // 5. Write pipeline row as submitted (consolidator will confirm/fail)
  const writeCheckRowId = await writePipelineRow({
    referenceId:     customer_payment_id,
    referenceType:   "customer_payment",
    step:            "write_check",
    status:          "submitted",
    bridgeOpId:      enqueueRes.operation_id,
    medusaRefNumber: medusaRef,
  })

  // 5b. If this is a credit memo refund, queue a refund_payment row (waiting)
  //     Consolidator will activate it after write_check confirms, applying
  //     the check TxnID against the credit memo TxnID via ReceivePaymentAdd.
  const isCreditMemoRefund = payment.reference && String(payment.reference).startsWith("CM-")
  if (isCreditMemoRefund) {
    await writePipelineRow({
      referenceId:     customer_payment_id,
      referenceType:   "customer_payment",
      step:            "refund_payment",
      status:          "waiting",
      dependsOn:       writeCheckRowId,
      medusaRefNumber: medusaRef,
      payload:         { customerListId, creditMemoRef: payment.reference },
    })
  }

  // 6. Mark CustomerPayment.qb as processing so it doesn't re-appear before consolidator runs
  await financeService.updateCustomerPayments(
    { id: customer_payment_id },
    { qb: { status: "processing", operation_id: enqueueRes.operation_id } }
  )

  return res.json({ success: true, queued: true, operation_id: enqueueRes.operation_id })
}
