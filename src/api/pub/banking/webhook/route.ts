import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { receiveBankWebhook } from "../../../../lib/banking/webhooks";
import { BankingError, bankingErrorCode } from "../../../../lib/banking/security";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const raw = (req as MedusaRequest & { rawBody?: Buffer }).rawBody;
    const signature = req.headers["plaid-verification"];
    if (!Buffer.isBuffer(raw) || typeof signature !== "string") throw new BankingError("BANKING_INVALID_WEBHOOK_SIGNATURE", 401);
    return res.json(await receiveBankWebhook(raw, signature));
  } catch (error) {
    return res.status(error instanceof BankingError ? error.status : 500).json({ error: bankingErrorCode(error) });
  }
}
