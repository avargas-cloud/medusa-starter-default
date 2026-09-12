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
export class GlTransferFee20260912010000 implements MigrationInterface {
  name = "GlTransferFee20260912010000";

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
