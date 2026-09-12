import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import type { PoolClient } from "pg";

import { getJournalEntry, updateJournalEntry } from "../../../../../lib/ledger";
import {
  invalidBody,
  ledgerFailure,
} from "../../../../../lib/ledger/documents/manual-http";
import {
  journalEntryBodySchema,
  toJournalEntryInput,
} from "../../../../../lib/ledger/documents/manual-schemas";
import {
  accessFailure,
  assertAccounting,
} from "../../../../../lib/pos/access-level";
import { getDbPool } from "../../../../utils/db-pool";

/**
 * GET   /admin/accounting/journal-entries/:id → { journal_entry } | 404 GL_DOCUMENT_NOT_FOUND
 * PATCH /admin/accounting/journal-entries/:id — mismo body que el POST (sin `post`);
 *       reemplaza header + líneas de un `draft`. 409 GL_DOCUMENT_NOT_DRAFT si ya se
 *       posteó/anuló (anular y crear de nuevo). → { journal_entry }
 */
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    await assertAccounting(req);
  } catch (error) {
    return accessFailure(res, error);
  }
  const client: PoolClient = await getDbPool().connect();
  try {
    const journalEntry = await getJournalEntry(client, req.params.id as string);
    if (!journalEntry)
      return res.status(404).json({
        error: "Journal entry not found",
        code: "GL_DOCUMENT_NOT_FOUND",
      });
    return res.json({ journal_entry: journalEntry });
  } finally {
    client.release();
  }
}

export async function PATCH(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    await assertAccounting(req);
  } catch (error) {
    return accessFailure(res, error);
  }
  const parsed = journalEntryBodySchema
    .omit({ post: true })
    .safeParse(req.body);
  if (!parsed.success) return invalidBody(res, parsed.error.issues[0]?.message);

  const client: PoolClient = await getDbPool().connect();
  try {
    const journalEntry = await updateJournalEntry(
      client,
      req.params.id as string,
      toJournalEntryInput(parsed.data)
    );
    return res.json({ journal_entry: journalEntry });
  } catch (error) {
    return ledgerFailure(res, error);
  } finally {
    client.release();
  }
}
