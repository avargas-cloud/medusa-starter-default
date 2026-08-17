import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Order Commissions — asignación por MONTO FIJO además de por porcentaje.
 *
 * Hasta acá `percent_bps` era la única verdad guardada y el monto se derivaba
 * en vivo (`base × bps`). Eso hace imposible un monto exacto: un bp sobre una
 * base de $29.018,23 vale $2,90, así que $500 tipeados volvían como $499,11.
 *
 * Cada beneficiario recuerda ahora CÓMO se cargó:
 *
 *   amount_mode = 'percent' → manda `percent_bps`. El monto se deriva y SIGUE a
 *                             la orden mientras la fila esté en draft/eligible
 *                             (una devolución la achica sola, §2.3).
 *   amount_mode = 'fixed'   → manda `fixed_amount_cents`. El monto queda clavado
 *                             al centavo pase lo que pase con la base, y
 *                             `percent_bps` guarda el % al que equivalía AL
 *                             ASIGNAR — testigo histórico, no la verdad viva
 *                             (el % efectivo se deriva de la base vigente).
 *
 * Aditiva y sin backfill: el DEFAULT deja a las filas existentes en 'percent'
 * con su `percent_bps` intacto, que es exactamente su comportamiento previo.
 *
 * `chk_ocr_percent` (percent_bps > 0) se REEMPLAZA porque ya no vale para las
 * filas fijas: un monto chico sobre una base grande redondea a 0 bps ($0,50
 * sobre $29.018 = 0,17 bps) y el CHECK viejo rechazaría una asignación legítima.
 */
export class AddCommissionAmountMode1782900000000 implements MigrationInterface {
  name = "AddCommissionAmountMode1782900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE order_commission_recipient
        ADD COLUMN IF NOT EXISTS amount_mode text NOT NULL DEFAULT 'percent',
        ADD COLUMN IF NOT EXISTS fixed_amount_cents bigint NULL
    `);

    await queryRunner.query(`
      ALTER TABLE order_commission_recipient
        DROP CONSTRAINT IF EXISTS chk_ocr_amount_mode_value
    `);
    await queryRunner.query(`
      ALTER TABLE order_commission_recipient
        ADD CONSTRAINT chk_ocr_amount_mode_value
        CHECK (amount_mode IN ('percent', 'fixed'))
    `);

    // El invariante por modo reemplaza al viejo chk_ocr_percent: cada modo
    // exige SU campo poblado y prohíbe el del otro, así que no puede existir
    // una fila cuya verdad sea ambigua.
    await queryRunner.query(`
      ALTER TABLE order_commission_recipient
        DROP CONSTRAINT IF EXISTS chk_ocr_percent
    `);
    await queryRunner.query(`
      ALTER TABLE order_commission_recipient
        DROP CONSTRAINT IF EXISTS chk_ocr_amount_by_mode
    `);
    await queryRunner.query(`
      ALTER TABLE order_commission_recipient
        ADD CONSTRAINT chk_ocr_amount_by_mode
        CHECK (
          (amount_mode = 'percent'
             AND percent_bps > 0
             AND fixed_amount_cents IS NULL)
          OR
          (amount_mode = 'fixed'
             AND fixed_amount_cents > 0
             AND percent_bps >= 0)
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE order_commission_recipient
        DROP CONSTRAINT IF EXISTS chk_ocr_amount_by_mode
    `);
    await queryRunner.query(`
      ALTER TABLE order_commission_recipient
        DROP CONSTRAINT IF EXISTS chk_ocr_amount_mode_value
    `);
    // Las filas fijas quedarían fuera del CHECK viejo (percent_bps puede ser 0),
    // así que se restaura sólo si ninguna sobrevive al drop de las columnas.
    await queryRunner.query(`
      UPDATE order_commission_recipient
         SET percent_bps = GREATEST(percent_bps, 1)
       WHERE amount_mode = 'fixed'
    `);
    await queryRunner.query(`
      ALTER TABLE order_commission_recipient
        DROP COLUMN IF EXISTS fixed_amount_cents,
        DROP COLUMN IF EXISTS amount_mode
    `);
    await queryRunner.query(`
      ALTER TABLE order_commission_recipient
        ADD CONSTRAINT chk_ocr_percent CHECK (percent_bps > 0)
    `);
  }
}
