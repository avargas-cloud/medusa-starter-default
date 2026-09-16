import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { listDepositAccounts } from "../../../../../lib/banking/deposit-read";
import { reviewAccess } from "../../../../../lib/banking/review-permissions";
import { bankFailure } from "../../_lib/http";
/** Deposit-to accounts of Record deposit: Plaid depository accounts plus the
 * QuickBooks bank accounts with no feed (Cash Register, Petty Cash…), which
 * the Banks overview cannot list because they have no `bank_account` row. */
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    await reviewAccess(req);
    return res.json(await listDepositAccounts());
  } catch (error) {
    return bankFailure(res, error);
  }
}
