import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

export const GET = async (
  req: MedusaRequest,
  res: MedusaResponse
) => {
  const query = req.scope.resolve("query")
  
  const { data: qb_bank_accounts, metadata } = await query.graph({
    entity: "qb_bank_account",
    fields: [
      "id",
      "name",
      "list_id",
      "type",
      "is_active",
      "created_at",
      "updated_at"
    ],
    pagination: {
        skip: (req.validatedQuery?.skip as number) ?? 0,
        take: (req.validatedQuery?.take as number) ?? 50,
    }
  })

  res.json({
    qb_bank_accounts,
    count: metadata?.count ?? qb_bank_accounts.length,
    offset: metadata?.skip ?? 0,
    limit: metadata?.take ?? 50,
  })
}

export const POST = async (
  req: MedusaRequest,
  res: MedusaResponse
) => {
  const financeModuleService = req.scope.resolve("finance")
  
  try {
      const qbBankAccount = await financeModuleService.createQbBankAccounts(req.body as any)
      
      res.status(201).json({ qb_bank_account: qbBankAccount })
  } catch(e: any) {
      if (e.message?.includes('unique')) {
        res.status(400).json({ error: "A bank account with this ListID already exists." })
        return
      }
      res.status(500).json({ error: e.message })
  }
}
