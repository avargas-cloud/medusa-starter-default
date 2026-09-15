import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Frescura del feed (2026-09-15): el hub mostraba "Last synced" = cuándo le preguntamos a
 * Plaid, no cuándo Plaid bajó datos del BANCO. Con webhook vivo la diferencia es de horas:
 * el 15/09 a las 4:41 AM el poll de Chase "sincronizó" con datos que Plaid había tomado el
 * 14/09 a las 10:36 AM, y el operador vio como pending un wire que Chase ya tenía posteado.
 * `provider_last_update_at` guarda `item.status.transactions.last_successful_update`, que
 * `syncBank` ya leía para cerrar refreshes y descartaba.
 *
 * Expand-only: columna nullable; ningún lector la exige.
 */
export class BankingProviderLastUpdate20260915120000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE bank_connection ADD COLUMN IF NOT EXISTS provider_last_update_at timestamptz NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE bank_connection DROP COLUMN IF EXISTS provider_last_update_at`
    );
  }
}
