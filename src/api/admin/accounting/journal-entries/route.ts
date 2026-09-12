import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import type { PoolClient } from "pg";

import {
  createJournalEntry,
  listJournalEntries,
  postJournalEntry,
} from "../../../../lib/ledger";
import {
  invalidBody,
  ledgerFailure,
  parseListFilters,
} from "../../../../lib/ledger/documents/manual-http";
import {
  journalEntryBodySchema,
  toJournalEntryInput,
} from "../../../../lib/ledger/documents/manual-schemas";
import {
  accessFailure,
  assertAccounting,
} from "../../../../lib/pos/access-level";
import { getDbPool } from "../../../utils/db-pool";

/**
 * /admin/accounting/journal-entries — Journal Entries manuales del GL.
 *
 * GET  ?from&to&status&account_list_id&q&limit&cursor
 *   → { items: JournalEntry[], next_cursor: "<day>,<id>" | null }
 * POST { day, memo?, evidence_id?, post?: boolean,
 *        lines: [{ account_list_id, debit_cents, credit_cents, memo?,
 *                  entity_type?: "customer"|"vendor", entity_id?, entity_name? }] }
 *   → 201 { journal_entry: JournalEntry, post?: { status: "posted"|"already_posted", entry_id } }
 *
 * JournalEntry = { id, number "JE-0001", day, memo, status draft|posted|voided,
 *   total_cents, entry_id, posted_at, voided_at, void_reason, evidence_id,
 *   created_by, created_at, updated_at,
 *   lines: [{ id, sort_order, account_list_id, account_snapshot {id,name,account_type},
 *             debit_cents, credit_cents, memo, entity_type, entity_id, entity_name }] }
 * Cents son enteros (number). Errores: { error, code, details? } — 400
 * invalid_body/GL_SOURCE_INVALID/GL_UNBALANCED_DOCUMENT, 409 GL_PERIOD_CLOSED.
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
    const filters = parseListFilters(req.query as Record<string, unknown>);
    return res.json(await listJournalEntries(client, filters));
  } catch (error) {
    return ledgerFailure(res, error);
  } finally {
    client.release();
  }
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let actorId: string;
  try {
    actorId = (await assertAccounting(req)).userId;
  } catch (error) {
    return accessFailure(res, error);
  }
  const parsed = journalEntryBodySchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res, parsed.error.issues[0]?.message);

  const client: PoolClient = await getDbPool().connect();
  try {
    let journalEntry = await createJournalEntry(
      client,
      toJournalEntryInput(parsed.data),
      actorId
    );
    if (!parsed.data.post)
      return res.status(201).json({ journal_entry: journalEntry });
    const post = await postJournalEntry(client, journalEntry.id, actorId);
    journalEntry = {
      ...journalEntry,
      status: "posted",
      entry_id: post.entry_id,
    };
    return res.status(201).json({ journal_entry: journalEntry, post });
  } catch (error) {
    return ledgerFailure(res, error);
  } finally {
    client.release();
  }
}
