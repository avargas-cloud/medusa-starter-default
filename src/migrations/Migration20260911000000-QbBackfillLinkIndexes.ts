import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Índices únicos PARCIALES sobre las columnas de enlace TxnID de QB, para el
 * plan `qb-docs-backfill-compras-20260911`. Sin esto, dos filas del backfill
 * (o una del backfill y una creada por otra vía) podrían apuntar al mismo
 * documento de QB sin que la base lo impida — el mismo agujero que
 * `uniq_vendor_bill_qb_txn_id_active` ya cierra para `vendor_bill`.
 *
 * Expand-only: `CREATE UNIQUE INDEX IF NOT EXISTS`, sin tocar filas
 * existentes. Si hoy YA hay un TxnID duplicado en alguna de estas tablas, la
 * migración FALLA ruidosamente (23505) en vez de crear un índice que después
 * nadie sabría que está roto — es la señal, no un bug de la migración.
 *
 * `WHERE ... IS NOT NULL AND deleted_at IS NULL`, igual que el índice de
 * vendor_bill: una fila soft-deleted no bloquea la reutilización del TxnID.
 */
export class QbBackfillLinkIndexes20260911000000 implements MigrationInterface {
  name = "QbBackfillLinkIndexes20260911000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_purchase_order_qb_txn_id_active
        ON purchase_order (qb_purchase_order_list_id)
        WHERE qb_purchase_order_list_id IS NOT NULL AND deleted_at IS NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_po_receipt_qb_txn_id_active
        ON purchase_order_receipt (qb_item_receipt_list_id)
        WHERE qb_item_receipt_list_id IS NOT NULL AND deleted_at IS NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_vendor_credit_qb_txn_id_active
        ON vendor_credit (qb_txn_id)
        WHERE qb_txn_id IS NOT NULL AND deleted_at IS NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_vendor_bill_payment_qb_txn_id_active
        ON vendor_bill_payment (qb_txn_id)
        WHERE qb_txn_id IS NOT NULL AND deleted_at IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uniq_purchase_order_qb_txn_id_active`);
    await queryRunner.query(`DROP INDEX IF EXISTS uniq_po_receipt_qb_txn_id_active`);
    await queryRunner.query(`DROP INDEX IF EXISTS uniq_vendor_credit_qb_txn_id_active`);
    await queryRunner.query(`DROP INDEX IF EXISTS uniq_vendor_bill_payment_qb_txn_id_active`);
  }
}
