import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { getDbPool } from "../../api/utils/db-pool";

import { completionEvidenceSchema } from "./movement-types";
import { validateReviewAttachment } from "./review-attachments";
import { runReviewCommand } from "./review-common";
import { BankingError, requireBankingEnabled } from "./security";
import { bankId } from "./store";

export const COMPLETION_EVIDENCE_COLUMNS =
  "id,original_name,mime_type,size_bytes,sha256,version,uploaded_by,created_at";
type CompletionEvidenceRow = {
  id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  version: number;
  uploaded_by: string;
  created_at: string;
};
export async function completionCapacity(
  client: PoolClient,
  table: string,
  cap: number
): Promise<void> {
  if (
    ![
      "bank_movement",
      "bank_movement_allocation",
      "bank_source_claim",
      "bank_evidence_document",
      "bank_journal_entry",
      "bank_journal_line",
      "bank_merchant_settlement",
      "bank_merchant_settlement_line",
    ].includes(table)
  )
    throw new BankingError("BANKING_CAPACITY_INVALID", 500);
  const count = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table}`
  );
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- SELECT COUNT(*) always returns exactly one row
  if (Number(count.rows[0]!.count) >= cap)
    throw new BankingError("BANKING_SANDBOX_CAP_REACHED", 409);
}
export async function completionEvidence(
  client: PoolClient,
  id: string
): Promise<{
  id: string;
  sha256: string;
  version: number;
  original_name: string;
}> {
  const row = (
    await client.query<{
      id: string;
      sha256: string;
      version: number;
      original_name: string;
    }>(
      `SELECT ${COMPLETION_EVIDENCE_COLUMNS} FROM bank_evidence_document WHERE id=$1 AND deleted_at IS NULL FOR SHARE`,
      [id]
    )
  ).rows[0];
  if (!row) throw new BankingError("BANKING_EVIDENCE_REQUIRED", 409);
  return row;
}
export async function addCompletionEvidence(
  actorId: string,
  key: string,
  input: unknown
): Promise<{ evidence: CompletionEvidenceRow }> {
  const body = completionEvidenceSchema.parse(input),
    bytes = validateReviewAttachment(body);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return runReviewCommand(
    {
      actorId,
      key,
      operation: "completion_evidence",
      entityId: "new",
      body: { name: body.name, sha256, size_bytes: bytes.length },
    },
    async (client) => {
      await completionCapacity(client, "bank_evidence_document", 100);
      const result = await client.query<CompletionEvidenceRow>(
        `INSERT INTO bank_evidence_document
      (id,original_name,mime_type,size_bytes,sha256,version,content_base64,uploaded_by)
      VALUES($1,$2,'application/pdf',$3,$4,1,$5,$6) RETURNING ${COMPLETION_EVIDENCE_COLUMNS}`,
        [
          bankId("bed"),
          body.name,
          bytes.length,
          sha256,
          body.content_base64,
          actorId,
        ]
      );
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- INSERT ... RETURNING for a single inserted row always returns exactly one row
      return { evidence: result.rows[0]! };
    }
  );
}
export async function listCompletionEvidence(): Promise<{
  evidence: CompletionEvidenceRow[];
}> {
  requireBankingEnabled();
  return {
    evidence: (
      await getDbPool().query<CompletionEvidenceRow>(
        `SELECT ${COMPLETION_EVIDENCE_COLUMNS} FROM bank_evidence_document
    WHERE deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 100`
      )
    ).rows,
  };
}
export async function downloadCompletionEvidence(id: string): Promise<{
  name: string;
  mime_type: "application/pdf";
  bytes: Buffer;
}> {
  requireBankingEnabled();
  const row = (
    await getDbPool().query<{
      original_name: string;
      content_base64: string;
      sha256: string;
    }>(
      "SELECT original_name,content_base64,sha256 FROM bank_evidence_document WHERE id=$1 AND deleted_at IS NULL",
      [id]
    )
  ).rows[0];
  if (!row) throw new BankingError("BANKING_EVIDENCE_NOT_FOUND", 404);
  const bytes = validateReviewAttachment({
    name: row.original_name,
    mime_type: "application/pdf",
    content_base64: row.content_base64,
  });
  if (createHash("sha256").update(bytes).digest("hex") !== row.sha256)
    throw new BankingError("BANKING_ATTACHMENT_INTEGRITY_FAILED", 500);
  return { name: row.original_name, mime_type: "application/pdf", bytes };
}
