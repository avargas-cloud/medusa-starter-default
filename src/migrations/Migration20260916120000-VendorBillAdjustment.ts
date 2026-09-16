import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * ap-rounding-cleanup-20260916: `vendor_bill_adjustment` — the AP twin of
 * `pos_rounding_adjustment`. A bill whose POS payable (Σ lines) differs from
 * what the vendor was really paid gets an EXPLICIT adjustment, never a fake
 * payment or credit:
 *
 *   kind = 'rounding'        integer-cent unit costs vs the vendor's 3-4 decimal
 *                            prices (residual ≤ tolerance, config).
 *   kind = 'price_variance'  the PO price the POS billed is not the price the
 *                            vendor invoiced (ADI GLOBAL: QB bill −0.65 %).
 *
 *   direction = 'decrease_ap'  Dr AP / Cr account   (POS owed more than real)
 *   direction = 'increase_ap'  Dr account / Cr AP   (POS owed less than real)
 *
 * QuickBooks receives NOTHING for these: the bill is already settled there,
 * which is the whole reason the residual exists. `evidence` keeps what QB
 * said (AmountDue, IsPaid, LinkedTxn) at the time — the "not required, already
 * correct" lane. `source_fingerprint` makes every creator idempotent.
 */
export class VendorBillAdjustment20260916120000 implements MigrationInterface {
  name = "VendorBillAdjustment20260916120000";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`SET LOCAL lock_timeout = '15s'`);
    await q.query(`
      CREATE TABLE IF NOT EXISTS vendor_bill_adjustment (
        id                 text PRIMARY KEY,
        vendor_bill_id     text NOT NULL REFERENCES vendor_bill(id),
        kind               text NOT NULL CHECK (kind IN ('rounding','price_variance')),
        direction          text NOT NULL CHECK (direction IN ('decrease_ap','increase_ap')),
        amount_cents       bigint NOT NULL CHECK (amount_cents > 0),
        account_list_id    text NOT NULL,
        adjustment_date    date NOT NULL,
        source_fingerprint text NOT NULL,
        evidence           jsonb NOT NULL DEFAULT '{}'::jsonb,
        memo               text NULL,
        created_by         text NULL,
        created_at         timestamptz NOT NULL DEFAULT now(),
        voided_at          timestamptz NULL,
        voided_by          text NULL,
        voided_reason      text NULL,
        deleted_at         timestamptz NULL,
        CONSTRAINT uq_vba_fingerprint UNIQUE (vendor_bill_id, kind, source_fingerprint)
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS idx_vba_bill ON vendor_bill_adjustment (vendor_bill_id) WHERE voided_at IS NULL AND deleted_at IS NULL`
    );

    // source_kind CHECK of the GL journal: union of what is live + the new kind
    // (same recipe as GlBankDeposits1789500000000 — never retype the list).
    const rows = (await q.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'bank_journal_entry_source_kind_check' AND conrelid = 'bank_journal_entry'::regclass`
    )) as Array<{ def: string }>;
    const current = new Set(
      Array.from(
        (rows[0]?.def ?? "").matchAll(/'([a-z_]+)'::text/g),
        (m) => m[1]
      )
    );
    if (current.size === 0) {
      throw new Error(
        "VendorBillAdjustment20260916120000: bank_journal_entry_source_kind_check not found or unparsable — refusing to guess the kind list"
      );
    }
    current.add("vendor_bill_adjustment");
    const list = [...current].map((k) => `'${k}'`).join(", ");
    await q.query(
      `ALTER TABLE bank_journal_entry DROP CONSTRAINT IF EXISTS bank_journal_entry_source_kind_check`
    );
    await q.query(
      `ALTER TABLE bank_journal_entry ADD CONSTRAINT bank_journal_entry_source_kind_check CHECK (source_kind IN (${list})) NOT VALID`
    );
    await q.query(
      `ALTER TABLE bank_journal_entry VALIDATE CONSTRAINT bank_journal_entry_source_kind_check`
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    // The CHECK keeps the kind on purpose: rows posted with it may exist.
    await q.query(`DROP TABLE IF EXISTS vendor_bill_adjustment`);
  }
}
