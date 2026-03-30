import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { getDbPool } from "../../../../utils/db-pool"

export const PATCH = async (req: MedusaRequest, res: MedusaResponse) => {
    const { id } = req.params as { id: string }
    const { is_default } = req.body as { is_default?: boolean }
    const financeService = req.scope.resolve("finance") as any

    try {
        if (is_default === true) {
            // Unset all others first, then set this one
            const pool = getDbPool()
            await pool.query(`UPDATE qb_bank_account SET is_default = false WHERE is_default = true`)
        }

        const updated = await financeService.updateQbBankAccounts({ id, is_default })
        res.json({ qb_bank_account: updated })
    } catch (err: any) {
        res.status(500).json({ error: err.message })
    }
}
