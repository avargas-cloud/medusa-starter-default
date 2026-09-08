import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * pos_monthly_payroll — costo de nómina por MES, cargado a mano por un admin
 * completo con PIN de supervisor, para la sección Expense del Profit & Loss.
 *
 * Existe porque los salarios no pasan por el POS (no hay bill ni documento) y
 * sin ellos el P&L sobreestima la utilidad. Misma forma que
 * `pos_monthly_revenue_baseline` (2026-08-28): una fila por mes, `month`
 * UNIQUE porque un mes con dos entradas vivas es una suma que nadie pidió, y
 * el monto en centavos ENTEROS — un `Math.round` amable guardaría $43,21 como
 * $0,43 y dibujaría una línea plausible cien veces chica.
 *
 * `amount_cents > 0`: cero significa BORRAR el mes (la ruta lo traduce a un
 * DELETE), y una nómina negativa no existe.
 *
 * Nunca viaja a QuickBooks: allá la nómina entra por payroll, no por el POS.
 * Reconocimiento bisemanal (mitad el día 15, mitad el último día del mes):
 * `api/admin/reports/_lib/monthly-payroll.ts`.
 */
export class CreateMonthlyPayroll1788900000000 implements MigrationInterface {
  name = "CreateMonthlyPayroll1788900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS pos_monthly_payroll (
        id                 TEXT PRIMARY KEY,
        month              TEXT        NOT NULL,
        amount_cents       BIGINT      NOT NULL,
        note               TEXT        NULL,
        updated_by_user_id TEXT        NOT NULL,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT pos_mpay_month_format CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
        CONSTRAINT pos_mpay_amount_positive CHECK (amount_cents > 0)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_mpay_month
        ON pos_monthly_payroll (month)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS pos_monthly_payroll`);
  }
}
