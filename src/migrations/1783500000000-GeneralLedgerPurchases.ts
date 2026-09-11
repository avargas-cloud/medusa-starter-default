import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * gl-purchases-v2 §5 — expand-only. La ÚNICA pieza de schema que este plan
 * necesita: ensanchar el CHECK de `bank_journal_entry.source_kind` (nombre
 * confirmado contra `medusa_gl`: `bank_journal_entry_source_kind_check`,
 * ver `GeneralLedgerCore.ts`) para los 4 kinds nuevos. `gl_account_map` no
 * necesita DDL — su `key` es `text` libre (`^[a-z][a-z0-9_]{0,63}$`), así
 * que `accounts_payable`/`inventory_offset` son filas de DATOS a sembrar por
 * ops (fuera de este plan: `inventory_offset` en particular no tiene un
 * ListID de QB real todavía — ver `types.ts`), no una migración.
 */
export class GeneralLedgerPurchases1783500000000 implements MigrationInterface {
  name = "GeneralLedgerPurchases1783500000000";

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
    await queryRunner.query(`
      ALTER TABLE bank_journal_entry
        DROP CONSTRAINT IF EXISTS bank_journal_entry_source_kind_check
    `);
    await queryRunner.query(`
      ALTER TABLE bank_journal_entry
        ADD CONSTRAINT bank_journal_entry_source_kind_check
        CHECK (source_kind IN (
          'pos_invoice','pos_credit_memo','customer_payment','rounding_adjustment',
          'po_receipt','vendor_bill','vendor_credit','vendor_bill_payment'
        ))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE bank_journal_entry
        DROP CONSTRAINT IF EXISTS bank_journal_entry_source_kind_check
    `);
    await queryRunner.query(`
      ALTER TABLE bank_journal_entry
        ADD CONSTRAINT bank_journal_entry_source_kind_check
        CHECK (source_kind IN (
          'pos_invoice','pos_credit_memo','customer_payment','rounding_adjustment'
        ))
    `);
  }
}
