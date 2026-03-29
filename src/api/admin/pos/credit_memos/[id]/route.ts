import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { CREDIT_MEMO_MODULE } from "../../../../../modules/credit_memos"
import CreditMemoModuleService from "../../../../../modules/credit_memos/service"

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const logger = req.scope.resolve("logger")
    const creditMemoService: CreditMemoModuleService = req.scope.resolve(CREDIT_MEMO_MODULE)
    const { id } = req.params as { id: string }

    try {
        const creditMemo = await creditMemoService.retrievePosCreditMemo(id, {
            relations: ["items"]
        })

        if (!creditMemo) {
            res.status(404).json({ message: "Credit Memo not found" })
            return
        }

        // Enrich with invoice_number from pos_invoice if invoice_id is present
        let invoice_number: string | null = null
        if ((creditMemo as any).invoice_id) {
            try {
                const pgConnection = req.scope.resolve("__pg_connection__") as any
                const row = await pgConnection('pos_invoice')
                    .where({ id: (creditMemo as any).invoice_id })
                    .select('invoice_number')
                    .first()
                invoice_number = row?.invoice_number ?? null
            } catch { /* non-critical */ }
        }

        res.status(200).json({ credit_memo: { ...creditMemo, invoice_number } })

    } catch (e: any) {
        logger.error(`[credit_memos GET] failed: ${e.message}`)
        res.status(500).json({ success: false, message: e.message })
    }
}
