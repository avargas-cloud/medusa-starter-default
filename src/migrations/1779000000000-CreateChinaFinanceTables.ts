import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateChinaFinanceTables1779000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── china_wire_transfer ──────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS china_wire_transfer (
        id                   TEXT PRIMARY KEY,
        status               TEXT NOT NULL DEFAULT 'pending',
        sent_date            DATE NULL,
        wire_amount_cents    INTEGER NOT NULL DEFAULT 0,
        bank_fee_cents       INTEGER NULL,
        received_amount_cents INTEGER NULL,
        notes                TEXT NULL,
        confirmed_date       DATE NULL,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // ── china_finance_bill ───────────────────────────────────────────────────
    // type:          'vendor_bill' | 'legacy' | 'bank_fee'
    // document_type: 'commercial_invoice' | 'purchasing_services' |
    //                'shipping_cost' | 'bank_fee'
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS china_finance_bill (
        id                TEXT PRIMARY KEY,
        type              TEXT NOT NULL,
        sort_order        INTEGER NOT NULL DEFAULT 0,
        vendor_bill_id    TEXT NULL REFERENCES vendor_bill(id),
        wire_transfer_id  TEXT NULL REFERENCES china_wire_transfer(id),
        document_type     TEXT NOT NULL,
        invoice_number    TEXT NULL,
        po_number         TEXT NULL,
        po_ref_number     TEXT NULL,
        payee             TEXT NULL,
        description       TEXT NULL,
        amount_cents      INTEGER NOT NULL DEFAULT 0,
        document_date     DATE NULL,
        due_date          DATE NULL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // ── china_finance_settings (singleton) ───────────────────────────────────
    // estimate_strategy: 'past_due_only' | 'due_before_next_payment'
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS china_finance_settings (
        id                     TEXT PRIMARY KEY DEFAULT 'singleton',
        payment_day_of_week    INTEGER NOT NULL DEFAULT 1,
        estimate_strategy      TEXT NOT NULL DEFAULT 'due_before_next_payment',
        created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      INSERT INTO china_finance_settings (id, payment_day_of_week, estimate_strategy)
      VALUES ('singleton', 1, 'due_before_next_payment')
      ON CONFLICT (id) DO NOTHING
    `);

    // ── Indexes ──────────────────────────────────────────────────────────────
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_cfb_sort_order
         ON china_finance_bill(sort_order)`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_cfb_wire_transfer_id
         ON china_finance_bill(wire_transfer_id)`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_cfb_vendor_bill_id
         ON china_finance_bill(vendor_bill_id)`
    );

    // ── Seed: vendor_bill-linked records (rows 235-237, 244-246 from Excel) ──
    // sort_order 1-3 = PO-1016 (174226), 10-12 = PO-1015 (174241)
    // amounts from vendor_bill_line sums confirmed against the Excel
    await queryRunner.query(`
      INSERT INTO china_finance_bill
        (id, type, sort_order, vendor_bill_id, document_type,
         invoice_number, po_number, po_ref_number, payee,
         amount_cents, document_date, due_date)
      VALUES
        (gen_random_uuid()::text, 'vendor_bill', 1,
         'vb_01KQWM7N5XCV18QBSNN3301C3W',
         'commercial_invoice', 'V260414-I2', '174226', 'PO-1016',
         'COMMERCIAL INVOICE', 211375, '2026-04-09', '2026-04-30'),

        (gen_random_uuid()::text, 'vendor_bill', 2,
         'vb_2050d35988cd486c84fe0855b2b32223',
         'purchasing_services', 'V260414-C2', '174226', 'PO-1016',
         'Purchasing Services', 31706, '2026-04-09', '2026-04-30'),

        (gen_random_uuid()::text, 'vendor_bill', 3,
         'vb_295b56d75e5c46a8a0c8cf64fb5a5d99',
         'shipping_cost', 'V260414-S2', '174226', 'PO-1016',
         'Shipping cost', 395780, '2026-04-09', '2026-04-30'),

        (gen_random_uuid()::text, 'vendor_bill', 10,
         'vb_01KQYXCCB9HTT732Z84969RXYF',
         'commercial_invoice', 'V260421-I1', '174241', 'PO-1015',
         'COMMERCIAL INVOICE', 301627, '2026-04-27', '2026-05-18'),

        (gen_random_uuid()::text, 'vendor_bill', 11,
         'vb_3a41d49a880a417d912199fd2bdcbbf3',
         'purchasing_services', 'V260421-I1', '174241', 'PO-1015',
         'Purchasing Services', 45244, '2026-04-27', '2026-05-18'),

        (gen_random_uuid()::text, 'vendor_bill', 12,
         'vb_ef004a5eb2a24253917a0dbb7e90542b',
         'shipping_cost', 'V260427-S1', '174241', 'PO-1015',
         'Shipping cost', 113750, '2026-04-27', '2026-05-18')
    `);

    // ── Seed: legacy records (rows 238-243, no QB link) ─────────────────────
    // PO 174235 (V260415): sort 4-6
    // PO 174234 (V260421): sort 7-9
    await queryRunner.query(`
      INSERT INTO china_finance_bill
        (id, type, sort_order, document_type, invoice_number,
         po_number, payee, amount_cents, document_date, due_date)
      VALUES
        (gen_random_uuid()::text, 'legacy', 4,
         'commercial_invoice', 'V260415-I1', '174235',
         'COMMERCIAL INVOICE', 299640, '2026-04-15', '2026-05-06'),

        (gen_random_uuid()::text, 'legacy', 5,
         'purchasing_services', 'V260415-C1', '174235',
         'Purchasing Services', 44946, '2026-04-15', '2026-05-06'),

        (gen_random_uuid()::text, 'legacy', 6,
         'shipping_cost', 'V260415-S1', '174235',
         'Shipping cost', 65800, '2026-04-15', '2026-05-06'),

        (gen_random_uuid()::text, 'legacy', 7,
         'commercial_invoice', 'V260421-I1', '174234',
         'COMMERCIAL INVOICE', 202459, '2026-04-21', '2026-05-12'),

        (gen_random_uuid()::text, 'legacy', 8,
         'purchasing_services', 'V260421-C1', '174234',
         'Purchasing Services', 30369, '2026-04-21', '2026-05-12'),

        (gen_random_uuid()::text, 'legacy', 9,
         'shipping_cost', 'V260421-S1', '174234',
         'Shipping cost', 69950, '2026-04-21', '2026-05-12')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS china_finance_bill`);
    await queryRunner.query(`DROP TABLE IF EXISTS china_wire_transfer`);
    await queryRunner.query(`DROP TABLE IF EXISTS china_finance_settings`);
  }
}
