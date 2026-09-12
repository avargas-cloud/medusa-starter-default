import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Comisión bancaria en una transferencia (`gl_transfer`). Pedido del
 * operador 2026-09-12: "¿no se agrega comisiones o algún gasto que uno pueda
 * perder en una transferencia?".
 *
 * Modelo explícito: `amount_cents` = lo que SALE de `from`; `fee_cents` = lo
 * que cobra el banco; `to` recibe `amount_cents − fee_cents`. El asiento
 * queda Dr to (amount − fee) / Dr gasto (fee) / Cr from (amount).
 *
 * Expand-only: tres columnas NULL-ables con IF NOT EXISTS. Las filas previas
 * quedan sin fee (NULL ≡ 0) y el builder de líneas es quien valida
 * `0 ≤ fee < amount` y que la cuenta del fee sea Expense activa.
 */
export class GlTransferFee1789400000000 implements MigrationInterface {
  name = "GlTransferFee1789400000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE gl_transfer ADD COLUMN IF NOT EXISTS fee_cents bigint NULL`
    );
    await queryRunner.query(
      `ALTER TABLE gl_transfer ADD COLUMN IF NOT EXISTS fee_account_list_id text NULL`
    );
    await queryRunner.query(
      `ALTER TABLE gl_transfer ADD COLUMN IF NOT EXISTS fee_account_snapshot jsonb NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE gl_transfer DROP COLUMN IF EXISTS fee_account_snapshot`
    );
    await queryRunner.query(
      `ALTER TABLE gl_transfer DROP COLUMN IF EXISTS fee_account_list_id`
    );
    await queryRunner.query(
      `ALTER TABLE gl_transfer DROP COLUMN IF EXISTS fee_cents`
    );
  }
}
// Renombrada de Migration20260912010000 el 2026-09-12: TypeORM toma los ÚLTIMOS 13
// caracteres del nombre de la clase como timestamp (`substr(-13)`), así que un sufijo
// de 14 dígitos (20260912010000 → "0260912010000") ordena ANTES de las 1789…000, y
// esta migración corría antes de la que crea `gl_transfer` → el deploy a producción
// falló con "relation gl_transfer does not exist". En sandbox no se vio porque las
// tablas ya existían de una corrida anterior. Los sufijos van con 13 dígitos, siempre.
