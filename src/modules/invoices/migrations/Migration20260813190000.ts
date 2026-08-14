import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * `pos_rounding_adjustment` — cómo se saldó el residuo de centavos que deja una
 * orden facturada en partes (el tax se redondea una vez POR FACTURA, así que
 * `Σ round(baseᵢ × tasa) ≠ round(Σ baseᵢ × tasa)`).
 *
 * Aditiva: no reescribe ni una fila existente. Sin las env vars de las cuentas
 * de QuickBooks nadie escribe acá y el sistema se comporta igual que antes.
 *
 * Los tres invariantes viven en la DB y no sólo en el código, porque son la
 * última línea entre un bug y un asiento contable equivocado.
 */
export class Migration20260813190000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS pos_rounding_adjustment (
        id                text        NOT NULL PRIMARY KEY,
        invoice_id        text        NULL,
        payment_id        text        NULL,
        order_id          text        NULL,
        amount_cents      integer     NOT NULL,
        direction         text        NOT NULL,
        account_list_id   text        NOT NULL,
        reason_code       text        NOT NULL,
        memo              text        NULL,
        actor             text        NULL,
        qb_status         text        NOT NULL DEFAULT 'pending',
        qb_op_id          text        NULL,
        qb_error          text        NULL,
        voided_at         timestamptz NULL,
        void_reason       text        NULL,
        voided_by         text        NULL,
        metadata          jsonb       NULL,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        deleted_at        timestamptz NULL
      );
    `);

    // (1) Exactamente UN objetivo. Con los dos, o con ninguno, el lector tendría
    // que adivinar a qué documento pertenece el ajuste.
    this.addSql(`
      ALTER TABLE pos_rounding_adjustment
      ADD CONSTRAINT pos_rounding_adjustment_one_target_check
      CHECK ((invoice_id IS NOT NULL) <> (payment_id IS NOT NULL));
    `);

    // (2) La dirección y el objetivo tienen que concordar: un shortage cierra
    // una FACTURA (pide más de lo que entró), un overage consume un PAGO (entró
    // más de lo que las facturas piden). Cruzarlos postea a la cuenta opuesta.
    this.addSql(`
      ALTER TABLE pos_rounding_adjustment
      ADD CONSTRAINT pos_rounding_adjustment_direction_target_check
      CHECK (
        (direction = 'shortage' AND invoice_id IS NOT NULL) OR
        (direction = 'overage'  AND payment_id IS NOT NULL)
      );
    `);

    // (3) Guarda de CATÁSTROFE, no la política.
    //
    // El tope operativo real son 5¢ y vive en `ROUNDING_WRITE_OFF_CAP_CENTS`
    // (lib/rounding/write-off.ts), donde se puede ajustar sin migración. Este
    // techo de $1.00 es dos órdenes de magnitud más alto a propósito: no está
    // para hacer cumplir la política sino para que ningún bug de código pueda
    // jamás escribir acá el total de una factura. Si los dos números
    // divergieran, el que manda es el del código; este sólo impide el desastre.
    this.addSql(`
      ALTER TABLE pos_rounding_adjustment
      ADD CONSTRAINT pos_rounding_adjustment_sane_amount_check
      CHECK (amount_cents > 0 AND amount_cents <= 100);
    `);

    // Idempotencia: un documento no puede tener dos ajustes VIVOS. Parcial, para
    // que anular uno (voided_at) permita emitir el reemplazo sin borrar la
    // huella del anterior.
    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS pos_rounding_adjustment_live_invoice_uniq
      ON pos_rounding_adjustment (invoice_id)
      WHERE invoice_id IS NOT NULL AND voided_at IS NULL AND deleted_at IS NULL;
    `);
    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS pos_rounding_adjustment_live_payment_uniq
      ON pos_rounding_adjustment (payment_id)
      WHERE payment_id IS NOT NULL AND voided_at IS NULL AND deleted_at IS NULL;
    `);

    // Lectura por orden (reporte "cuánto absorbimos por redondeo") y barrido del
    // digest por estado de QuickBooks.
    this.addSql(`
      CREATE INDEX IF NOT EXISTS pos_rounding_adjustment_order_idx
      ON pos_rounding_adjustment (order_id) WHERE deleted_at IS NULL;
    `);
    this.addSql(`
      CREATE INDEX IF NOT EXISTS pos_rounding_adjustment_qb_status_idx
      ON pos_rounding_adjustment (qb_status) WHERE deleted_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS pos_rounding_adjustment;`);
  }
}
