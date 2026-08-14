import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Order Commissions v1 — docs/ORDER_COMMISSIONS_PLAN.md §6 y §11.
 *
 * Cuatro tablas. Dinero en CENTS, porcentajes en BPS (convención POS).
 * El cap vigente se CONGELA en cada registro al asignar (§2.6): cambiar el
 * setting global no toca comisiones ya asignadas.
 *
 * `commission_settlement` es append-only: el índice parcial `…_live` es el
 * constraint de "un saldo, un camino" (§5.4) — una sola liquidación viva
 * (pending/qb_waiting/confirmed) por beneficiario; failed/reversed liberan.
 */
export class CreateOrderCommissions1782600000000 implements MigrationInterface {
  name = "CreateOrderCommissions1782600000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS order_commission (
        id                   text PRIMARY KEY,
        order_id             text NOT NULL,
        currency_code        text NOT NULL DEFAULT 'usd',
        item_subtotal_cents  bigint NOT NULL,
        discount_cents       bigint NOT NULL DEFAULT 0,
        base_cents           bigint NOT NULL,
        discount_bps         integer NOT NULL DEFAULT 0,
        cap_bps              integer NOT NULL,
        wait_days            integer NOT NULL DEFAULT 30,
        version              integer NOT NULL DEFAULT 1,
        assigned_by          text NULL,
        created_at           timestamptz NOT NULL DEFAULT NOW(),
        updated_at           timestamptz NOT NULL DEFAULT NOW(),
        deleted_at           timestamptz NULL,
        CONSTRAINT chk_order_commission_base CHECK (base_cents >= 0),
        CONSTRAINT chk_order_commission_cap CHECK (cap_bps > 0)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_order_commission_live
        ON order_commission (order_id)
        WHERE deleted_at IS NULL
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS order_commission_recipient (
        id                    text PRIMARY KEY,
        order_commission_id   text NOT NULL REFERENCES order_commission(id),
        customer_id           text NULL,
        qb_vendor_id     text NULL,
        display_name          text NOT NULL,
        percent_bps           integer NOT NULL,
        amount_cents          bigint NULL,
        eligible_at           timestamptz NULL,
        state                 text NOT NULL DEFAULT 'draft',
        payout_method         text NULL,
        assigned_by           text NULL,
        assigned_at           timestamptz NOT NULL DEFAULT NOW(),
        approved_by           text NULL,
        approved_at           timestamptz NULL,
        settled_by            text NULL,
        settled_at            timestamptz NULL,
        void_reason           text NULL,
        created_at            timestamptz NOT NULL DEFAULT NOW(),
        updated_at            timestamptz NOT NULL DEFAULT NOW(),
        deleted_at            timestamptz NULL,
        CONSTRAINT chk_ocr_state
          CHECK (state IN ('draft','eligible','approved','settling','closed','void')),
        CONSTRAINT chk_ocr_payout_method
          CHECK (payout_method IS NULL OR payout_method IN ('vendor_bill','store_credit')),
        CONSTRAINT chk_ocr_percent CHECK (percent_bps > 0),
        CONSTRAINT chk_ocr_identity
          CHECK (customer_id IS NOT NULL OR qb_vendor_id IS NOT NULL)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_ocr_commission
        ON order_commission_recipient (order_commission_id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_ocr_state
        ON order_commission_recipient (state)
        WHERE deleted_at IS NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_ocr_customer_live
        ON order_commission_recipient (order_commission_id, customer_id)
        WHERE deleted_at IS NULL AND customer_id IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_ocr_vendor_live
        ON order_commission_recipient (order_commission_id, qb_vendor_id)
        WHERE deleted_at IS NULL AND qb_vendor_id IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS commission_settlement (
        id                    text PRIMARY KEY,
        recipient_id          text NOT NULL REFERENCES order_commission_recipient(id),
        method                text NOT NULL,
        amount_cents          bigint NOT NULL,
        vendor_bill_id        text NULL,
        customer_payment_id   text NULL,
        qb_check_txn_id       text NULL,
        qb_payment_txn_id     text NULL,
        check_operation_id    text NULL,
        payment_operation_id  text NULL,
        status                text NOT NULL DEFAULT 'pending',
        failure_reason        text NULL,
        idempotency_key       text NOT NULL,
        created_by            text NULL,
        created_at            timestamptz NOT NULL DEFAULT NOW(),
        updated_at            timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_cset_method CHECK (method IN ('vendor_bill','store_credit')),
        CONSTRAINT chk_cset_status
          CHECK (status IN ('pending','qb_waiting','confirmed','failed','reversed')),
        CONSTRAINT chk_cset_amount CHECK (amount_cents > 0),
        CONSTRAINT uq_cset_idempotency UNIQUE (idempotency_key)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_cset_live_per_recipient
        ON commission_settlement (recipient_id)
        WHERE status IN ('pending','qb_waiting','confirmed')
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS customer_vendor_link (
        id                 text PRIMARY KEY,
        customer_id        text NOT NULL,
        qb_vendor_id  text NOT NULL,
        vendor_full_name   text NOT NULL,
        created_by         text NULL,
        created_at         timestamptz NOT NULL DEFAULT NOW(),
        updated_at         timestamptz NOT NULL DEFAULT NOW(),
        deleted_at         timestamptz NULL
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_cvl_customer_live
        ON customer_vendor_link (customer_id)
        WHERE deleted_at IS NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_cvl_vendor_live
        ON customer_vendor_link (qb_vendor_id)
        WHERE deleted_at IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS customer_vendor_link`);
    await queryRunner.query(`DROP TABLE IF EXISTS commission_settlement`);
    await queryRunner.query(`DROP TABLE IF EXISTS order_commission_recipient`);
    await queryRunner.query(`DROP TABLE IF EXISTS order_commission`);
  }
}
