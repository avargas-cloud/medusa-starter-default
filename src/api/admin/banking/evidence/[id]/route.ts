import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { downloadCompletionEvidence } from "../../../../../lib/banking/completion-evidence";
import { reviewAccess } from "../../../../../lib/banking/review-permissions";
import { bankBody, bankId, bankFailure } from "../../_lib/http";
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try { await reviewAccess(req); const file = await downloadCompletionEvidence(bankBody(bankId, req.params.id));
    res.setHeader("Content-Type", file.mime_type); res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(file.name));
    return res.send(file.bytes);
  } catch (error) { return bankFailure(res, error); }
}
