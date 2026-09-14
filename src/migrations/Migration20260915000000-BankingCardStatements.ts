import { MigrationInterface, QueryRunner } from "typeorm";

import { statementJournalGuardSql } from "../lib/banking/statement-guard-sql";
import { statementMatchSql } from "../lib/banking/statement-match-sql";

/**
 * Extractos de TARJETA (2026-09-14): el motor de conciliación aceptaba sólo cuentas
 * QuickBooks `Bank`; Amex 5009 y las Visas 7704/2084 son `CreditCard` y quedaban afuera.
 * Todo sigue en signo GL (un pasivo tiene saldo negativo; un cargo es una línea
 * negativa, un pago positiva), así que las tres funciones cambian UN filtro cada una:
 * `account_type='Bank'` → `IN ('Bank','CreditCard')`.
 *
 * - `bank_statement_match_capacity` / `bank_statement_check_close`: desde
 *   `lib/banking/statement-match-sql.ts` (mismo patrón que BankingStatementNetMatch).
 * - `bank_statement_journal_guard`: una línea de tarjeta fechada en un mes ya cerrado
 *   también se rechaza (cargos, pagos de bills con tarjeta, importaciones tardías).
 *   Reinstala SÓLO esa función: `statementGuardSql` entero crearía de nuevo los otros
 *   guards que ya existen (`statementJournalGuardSql` es el extracto dedicado).
 *
 * Sólo funciones/triggers: ni tablas ni columnas (expand-only).
 */
export class BankingCardStatements20260915000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS bank_statement_match_capacity ON bank_statement_match`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS bank_statement_close_valid ON bank_statement`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS bank_statement_journal_guard ON bank_journal_line`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS bank_statement_match_capacity()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS bank_statement_check_close()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS bank_statement_journal_guard()`);
    await queryRunner.query(statementMatchSql);
    await queryRunner.query(statementJournalGuardSql);
  }

  public async down(): Promise<void> {
    throw new Error("Banking statement trigger history requires reviewed rollback.");
  }
}
