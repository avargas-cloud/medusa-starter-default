import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Lado VENTAS de `Migration20260911000000-QbBackfillLinkIndexes` — índices
 * PARCIALES sobre las columnas de enlace TxnID de QB del plan
 * `qb-sales-backfill-20260911`, para que dos filas nunca apunten al mismo
 * documento de QB.
 *
 * `pos_credit_memo.qb_txn_id` y `pos_invoice.metadata->>'qb_txn_id'`: sin
 * duplicados en el sandbox al momento de escribir esta migración (barrido
 * `GROUP BY … HAVING count(*)>1` antes de escribir el índice) → ÚNICOS.
 *
 * `customer_payment.metadata->>'qb_txn_id'` SÍ tiene duplicados hoy: el
 * valor `SYNCED_VIA_RECEIPT` (marcador de "este pago se sincronizó como
 * parte de un sales receipt, no tiene TxnID propio de ReceivePayment") se
 * repite en 3 filas — no es un TxnID real, es un sentinel de otro writer.
 * Expand-only: `CREATE UNIQUE INDEX IF NOT EXISTS` fallaría (23505) contra
 * ese sentinel, así que ese índice va NO-ÚNICO (sólo acelera el lookup por
 * TxnID; la unicidad real de un `qb_txn_id` genuino la sigue garantizando
 * el resto del pipeline).
 */
export class QbSalesBackfillLinkIndexes20260912000000 implements MigrationInterface {
  name = "QbSalesBackfillLinkIndexes20260912000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_pos_credit_memo_qb_txn_id_active
        ON pos_credit_memo (qb_txn_id)
        WHERE qb_txn_id IS NOT NULL AND deleted_at IS NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_pos_invoice_qb_txn_id_active
        ON pos_invoice ((metadata->>'qb_txn_id'))
        WHERE metadata->>'qb_txn_id' IS NOT NULL AND deleted_at IS NULL
    `);
    // NO-ÚNICO: ver nota de arriba (sentinel 'SYNCED_VIA_RECEIPT' duplicado en sandbox, medido 2026-09-11).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_customer_payment_qb_txn_id_active
        ON customer_payment ((metadata->>'qb_txn_id'))
        WHERE metadata->>'qb_txn_id' IS NOT NULL AND deleted_at IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uniq_pos_credit_memo_qb_txn_id_active`);
    await queryRunner.query(`DROP INDEX IF EXISTS uniq_pos_invoice_qb_txn_id_active`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_customer_payment_qb_txn_id_active`);
  }
}
