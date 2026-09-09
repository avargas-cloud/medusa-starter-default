import { createHash } from "node:crypto";
import { getDbPool } from "../../api/utils/db-pool";
import { BankingError, requireBankingSandbox } from "./security";
import { reviewCapacity, runReviewCommand } from "./review-common";
import { loadReviewContext, persistReview } from "./review-core";
import type { ReviewVersions } from "./review-types";
import { bankId } from "./store";

export type ReviewAttachment = {
  id: string; transaction_id: string; original_name: string; mime_type: string;
  size_bytes: number; sha256: string; uploaded_by: string; created_at: Date; detached_at: Date | null;
};
export const ATTACHMENT_COLUMNS = `id,transaction_id,original_name,mime_type,size_bytes,
  sha256,uploaded_by,created_at,detached_at`;
type AttachmentBody = ReviewVersions & { name: string; mime_type: string; content_base64: string };

export function validateReviewAttachment(body: Pick<AttachmentBody, "name" | "mime_type" | "content_base64">): Buffer {
  if (!body.name.trim() || body.name.length > 200 || /[\u0000-\u001f\u007f/\\]/.test(body.name)) {
    throw new BankingError("BANKING_ATTACHMENT_NAME_INVALID");
  }
  if (!body.content_base64 || body.content_base64.length > 6990508 || body.content_base64.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.content_base64)) throw new BankingError("BANKING_ATTACHMENT_INVALID");
  const bytes = Buffer.from(body.content_base64, "base64");
  if (bytes.toString("base64") !== body.content_base64 || bytes.length === 0 || bytes.length > 5 * 1024 * 1024) {
    throw new BankingError("BANKING_ATTACHMENT_SIZE_INVALID");
  }
  const valid = body.mime_type === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    : body.mime_type === "image/jpeg" ? bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))
    : body.mime_type === "application/pdf" ? bytes.subarray(0, 5).toString("ascii") === "%PDF-" : false;
  if (!valid) throw new BankingError("BANKING_ATTACHMENT_TYPE_INVALID");
  return bytes;
}

export async function addReviewAttachment(id: string, actorId: string, key: string, body: AttachmentBody) {
  if (body.mime_type !== "application/pdf") throw new BankingError("BANKING_ATTACHMENT_TYPE_INVALID");
  const bytes = validateReviewAttachment(body);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  // Neither receipt nor audit contains the file body; the content hash binds retries.
  const commandBody = { expected_revision: body.expected_revision, expected_source_version: body.expected_source_version,
    name: body.name, mime_type: body.mime_type, sha256, size_bytes: bytes.length };
  return runReviewCommand({ actorId, key, operation: "attachment_add", entityId: id, body: commandBody }, async client => {
    const context = await loadReviewContext(client, id, body);
    if (context.review?.status === "excluded") throw new BankingError("BANKING_RESTORE_REQUIRED", 409);
    await reviewCapacity(client, "bank_review_attachment", 25);
    // Replacement shares the review lock, CAS and transaction with the insert.
    // Keep old bytes for closed snapshots and audit downloads, never as active files.
    const replaced = await client.query<ReviewAttachment>(`UPDATE bank_review_attachment
      SET detached_at=now(),updated_at=now()
      WHERE transaction_id=$1 AND deleted_at IS NULL AND detached_at IS NULL
      RETURNING ${ATTACHMENT_COLUMNS}`, [id]);
    const result = await client.query<ReviewAttachment>(`INSERT INTO bank_review_attachment
      (id,transaction_id,original_name,mime_type,size_bytes,sha256,content_base64,uploaded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${ATTACHMENT_COLUMNS}`,
    [bankId("bra"), id, body.name, body.mime_type, bytes.length, sha256, body.content_base64, actorId]);
    const review = await persistReview(client, context, {
      status: "draft", confirmed_by: null, confirmed_at: null,
      source_version: context.review?.source_version ?? context.tx.source_version,
    },
      actorId, replaced.rowCount ? "attachment_replaced" : "attachment_added",
      { attachment: result.rows[0], replaced_attachments: replaced.rows });
    return { attachment: result.rows[0], review };
  });
}

export async function detachReviewAttachment(attachmentId: string, actorId: string, key: string, body: ReviewVersions) {
  return runReviewCommand({ actorId, key, operation: "attachment_detach", entityId: attachmentId, body }, async client => {
    const result = await client.query<ReviewAttachment>(`SELECT ${ATTACHMENT_COLUMNS}
      FROM bank_review_attachment WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [attachmentId]);
    const attachment = result.rows[0];
    if (!attachment) throw new BankingError("BANKING_ATTACHMENT_NOT_FOUND", 404);
    const context = await loadReviewContext(client, attachment.transaction_id, body);
    if (context.review?.status === "excluded") throw new BankingError("BANKING_RESTORE_REQUIRED", 409);
    if (attachment.detached_at) throw new BankingError("BANKING_ATTACHMENT_ALREADY_DETACHED", 409);
    await client.query("UPDATE bank_review_attachment SET detached_at=now(),updated_at=now() WHERE id=$1", [attachmentId]);
    return { review: await persistReview(client, context, {
      status: "draft", confirmed_by: null, confirmed_at: null,
      source_version: context.review?.source_version ?? context.tx.source_version,
    },
      actorId, "attachment_detached", { attachment }) };
  });
}

export async function downloadReviewAttachment(id: string) {
  requireBankingSandbox();
  const result = await getDbPool().query<ReviewAttachment & { content_base64: string }>(`SELECT
    att.id,att.transaction_id,att.original_name,att.mime_type,att.size_bytes,att.sha256,att.uploaded_by,
    att.created_at,att.detached_at,att.content_base64 FROM bank_review_attachment att
    JOIN bank_transaction t ON t.id=att.transaction_id JOIN bank_connection c ON c.id=t.connection_id
    WHERE att.id=$1 AND att.deleted_at IS NULL AND c.environment='sandbox'`, [id]);
  const attachment = result.rows[0];
  if (!attachment) throw new BankingError("BANKING_ATTACHMENT_NOT_FOUND", 404);
  const bytes = validateReviewAttachment({ name: attachment.original_name, mime_type: attachment.mime_type,
    content_base64: attachment.content_base64 });
  if (createHash("sha256").update(bytes).digest("hex") !== attachment.sha256) {
    throw new BankingError("BANKING_ATTACHMENT_INTEGRITY_FAILED", 500);
  }
  return { name: attachment.original_name, mime_type: attachment.mime_type, bytes };
}
