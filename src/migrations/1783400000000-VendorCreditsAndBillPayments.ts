import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * gl-purchases-v2 §3 (docs/GL_PURCHASES_PLAN.md) — vendor credits + pay bills.
 *
 * Five tables, expand-only, no FK to any table this migration does not own
 * except `vendor_bill(id)` (read-only reference — never mutated here) and
 * `qb_account` / `qb_vendor` (identity is a snapshotted ListID, same pattern
 * as `vendor_bill.vendor_qb_list_id_snapshot`: no FK, because QB identity is
 * asserted at dispatch time, not at row-creation time — see
 * `vendor-bill-vendor-identity.ts`).
 *
 * Money is bigint cents throughout. `number` sequences mirror
 * `custom_vendor_bill_seq` (Migration20260428240000): `VC-####` / `BP-####`
 * starting at 1001.
 *
 * Also seeds the 2 new `gl_account_map` keys this plan introduces
 * (`accounts_payable`, `inventory_offset`) by `full_name`, same insert-only
 * pattern as `1783300000000-GeneralLedgerCore.ts` — a key with no resolvable
 * account is simply not inserted; the account-map screen shows it in red.
 */
export class VendorCreditsAndBillPayments1783400000000
  implements MigrationInterface
{
  name = "VendorCreditsAndBillPayments1783400000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Guard (2026-09-10): el journal del GL ES el de Banking. En producción el módulo
    // Banking sólo se registra con BANKING_ENABLED=true, y sin registro sus migraciones
    // nunca crean bank_journal_entry. Fallar ACÁ, ruidoso y antes de tocar nada, deja el
    // predeploy de Railway en rojo con el build viejo ACTIVE — mejor que un GL a medias.
    const guardRows = (await queryRunner.query(
      `SELECT to_regclass('public.bank_journal_entry') IS NOT NULL AS present`
    )) as Array<{ present: boolean }>;
    if (!guardRows[0]?.present) {
      throw new Error(
        "GeneralLedger migration: falta bank_journal_entry. Registrá el módulo Banking " +
          "(BANKING_ENABLED=true) para que sus migraciones corran ANTES (medusa db:migrate " +
          "precede a run-custom-migrations.js), y re-desplegá."
      );
    }
    // ── vendor_credit ──
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS vendor_credit (
        id                          text PRIMARY KEY,
        number                      text NULL,
        vendor_id                   text NOT NULL,
        vendor_name_snapshot        text NULL,
        vendor_qb_list_id_snapshot  text NULL,
        credit_date                 date NOT NULL,
        reason                      text NULL,
        memo                        text NULL,
        status                      text NOT NULL DEFAULT 'draft',
        total_cents                 bigint NOT NULL DEFAULT 0,
        applied_cents               bigint NOT NULL DEFAULT 0,
        qb_txn_id                   text NULL,
        qb_edit_sequence            text NULL,
        qb_synced_at                timestamptz NULL,
        posted_at                   timestamptz NULL,
        posted_by                   text NULL,
        voided_at                   timestamptz NULL,
        voided_by                   text NULL,
        voided_reason               text NULL,
        created_at                  timestamptz NOT NULL DEFAULT now(),
        updated_at                  timestamptz NOT NULL DEFAULT now(),
        deleted_at                  timestamptz NULL,
        CONSTRAINT chk_vendor_credit_status
          CHECK (status IN ('draft','posted','voided')),
        CONSTRAINT chk_vendor_credit_total CHECK (total_cents >= 0),
        CONSTRAINT chk_vendor_credit_applied CHECK (applied_cents >= 0)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_vendor_credit_vendor ON vendor_credit (vendor_id) WHERE deleted_at IS NULL`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_vendor_credit_status ON vendor_credit (status) WHERE deleted_at IS NULL`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_vendor_credit_date ON vendor_credit (credit_date) WHERE deleted_at IS NULL`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_vendor_credit_qb_txn ON vendor_credit (qb_txn_id) WHERE qb_txn_id IS NOT NULL`
    );

    // ── vendor_credit_line ──
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS vendor_credit_line (
        id                   text PRIMARY KEY,
        credit_id            text NOT NULL REFERENCES vendor_credit(id),
        sort                 integer NOT NULL DEFAULT 0,
        line_type            text NOT NULL,
        variant_id           text NULL,
        sku                  text NULL,
        description          text NULL,
        qty                  integer NULL,
        unit_cost_cents      bigint NULL,
        qb_account_list_id   text NULL,
        qb_account_full_name text NULL,
        qb_account_type      text NULL,
        amount_cents         bigint NOT NULL,
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_at           timestamptz NOT NULL DEFAULT now(),
        deleted_at           timestamptz NULL,
        CONSTRAINT chk_vcl_line_type CHECK (line_type IN ('product','qb_account')),
        CONSTRAINT chk_vcl_amount CHECK (amount_cents > 0)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_vendor_credit_line_credit ON vendor_credit_line (credit_id) WHERE deleted_at IS NULL`
    );

    // ── vendor_credit_application ──
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS vendor_credit_application (
        id              text PRIMARY KEY,
        credit_id       text NOT NULL REFERENCES vendor_credit(id),
        vendor_bill_id  text NOT NULL REFERENCES vendor_bill(id),
        amount_cents    bigint NOT NULL,
        applied_at      timestamptz NOT NULL DEFAULT now(),
        applied_by      text NULL,
        voided_at       timestamptz NULL,
        voided_by       text NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_vca_amount CHECK (amount_cents > 0)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_vca_credit ON vendor_credit_application (credit_id) WHERE voided_at IS NULL`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_vca_bill ON vendor_credit_application (vendor_bill_id) WHERE voided_at IS NULL`
    );

    // ── vendor_bill_payment ──
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS vendor_bill_payment (
        id                        text PRIMARY KEY,
        number                    text NULL,
        vendor_id                 text NOT NULL,
        vendor_name_snapshot      text NULL,
        vendor_qb_list_id_snapshot text NULL,
        bank_account_list_id      text NOT NULL,
        bank_account_snapshot     jsonb NULL,
        payment_date              date NOT NULL,
        method                    text NOT NULL,
        reference                 text NULL,
        amount_cents              bigint NOT NULL,
        memo                      text NULL,
        status                    text NOT NULL DEFAULT 'posted',
        qb_txn_id                 text NULL,
        qb_edit_sequence          text NULL,
        qb_synced_at              timestamptz NULL,
        posted_at                 timestamptz NOT NULL DEFAULT now(),
        posted_by                 text NULL,
        voided_at                 timestamptz NULL,
        voided_by                 text NULL,
        voided_reason             text NULL,
        created_at                timestamptz NOT NULL DEFAULT now(),
        updated_at                timestamptz NOT NULL DEFAULT now(),
        deleted_at                timestamptz NULL,
        CONSTRAINT chk_vbp_status CHECK (status IN ('posted','voided')),
        CONSTRAINT chk_vbp_method CHECK (method IN ('check','ach','wire','card','cash')),
        CONSTRAINT chk_vbp_amount CHECK (amount_cents >= 0)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_vendor_bill_payment_vendor ON vendor_bill_payment (vendor_id) WHERE deleted_at IS NULL`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_vendor_bill_payment_status ON vendor_bill_payment (status) WHERE deleted_at IS NULL`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_vendor_bill_payment_date ON vendor_bill_payment (payment_date) WHERE deleted_at IS NULL`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_vendor_bill_payment_qb_txn ON vendor_bill_payment (qb_txn_id) WHERE qb_txn_id IS NOT NULL`
    );

    // ── vendor_bill_payment_allocation ──
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS vendor_bill_payment_allocation (
        id                    text PRIMARY KEY,
        payment_id            text NOT NULL REFERENCES vendor_bill_payment(id),
        vendor_bill_id        text NOT NULL REFERENCES vendor_bill(id),
        amount_cents          bigint NOT NULL,
        credit_application_id text NULL REFERENCES vendor_credit_application(id),
        created_at            timestamptz NOT NULL DEFAULT now(),
        updated_at            timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_vbpa_amount CHECK (amount_cents > 0)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_vbpa_payment ON vendor_bill_payment_allocation (payment_id)`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_vbpa_bill ON vendor_bill_payment_allocation (vendor_bill_id)`
    );

    // ── number sequences (mirrors custom_vendor_bill_seq, Migration20260428240000) ──
    await queryRunner.query(
      `CREATE SEQUENCE IF NOT EXISTS custom_vendor_credit_seq START 1001;`
    );
    await queryRunner.query(
      `CREATE SEQUENCE IF NOT EXISTS custom_bill_payment_seq START 1001;`
    );

    // ── gl_account_map: 2 new keys for this plan, seeded by full_name.
    // Insert-only if the qb_account exists, is active, and matches the
    // allowed type — same shape as 1783300000000's seed loop. ──
    const seeds: Array<{
      key: string;
      value: string;
      allowedTypes: string[];
      label: string;
    }> = [
      {
        key: "accounts_payable",
        value: "Accounts Payable",
        allowedTypes: ["AccountsPayable"],
        label: "Accounts Payable",
      },
      {
        key: "inventory_offset",
        value: "Inventory Offset Account",
        allowedTypes: ["OtherCurrentLiability"],
        label: "Inventory Offset Account",
      },
    ];
    for (const seed of seeds) {
      await queryRunner.query(
        `
        INSERT INTO gl_account_map (key, qb_list_id, account_snapshot, allowed_types, label, updated_by)
        SELECT $1, a.qb_list_id,
          jsonb_build_object('id', a.qb_list_id, 'name', a.full_name, 'account_type', a.account_type, 'currency', 'USD'),
          $2::text[], $3, 'migration-1783400000000'
        FROM qb_account a
        WHERE a.full_name = $4 AND a.is_active = true AND a.account_type = ANY($2::text[])
        ORDER BY a.last_synced_at DESC LIMIT 1
        ON CONFLICT (key) DO NOTHING
      `,
        [seed.key, seed.allowedTypes, seed.label, seed.value]
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM gl_account_map WHERE key IN ('accounts_payable','inventory_offset')`
    );
    await queryRunner.query(`DROP SEQUENCE IF EXISTS custom_bill_payment_seq`);
    await queryRunner.query(`DROP SEQUENCE IF EXISTS custom_vendor_credit_seq`);
    await queryRunner.query(
      `DROP TABLE IF EXISTS vendor_bill_payment_allocation`
    );
    await queryRunner.query(`DROP TABLE IF EXISTS vendor_bill_payment`);
    await queryRunner.query(`DROP TABLE IF EXISTS vendor_credit_application`);
    await queryRunner.query(`DROP TABLE IF EXISTS vendor_credit_line`);
    await queryRunner.query(`DROP TABLE IF EXISTS vendor_credit`);
  }
}
