import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Baseline manual de revenue por mes — el puente hacia antes del POS.
 *
 * El sistema arrancó en abril de 2026, así que el gráfico anual dibuja
 * enero, febrero y marzo en cero. Eso no dice "no vendimos": dice "todavía
 * no existía el POS", y desde el gráfico las dos cosas son indistinguibles.
 * Abril tiene el mismo problema a medias — le faltan los días previos al
 * arranque.
 *
 * Esta tabla guarda un DELTA por mes que se SUMA a lo que el POS facturó.
 * Para enero-marzo el delta es el total entero (no hay nada debajo); para
 * abril es sólo el pedazo que falta. La misma mecánica cubre los dos casos,
 * y por eso es una suma y no un override: un override obligaría a re-tipear
 * abril entero y a mantenerlo si el mes cambiara.
 *
 * `month` es UNIQUE porque un mes con dos ajustes vivos es una suma que
 * nadie puede auditar — la ruta hace upsert contra esa clave. El monto va
 * en CENTAVOS, como el resto de las columnas de dinero del POS
 * (`pos_invoice.total`, `customer_payment.amount`); guardarlo en dólares
 * acá sería la única excepción del esquema y la trampa para el próximo
 * lector.
 *
 * `updated_by_user_id` no es opcional: es un número tipeado a mano que entra
 * en un reporte de ventas, así que tiene que poder responderse quién lo puso
 * y cuándo sin ir a buscar a un log. La escritura además exige PIN de
 * supervisor en la ruta.
 *
 * Alcance deliberado: SÓLO lo lee el tab Annual. El `Gross Revenue` del
 * Dashboard es el que se concilia contra QuickBooks — si este ajuste se
 * filtrara ahí, se rompería la única cifra cruzable contra el ledger.
 */
export class CreateMonthlyRevenueBaseline1783100000000 implements MigrationInterface {
  name = "CreateMonthlyRevenueBaseline1783100000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS pos_monthly_revenue_baseline (
        id                 TEXT PRIMARY KEY,
        month              TEXT        NOT NULL,
        amount_cents       BIGINT      NOT NULL,
        note               TEXT        NULL,
        updated_by_user_id TEXT        NOT NULL,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT pos_mrb_month_format CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
        CONSTRAINT pos_mrb_amount_nonzero CHECK (amount_cents <> 0)
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_mrb_month
        ON pos_monthly_revenue_baseline (month)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS pos_monthly_revenue_baseline`);
  }
}
