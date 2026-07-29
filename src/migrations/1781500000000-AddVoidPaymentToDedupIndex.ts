import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Suma `void_payment` al índice de dedup de voids.
 *
 * El step nace con el delta v2 (borrado automático de un ReceivePayment cuyo
 * ADD seguía en vuelo al momento del void). Necesita la misma garantía dura que
 * el resto de la familia: dos filas de void para el mismo pago significarían
 * dos TxnDel, y el segundo pega contra un documento que ya no existe.
 *
 * Un índice parcial no se "extiende": hay que recrearlo con el predicado nuevo.
 * Se hace DROP + CREATE en la misma transacción de la migración, así que no hay
 * ventana sin protección.
 *
 * `void_payment` se keyea por `reference_id` (el `customer_payment.id`), igual
 * que invoice / SR / credit memo.
 */
export class AddVoidPaymentToDedupIndex1781500000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_qb_pipeline_void_by_ref`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_qb_pipeline_void_by_ref
        ON qb_order_pipeline (reference_id, step)
       WHERE step IN (
               'void_invoice',
               'void_sales_receipt',
               'void_credit_memo',
               'void_inventory_adjustment',
               'void_payment'
             )
         AND reference_id IS NOT NULL
         AND status <> 'skipped'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_qb_pipeline_void_by_ref`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_qb_pipeline_void_by_ref
        ON qb_order_pipeline (reference_id, step)
       WHERE step IN (
               'void_invoice',
               'void_sales_receipt',
               'void_credit_memo',
               'void_inventory_adjustment'
             )
         AND reference_id IS NOT NULL
         AND status <> 'skipped'
    `);
  }
}
