import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { readStatement } from "../../../../../../lib/banking/statement-read";
import { BankingError } from "../../../../../../lib/banking/security";
import { reviewAccess } from "../../../../../../lib/banking/review-permissions";
import { bankBody, bankId, bankFailure } from "../../../_lib/http";
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try { await reviewAccess(req); const context = await readStatement(bankBody(bankId, req.params.id));
    if (context.statement.status !== "closed") throw new BankingError("BANKING_STATEMENT_CLOSED_REQUIRED", 409);
    res.setHeader("Content-Disposition", `attachment; filename="statement-${context.statement.id}.json"`);
    return res.json({ statement: context.statement, closed_snapshot: context.statement.closed_snapshot,
      current_context: context, needs_review: context.needs_review, coverage: "bank_account_period", global_ledger_coverage: "partial", zero_gl: true });
  } catch (error) { return bankFailure(res, error); }
}
