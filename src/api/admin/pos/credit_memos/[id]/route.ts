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

        res.status(200).json({ credit_memo: creditMemo })

    } catch (e: any) {
        logger.error(`[credit_memos GET] failed: ${e.message}`)
        res.status(500).json({ success: false, message: e.message })
    }
}
