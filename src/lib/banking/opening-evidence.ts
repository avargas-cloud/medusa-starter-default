import { createHash } from "node:crypto";
import { getDbPool } from "../../api/utils/db-pool";
import { bankId } from "./store";
import { reviewCapacity, runReviewCommand } from "./review-common";
import { validateReviewAttachment } from "./review-attachments";
import { BankingError, requireBankingEnabled } from "./security";
import { openingEvidenceSchema, type OpeningEvidence } from "./opening-types";

export const OPENING_EVIDENCE_COLUMNS = "id,original_name,mime_type,size_bytes,sha256,uploaded_by,created_at";
export async function addOpeningEvidence(actorId: string, key: string, input: { name: string; mime_type: "application/pdf"; content_base64: string }) {
  const body = openingEvidenceSchema.parse(input), bytes = validateReviewAttachment(body);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return runReviewCommand({ actorId, key, operation: "opening_evidence", entityId: "new", body: {
    name: body.name, mime_type: body.mime_type, sha256, size_bytes: bytes.length } }, async client => {
    await reviewCapacity(client, "bank_opening_evidence", 50);
    const result = await client.query<OpeningEvidence>(`INSERT INTO bank_opening_evidence
      (id,original_name,mime_type,size_bytes,sha256,content_base64,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7)
      RETURNING ${OPENING_EVIDENCE_COLUMNS}`, [bankId("boe"), body.name, body.mime_type, bytes.length, sha256, body.content_base64, actorId]);
    return { evidence: result.rows[0]! };
  });
}
export async function downloadOpeningEvidence(id: string) {
  requireBankingEnabled();
  const evidence = (await getDbPool().query<OpeningEvidence & { content_base64: string }>(`SELECT ${OPENING_EVIDENCE_COLUMNS},
    content_base64 FROM bank_opening_evidence WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
  if (!evidence) throw new BankingError("BANKING_OPENING_EVIDENCE_NOT_FOUND", 404);
  const bytes = validateReviewAttachment({ name: evidence.original_name, mime_type: evidence.mime_type, content_base64: evidence.content_base64 });
  if (createHash("sha256").update(bytes).digest("hex") !== evidence.sha256) throw new BankingError("BANKING_ATTACHMENT_INTEGRITY_FAILED", 500);
  return { name: evidence.original_name, mime_type: evidence.mime_type, bytes };
}
