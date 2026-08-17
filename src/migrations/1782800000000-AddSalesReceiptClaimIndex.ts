import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Índice único parcial: a lo sumo UNA fila de `sales_receipt` viva por
 * (order_id, reference_id).
 *
 * `processSalesReceiptInQb` (order-flow-core.ts) llamaba al bridge ANTES de
 * escribir su fila de pipeline — la fila nacía recién en el callback
 * `onSubmitted`, DESPUÉS de que el bridge ya aceptó el `SalesReceiptAdd`. Sin
 * fila previa no había nada contra qué chequear un in-flight, así que un
 * corte de red entre el submit y la confirmación (el disparador real: un
 * corte de internet de oficina) dejaba a nuestro sistema sin saber si el
 * documento ya existía en QB. El reintento volvía a emitir el ADD y
 * minteaba un segundo Sales Receipt real. Incidente: INV-21474/INV-21475/
 * INV-21476, 2026-08-17 (5 recibos para 3 órdenes, sanado a mano en QB por
 * el operador + repointeo manual de los 2 punteros de pipeline).
 *
 * Igual que `write_check` (migración 1782100000000): el `id` de la fila
 * reclamada es el token de generación del `Idempotency-Key`
 * (`sales-receipt:<rowId>`), y la garantía dura es este índice, no el
 * código — dos requests concurrentes entran los dos al INSERT/claim y
 * Postgres deja pasar exactamente uno.
 *
 * Scope por (order_id, reference_id) y NO solo order_id: una orden puede
 * re-facturarse legítimamente bajo un número de invoice nuevo (otro
 * `reference_id`, el viejo doc voideado en QB) — visto en producción
 * (order_01KX6GSVXX30ZPVMM1CVTE0HMD, INV-21049 voided → INV-21051 vigente,
 * 2026-07-10). Scopear solo por order_id habría bloqueado ese caso legítimo.
 *
 * `failed` y `skipped` quedan fuera del índice a propósito, mismo criterio
 * que write_check: un ADD que QuickBooks/el bridge rechazó no creó nada
 * (reintento legítimo, reusa la fila) y una fila `skipped` es un intento
 * abandonado a propósito (no debe bloquear un intento nuevo).
 *
 * VERIFICADO CONTRA PRODUCCIÓN (2026-08-17): 2 violaciones preexistentes
 * encontradas y resueltas ANTES de esta migración —
 * order_01KX6GSVXX30ZPVMM1CVTE0HMD resultó ser el caso de re-invoice
 * legítimo de arriba (no tocado); order_01KT528ZECKVJSF8B5P3XP3XHK tenía 2
 * filas de 2026-06-02 con el MISMO qb_txn_id (raza de escritura vieja, sin
 * documento QB duplicado) — la fila redundante (sin medusa_ref_number) se
 * marcó `skipped`. Índice queda limpio, 0 filas restantes en violación.
 */
export class AddSalesReceiptClaimIndex1782800000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_qb_pipeline_sales_receipt_live
        ON qb_order_pipeline (order_id, reference_id)
       WHERE step = 'sales_receipt'
         AND status NOT IN ('failed', 'skipped')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Sólo un índice: el DROP no pierde ningún dato.
    await queryRunner.query(
      `DROP INDEX IF EXISTS uq_qb_pipeline_sales_receipt_live`
    );
  }
}
