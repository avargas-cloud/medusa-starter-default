import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Índices únicos parciales: a lo sumo UNA fila de void viva por documento.
 *
 * Los caminos que materializan un void (`pipeline/void-intent.ts`, el
 * reconciliador `jobs/qb-void-reconciler.ts`, y los handlers de void) hacen
 * SELECT-y-después-INSERT. Bajo concurrencia — el consolidator confirmando un
 * ADD mientras el reconciliador barre — esa secuencia puede mintear DOS filas de
 * void para el mismo documento. Un void duplicado no es cosmético: el segundo
 * llega a QuickBooks contra un documento que ya está voideado y muere con 3200
 * o, peor, toca un documento equivocado si el TxnID se resolvió distinto.
 *
 * El SELECT previo se queda igual (evita el ruido de un conflicto esperado);
 * esto es la garantía dura debajo.
 *
 * DOS índices porque el pipeline no es uniforme en su clave:
 *
 *   - invoice / sales receipt / credit memo / inventory adjustment se keyean
 *     por `reference_id`.
 *   - sales order y estimate viven con `reference_id` NULL y se keyean por
 *     `order_id` (37 y 6 filas respectivamente hoy, todas con reference_id NULL).
 *
 * Es el mismo patrón que `uq_qb_pipeline_apply_payment_papp`, incluido el
 * `status <> 'skipped'`: una fila descartada no debe impedir un void legítimo
 * posterior.
 *
 * VERIFICADO CONTRA PRODUCCIÓN (2026-07-29): cero grupos duplicados en las dos
 * claves, así que los índices se crean limpios. Si una sesión concurrente
 * mintease un duplicado antes del deploy, el predeploy de Railway FALLA y el
 * deploy no entra — falla segura, nunca corrupción silenciosa.
 */
export class AddVoidDedupIndexes1781400000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
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

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_qb_pipeline_void_by_order
        ON qb_order_pipeline (order_id, step)
       WHERE step IN (
               'void_sales_order',
               'void_estimate',
               'estimate_deactivate',
               'estimate_cancel'
             )
         AND reference_id IS NULL
         AND order_id IS NOT NULL
         AND status <> 'skipped'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Sólo índices: el DROP no pierde ningún dato.
    await queryRunner.query(
      `DROP INDEX IF EXISTS uq_qb_pipeline_void_by_order`
    );
    await queryRunner.query(`DROP INDEX IF EXISTS uq_qb_pipeline_void_by_ref`);
  }
}
