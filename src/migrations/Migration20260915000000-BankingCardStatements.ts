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
 *   `lib/banking/statement-match-sql.ts`.
 * - `bank_statement_journal_guard`: una línea de tarjeta fechada en un mes ya cerrado
 *   también se rechaza (cargos, pagos de bills con tarjeta, importaciones tardías).
 *
 * Sólo CUERPOS de función, con `CREATE OR REPLACE` y SIN tocar los triggers: la primera
 * versión hacía `DROP TRIGGER … ON bank_journal_line` (ACCESS EXCLUSIVE sobre una tabla
 * que el pipeline de QB y los hooks del GL escriben cada minuto) y el predeploy de Railway
 * murió con `deadlock detected` (2026-09-14 21:53Z, deploy 670576b5). Reemplazar el cuerpo
 * sólo bloquea el objeto función, no la tabla, y el trigger existente lo llama por nombre.
 * Expand-only: ni tablas ni columnas.
 */
export class BankingCardStatements20260915000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(functionBodiesOnly(statementMatchSql));
    await queryRunner.query(functionBodiesOnly(statementJournalGuardSql));
  }

  public async down(): Promise<void> {
    throw new Error("Banking statement trigger history requires reviewed rollback.");
  }
}

/** `CREATE FUNCTION` → `CREATE OR REPLACE FUNCTION`; drops every `CREATE [CONSTRAINT] TRIGGER …;` (they already exist). */
export function functionBodiesOnly(sql: string): string {
  return sql
    .replace(/CREATE (?:CONSTRAINT )?TRIGGER[^;]*;/g, "")
    .replace(/CREATE FUNCTION/g, "CREATE OR REPLACE FUNCTION");
}
