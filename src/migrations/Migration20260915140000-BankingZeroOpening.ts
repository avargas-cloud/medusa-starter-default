import { MigrationInterface, QueryRunner } from "typeorm";

import { statementMatchSql } from "../lib/banking/statement-match-sql";
import { functionBodiesOnly } from "./Migration20260915000000-BankingCardStatements";

/**
 * Apertura de CERO (2026-09-15): una cuenta que no existía o estaba en $0 al corte contable
 * no tiene documento `opening_balance` (el GL rechaza un asiento de $0), así que
 * `bank_statement.opening_id` no tiene a qué apuntar. El extracto se ancla en el corte del
 * setup con saldo 0 y `opening_id` NULL — `statement-opening.ts` decide cuándo eso es
 * legítimo (ningún asiento vivo sobre la cuenta hasta el corte). Caso: Visa Chase 7914,
 * tarjeta nueva en mayo de 2026.
 *
 * `bank_statement_check_close` (el guard de cierre en Postgres) aprende la misma regla que el
 * resolver: sin OBE → corte del setup y saldo 0, si el libro no tiene asientos hasta el corte;
 * y exige `opening_id` = el OBE (o NULL cuando no hay). Sólo cuerpo de función (`OR REPLACE`),
 * sin tocar triggers — ver la migración 20260915000000 por el deadlock del DROP TRIGGER.
 *
 * Expand-only: sólo suelta el NOT NULL; la FK (NOT VALID) sigue y ningún lector exige el valor.
 */
export class BankingZeroOpening20260915140000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE bank_statement ALTER COLUMN opening_id DROP NOT NULL`);
    await queryRunner.query(functionBodiesOnly(statementMatchSql));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Sólo si no quedó ningún extracto anclado en cero; si los hay, la reversa no aplica.
    await queryRunner.query(`ALTER TABLE bank_statement ALTER COLUMN opening_id SET NOT NULL`);
  }
}
