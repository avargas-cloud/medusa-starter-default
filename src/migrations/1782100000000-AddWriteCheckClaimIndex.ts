import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Índice único parcial: a lo sumo UNA fila de `write_check` viva por refund.
 *
 * `POST /admin/finance/qb-refunds/sync` emitía el `CheckAdd` al bridge ANTES de
 * escribir su fila de pipeline, y su único anti-duplicado era un SELECT sobre esa
 * fila que todavía no existía. Dos ventanas quedaban abiertas:
 *
 *   1. Dos requests concurrentes leen "no hay fila" y los dos emiten un CheckAdd.
 *   2. El bridge acepta el ADD pero la respuesta se pierde (timeout, restart) antes
 *      de que se escriba la fila; el reintento vuelve a emitirlo.
 *
 * Un CheckAdd NO es idempotente: cada uno mintea un cheque REAL en QuickBooks, o
 * sea plata que sale dos veces. El SELECT previo se queda (da un 409 explicativo
 * en el caso esperado); esto es la garantía dura debajo, y el `id` de la fila
 * reclamada es además el token de generación del `Idempotency-Key`.
 *
 * `failed` y `skipped` quedan FUERA del índice a propósito:
 *
 *   - `failed`  → un ADD que QuickBooks rechazó no creó nada; el reintento es
 *                 legítimo y REUSA esa misma fila (mismo id ⇒ misma idempotency
 *                 key, así que un fallo ambiguo no puede duplicar).
 *   - `skipped` → `skipOpenRefundPipelineRows` marca así las filas al revertir un
 *                 refund cuyo cheque nunca llegó a confirmar. Un refund posterior
 *                 sobre el mismo pago tiene que poder emitirse.
 *
 * `confirmed` SÍ entra: hoy `skipOpenRefundPipelineRows` sólo toca filas
 * `pending/waiting/failed`, así que una fila confirmada sobrevive a un revert y el
 * guard 1a de la ruta ya devuelve 409 en ese caso. Incluirla no saca ninguna
 * capacidad existente — la respalda.
 *
 * VERIFICADO CONTRA PRODUCCIÓN (2026-07-31): 34 filas `write_check`, todas
 * `confirmed`, una sola por `reference_id`, ninguna con `reference_id` NULL → el
 * índice se crea limpio. Si una sesión concurrente mintease un duplicado antes del
 * deploy, el predeploy de Railway FALLA y el deploy no entra: falla segura, nunca
 * corrupción silenciosa.
 */
export class AddWriteCheckClaimIndex1782100000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_qb_pipeline_write_check_live
        ON qb_order_pipeline (reference_id)
       WHERE step = 'write_check'
         AND reference_id IS NOT NULL
         AND status NOT IN ('failed', 'skipped')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Sólo un índice: el DROP no pierde ningún dato.
    await queryRunner.query(
      `DROP INDEX IF EXISTS uq_qb_pipeline_write_check_live`
    );
  }
}
