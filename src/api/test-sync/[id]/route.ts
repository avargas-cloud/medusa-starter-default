import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { handleDraftOrderCreated } from '../../../subscribers/qb-draft-order-subscriber'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
    const logs: string[] = []
    
    const mockLogger = {
        info: (msg: string) => logs.push(`[INFO] ${msg}`),
        warn: (msg: string) => logs.push(`[WARN] ${msg}`),
        error: (msg: string) => logs.push(`[ERROR] ${msg}`),
    }

    try {
        await handleDraftOrderCreated({ id: req.params.id }, req.scope, mockLogger, true)
        return res.json({ success: true, logs })
    } catch (e: any) {
        return res.json({ success: false, error: e.stack, logs })
    }
}
