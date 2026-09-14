import { MigrationInterface, QueryRunner } from "typeorm";

import { statementMatchSql } from "../lib/banking/statement-match-sql";

/**
 * Casamiento NETO en los extractos (2026-09-14): una línea del banco puede explicarse con
 * asientos de ambos signos — la procesadora de tarjetas deposita las ventas del día MENOS
 * los reembolsos, y QuickBooks los tenía como depósitos y cheques separados. Antes el
 * trigger `bank_statement_match_capacity` exigía el mismo signo y `bank_statement_check_close`
 * sumaba lo casado sin signo, así que ningún mes con reembolsos podía cerrar.
 *
 * Reinstala las DOS funciones desde `lib/banking/statement-match-sql.ts` (misma fuente que el
 * arnés del sandbox). Sólo funciones: ni tablas ni columnas (expand-only).
 */
export class BankingStatementNetMatch20260914000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS bank_statement_match_capacity ON bank_statement_match`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS bank_statement_close_valid ON bank_statement`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS bank_statement_match_capacity()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS bank_statement_check_close()`);
    await queryRunner.query(statementMatchSql);
  }

  public async down(): Promise<void> {
    throw new Error("Banking statement trigger history requires reviewed rollback.");
  }
}
