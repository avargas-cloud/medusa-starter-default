/**
 * Re-enqueue the QuickBooks ADD of a GL document (bank_deposit / gl_check /
 * gl_transfer / gl_journal_entry) whose previous ADD was confirmed and then
 * voided in QuickBooks — the mirror columns are cleared, the document is
 * still posted in the ledger, and nothing re-sends it on its own.
 *
 * Born 09/16/2026: DEP-0685's first DepositAdd confirmed (1D163D) and the
 * confirm handler TxnVoid'ed it one minute later because it read the deposit
 * as "not posted" (legacy-shape check). After the fix, the deposit needs one
 * new DepositAdd — this script queues exactly one row; the dispatcher does the rest.
 *
 * Usage (dry-run prints the facts; APPLY=true enqueues):
 *   env DATABASE_URL=... APPLY=true GL_DOC_KIND=bank_deposit GL_DOC_NUMBER=DEP-0685 \
 *     node --import ./node_modules/tsx/dist/loader.mjs src/scripts/fix/reenqueue-gl-document-add.ts
 */
import { Pool } from "pg";
import { poolAsKnex } from "../../lib/quickbooks/gl-documents/db-adapters";
import { enqueueGlDocumentAdd } from "../../lib/quickbooks/gl-documents/enqueue";
import { loadGlDocumentAddFacts } from "../../lib/quickbooks/gl-documents/facts";
import type { GlDocumentKind } from "../../lib/quickbooks/gl-documents/types";

const KINDS: GlDocumentKind[] = ["bank_deposit", "gl_check", "gl_transfer", "gl_journal_entry"];

async function main() {
  const kind = process.env.GL_DOC_KIND as GlDocumentKind;
  const number = process.env.GL_DOC_NUMBER;
  if (!KINDS.includes(kind) || !number) throw new Error("GL_DOC_KIND (bank_deposit|gl_check|gl_transfer|gl_journal_entry) and GL_DOC_NUMBER are required");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    const doc = (await pool.query<{ id: string; qb_txn_id: string | null }>(
      `SELECT id, qb_txn_id FROM ${kind} WHERE number = $1 AND deleted_at IS NULL`,
      [number]
    )).rows[0];
    if (!doc) throw new Error(`${kind} ${number} not found`);
    if (doc.qb_txn_id) throw new Error(`${number} still mirrors QuickBooks ${doc.qb_txn_id} — nothing to re-add`);
    const live = (await pool.query(
      `SELECT id, status FROM qb_order_pipeline WHERE step = 'gl_document_add' AND reference_type = $1 AND reference_id = $2
        AND status IN ('pending', 'waiting', 'processing', 'submitted')`,
      [kind, doc.id]
    )).rows;
    if (live.length) throw new Error(`an ADD row is already live: ${JSON.stringify(live)}`);
    const db = poolAsKnex(pool);
    const facts = await loadGlDocumentAddFacts(db, kind, doc.id);
    if (!facts.ready) throw new Error(`facts not ready: ${facts.reason}`);
    const lines = facts.qbxml.match(/<DepositLineAdd>|<ExpenseLineAdd>|<JournalDebitLine>|<JournalCreditLine>/g)?.length ?? 0;
    console.log(`${number} (${doc.id}) → ${facts.qbTxnType}Add ready, ${lines} lines`);
    if (process.env.APPLY !== "true") {
      console.log("dry-run — set APPLY=true to enqueue one gl_document_add row");
      return;
    }
    const result = await enqueueGlDocumentAdd(db, kind, doc.id);
    console.log("enqueued:", JSON.stringify(result));
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
