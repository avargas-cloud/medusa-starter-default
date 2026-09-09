import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { downloadReviewAttachment } from "../../../../../../lib/banking/review-attachments";
import { reviewAccess } from "../../../../../../lib/banking/review-permissions";
import { bankBody, bankFailure, bankId } from "../../../_lib/http";
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try {
    await reviewAccess(req);
    const attachment = await downloadReviewAttachment(bankBody(bankId, req.params.id));
    res.setHeader("Content-Type", attachment.mime_type);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", "attachment; filename=\"bank-attachment\"; filename*=UTF-8''"
      + encodeURIComponent(attachment.name).replace(/['()*]/g, char => "%" + char.charCodeAt(0).toString(16)));
    return res.send(attachment.bytes);
  } catch (error) { return bankFailure(res, error); }
}

