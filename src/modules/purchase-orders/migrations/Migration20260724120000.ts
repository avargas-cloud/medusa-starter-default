import { Migration } from "@mikro-orm/migrations";

/**
 * Adopting a QuickBooks bill (from the "Match QB Bills" admin-tools page)
 * mirrors an existing QB bill into a local vendor_bill row keyed by its QB
 * TxnID (qb_txn_id). Two local rows pointing at the same QB TxnID is the
 * double-adopt bug: it would double-bill the PO. The adopt route already
 * checks-then-inserts, but that races under concurrent clicks — this partial
 * unique index is the durable DB-level guard.
 *
 * Scope: active rows only (deleted_at IS NULL). Soft-deleted history is allowed
 * to carry duplicate TxnIDs (verified 2026-07-24: 12 dup TxnIDs exist, all among
 * soft-deleted rows; 0 among live rows). Owned bills also populate qb_txn_id once
 * synced, so the constraint spans owned + adopted alike — exactly the intent
 * (one live local row per QB bill, whoever created it).
 */
export class Migration20260724120000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_vendor_bill_qb_txn_id_active
        ON vendor_bill (qb_txn_id)
        WHERE qb_txn_id IS NOT NULL AND deleted_at IS NULL;
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      DROP INDEX IF EXISTS uniq_vendor_bill_qb_txn_id_active;
    `);
  }
}
