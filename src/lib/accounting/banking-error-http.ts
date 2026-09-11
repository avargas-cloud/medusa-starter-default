import type { MedusaResponse } from "@medusajs/framework/http";

import { BankingError } from "../banking/security";

/**
 * `assertBankAccountingPeriodOpen`/`periodKey` throw `BankingError` (its own
 * `.status`/`.code`, e.g. 423 `BANKING_ACCOUNTING_PERIOD_CLOSED`, 400
 * `BANKING_INVALID_ACCOUNTING_DATE`) — same shape `banking/_lib/http.ts`'s
 * `bankFailure` maps for the Banking routes. The vendor-credits/bill-payments
 * routes call the period lock too, so they need the same translation instead
 * of letting it fall through to a generic 500.
 *
 * Returns the response if handled, `null` if the caller should keep
 * inspecting the error (e.g. a domain-specific error type).
 */
export function bankingErrorResponse(
  res: MedusaResponse,
  error: unknown
): MedusaResponse | null {
  if (error instanceof BankingError) {
    return res.status(error.status).json({ error: error.code, code: error.code });
  }
  return null;
}
