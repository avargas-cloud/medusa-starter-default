import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * pay-bills-credits-prepayments-20260917 — consumo por línea de cheque de
 * anticipo (Fase 1).
 *
 * El patrón histórico de QB (contador): un cheque/wire a un vendor con una
 * línea contra su cuenta de anticipo (`qb_account.account_type =
 * 'OtherCurrentAsset'`, hoy "VEETECH Co., Ltd" 80000152-1621454214) financia
 * bills futuros; el pago real es un `VendorCredit` con línea `qb_account`
 * contra esa misma cuenta (Dr AP / Cr anticipo), aplicado al bill. Esta
 * tabla es el registro de CUÁNTO de cada línea de cheque ya se consumió —
 * por settlement nuevo (`source='settlement'`, `src/lib/bill-settlements`)
 * o por lo que QB ya tenía posteado antes de este trabajo (`qb_backfill`,
 * sembrado abajo). `vendor_credit_id` UNIQUE: un crédito de prepago consume
 * exactamente una línea, y viceversa no hace falta forzarlo aquí — la
 * capacidad la valida el orquestador bajo lock.
 *
 * El seed es IDEMPOTENTE (`ON CONFLICT (id) DO NOTHING`, id determinístico
 * por línea) para poder re-correr la migración sin duplicar consumo.
 *
 * Verificado contra sandbox: `gl_check.payee_id` guarda `qb_vendor.id`
 * directo (no el ListID) — el join de abajo es por `payee_id`, no por
 * `qb_vendor.qb_list_id`.
 */
export class VendorPrepaymentConsumption20260917210000 implements MigrationInterface {
  name = "VendorPrepaymentConsumption20260917210000";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`SET LOCAL lock_timeout = '15s'`);
    await q.query(`
      CREATE TABLE IF NOT EXISTS vendor_prepayment_consumption (
        id text PRIMARY KEY,
        gl_check_id text NOT NULL REFERENCES gl_check(id),
        gl_check_line_id text NOT NULL REFERENCES gl_check_line(id),
        vendor_id text NOT NULL,
        vendor_credit_id text NULL UNIQUE REFERENCES vendor_credit(id),
        consumed_cents bigint NOT NULL CHECK (consumed_cents > 0),
        source text NOT NULL CHECK (source IN ('settlement','qb_backfill')),
        created_by text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        voided_at timestamptz NULL
      )
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_vpc_line ON vendor_prepayment_consumption(gl_check_line_id)
        WHERE voided_at IS NULL
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_vpc_vendor ON vendor_prepayment_consumption(vendor_id)
        WHERE voided_at IS NULL
    `);

    // Seed: for every vendor with at least one QB-backfilled posted vendor
    // credit, every posted check/expense line against that vendor's
    // OtherCurrentAsset account, dated on or before the latest backfilled
    // credit, counts as already consumed for its full amount — QB already
    // has the VendorCredit that spent it, this repo just never recorded it.
    await q.query(`
      INSERT INTO vendor_prepayment_consumption
        (id, gl_check_id, gl_check_line_id, vendor_id, consumed_cents, source, created_by)
      SELECT
        'vpc_' || md5(l.id),
        c.id,
        l.id,
        c.payee_id,
        l.amount_cents,
        'qb_backfill',
        'migration:VendorPrepaymentConsumption'
      FROM gl_check c
      JOIN gl_check_line l ON l.check_id = c.id
      JOIN qb_account a ON a.qb_list_id = l.account_list_id AND a.account_type = 'OtherCurrentAsset'
      JOIN (
        SELECT vendor_id, MAX(credit_date) AS max_credit_date
          FROM vendor_credit
         WHERE memo LIKE '[qb_backfill%'
         GROUP BY vendor_id
      ) backfilled ON backfilled.vendor_id = c.payee_id
      WHERE c.status = 'posted'
        AND c.deleted_at IS NULL
        AND c.payee_type = 'vendor'
        AND c.day <= backfilled.max_credit_date
      ON CONFLICT (id) DO NOTHING
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS vendor_prepayment_consumption`);
  }
}
