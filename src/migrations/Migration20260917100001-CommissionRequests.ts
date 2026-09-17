import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * commission-requests-20260917: un POS user (cajero, sin Accounting) puede
 * SEÑALAR que una orden lleva comisión y a quién — customer o vendor — sin
 * ver ni decidir montos. La solicitud no tiene %, base ni monto: por eso es
 * una tabla propia y NO un estado más de `order_commission_recipient`, cuya
 * máquina de estados, cap y devengo son de dinero.
 *
 * Accounting la resuelve desde la pestaña Pending de /accounting/commissions:
 *  · approved  → al GUARDAR la asignación (PIN) con esa identidad como
 *                beneficiario; se enlaza `order_commission_id` en la misma tx.
 *  · rejected  → acción explícita con motivo + PIN.
 * Una sola pendiente por identidad+orden (índices parciales).
 */
export class CommissionRequests20260917100001 implements MigrationInterface {
  name = "CommissionRequests20260917100001";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`SET LOCAL lock_timeout = '15s'`);
    await q.query(`
      CREATE TABLE IF NOT EXISTS commission_request (
        id                   text PRIMARY KEY,
        order_id             text NOT NULL,
        customer_id          text NULL,
        qb_vendor_id         text NULL,
        display_name         text NOT NULL,
        note                 text NULL,
        status               text NOT NULL DEFAULT 'pending',
        requested_by         text NULL,
        requested_at         timestamptz NOT NULL DEFAULT NOW(),
        reviewed_by          text NULL,
        reviewed_at          timestamptz NULL,
        review_reason        text NULL,
        order_commission_id  text NULL REFERENCES order_commission(id),
        created_at           timestamptz NOT NULL DEFAULT NOW(),
        updated_at           timestamptz NOT NULL DEFAULT NOW(),
        deleted_at           timestamptz NULL,
        CONSTRAINT chk_creq_status CHECK (status IN ('pending','approved','rejected')),
        CONSTRAINT chk_creq_identity
          CHECK (customer_id IS NOT NULL OR qb_vendor_id IS NOT NULL)
      )
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_creq_order
        ON commission_request (order_id) WHERE deleted_at IS NULL
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_creq_pending
        ON commission_request (requested_at DESC)
        WHERE status = 'pending' AND deleted_at IS NULL
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_creq_pending_customer
        ON commission_request (order_id, customer_id)
        WHERE status = 'pending' AND deleted_at IS NULL AND customer_id IS NOT NULL
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_creq_pending_vendor
        ON commission_request (order_id, qb_vendor_id)
        WHERE status = 'pending' AND deleted_at IS NULL AND qb_vendor_id IS NOT NULL
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS commission_request`);
  }
}
