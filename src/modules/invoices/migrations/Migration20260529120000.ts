import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Add frozen net-per-line column to pos_invoice_item.
 *
 * `net_total_cents` is the post-line-discount, PRE-order-discount net line total
 * in cents, computed by the POS with the round-then-multiply convention
 * (2026-05-29). The QB sync reads it verbatim instead of recomputing the
 * discount, so the QB line equals what Medusa charged (rate × qty === amount).
 *
 * NULL = legacy invoice issued before this column existed → the sync falls back
 * to the old recompute and the document reproduces its original amount untouched.
 * Forward-only by data presence; no backfill, no historical re-sync.
 *
 * bigNumber maps to a (numeric + raw_<col> jsonb) pair in Medusa v2. Both are
 * nullable so legacy rows stay NULL and the sync's NULL-guard kicks in.
 */
export class Migration20260529120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE pos_invoice_item
      ADD COLUMN IF NOT EXISTS net_total_cents     numeric NULL,
      ADD COLUMN IF NOT EXISTS raw_net_total_cents jsonb   NULL;
    `);

    // Backfill existing rows ATOMICALLY with the column add, so by the time the
    // round-then-multiply code serves traffic every legacy invoice is already frozen
    // at the value it was billed at — no window where a force-sync could re-round it.
    // Formula mirrors the OLD multiply-then-round convention (validated against 532 real
    // invoices in the sandbox; 0 anomalies, totals reconciled to the cent):
    //   percent → total - min(total, round(total * value/100))
    //   fixed   → total - min(total, round(value*100) * quantity)
    //   none    → total
    this.addSql(`
      UPDATE pos_invoice_item AS t
         SET net_total_cents     = s.net,
             raw_net_total_cents = jsonb_build_object('value', s.net)
        FROM (
          SELECT id,
                 CASE
                   WHEN discount_type = 'percent' AND discount_value > 0
                     THEN GREATEST(0, ROUND(total) - LEAST(ROUND(total), ROUND(ROUND(total) * discount_value / 100)))
                   WHEN discount_type = 'fixed' AND discount_value > 0
                     THEN GREATEST(0, ROUND(total) - LEAST(ROUND(total), ROUND(discount_value * 100) * quantity))
                   ELSE ROUND(total)
                 END AS net
            FROM pos_invoice_item
           WHERE net_total_cents IS NULL
             AND deleted_at IS NULL
        ) s
       WHERE t.id = s.id;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE pos_invoice_item
      DROP COLUMN IF EXISTS net_total_cents,
      DROP COLUMN IF EXISTS raw_net_total_cents;
    `);
  }
}
