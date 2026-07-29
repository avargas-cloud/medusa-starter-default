/**
 * src/jobs/qb-void-reconciler.ts
 *
 * Red de seguridad para la carrera void-before-create.
 *
 * `pipeline/void-intent.ts` materializa el void en el confirm del ADD, y ese es
 * el camino normal. Pero entre "el ADD confirmó en QuickBooks" y "el hook
 * corrió" hay una ventana: si el proceso muere ahí, o si el hook falla, o si un
 * camino de confirmación futuro se olvida de llamarlo, el documento queda vivo
 * y abierto en QB sin que nada avise. Eso es exactamente lo que pasó con la POS
 * Invoice 21246 / QB 19637 — sólo que ahí la causa fue un camino sin cobertura,
 * y el resultado se descubrió mirando QuickBooks a mano seis horas después.
 *
 * Este job es la misma query con la que se midió el blast radius de aquel
 * incidente, generalizada a los seis tipos de documento y corriendo sola:
 *
 *     documento voideado + su ADD confirmado + ninguna fila de void viva
 *
 * ── READ-ONLY a propósito ─────────────────────────────────────────────────────
 * Reporta; NO encola. La primera corrida contra producción explicó por qué:
 * denunció a CM-1090 (QB 18984), y ese credit memo YA estaba voideado en
 * QuickBooks — `TotalAmount 0.00`, memo `VOID: POS Return CM-1090`. Lo que le
 * falta no es el void: le falta la fila de pipeline que lo registre. La DB sola
 * no puede distinguir "nunca se voideó en QB" de "se voideó por fuera del
 * pipeline", así que auto-encolar habría mandado un void contra un documento ya
 * voideado, sobre una premisa no verificada.
 *
 * Confirmarlo exige leer QuickBooks, y una lectura por candidato dentro de un
 * cron serializa el bridge — que es un recurso compartido y lento. El camino
 * rápido y correcto ya existe: el hook del confirm (`void-intent.ts`), que actúa
 * en el único momento en que el estado es inequívoco. Esto es la red para lo que
 * se le escape, y lo que se le escapa merece que lo mire una persona.
 *
 * Es la misma decisión que ya tomó `qb-drift-detector` para la familia de
 * compras: empezar read-only y recién después decidir si el auto-repair es
 * seguro.
 */

import { MedusaContainer } from "@medusajs/framework/types";

import { getDbPool } from "../api/utils/db-pool";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";

const TAG = "[qb-void-reconciler]";

/**
 * Ventana hacia atrás. Los huérfanos históricos anteriores a esto ya fueron
 * resueltos a mano y volver a barrerlos cada 15 min no aporta — pero un
 * documento que quedó huérfano hoy entra de sobra.
 */
const LOOKBACK_DAYS = 30;

/**
 * Un ADD recién confirmado todavía puede estar siendo procesado por el hook del
 * confirm. Esperar un poco evita que el job y el hook encolen el mismo void al
 * mismo tiempo — el índice único lo atajaría igual, pero con ruido de conflicto.
 */
const SETTLE_MINUTES = 5;

interface OrphanRow {
  create_step: string;
  reference_id: string | null;
  order_id: string | null;
  qb_txn_id: string;
  qb_ref_number: string | null;
  medusa_ref_number: string | null;
}

export default async function qbVoidReconciler(container: MedusaContainer) {
  if (isScheduledJobsDisabled(container)) return;

  const logger = container.resolve("logger") as {
    warn: (m: string) => void;
    info: (m: string) => void;
  };
  const pool = getDbPool();

  try {
    // Un solo barrido con UNION: cada rama define cómo se sabe que ESE tipo de
    // documento está voideado, y todas exigen lo mismo — ADD confirmado con
    // TxnID y ninguna fila de void para la misma clave.
    const { rows } = await pool.query<OrphanRow>(
      `
      -- invoice / sales receipt → pos_invoice.status
      SELECT p.step AS create_step, p.reference_id, p.order_id,
             p.qb_txn_id, p.qb_ref_number, p.medusa_ref_number
        FROM qb_order_pipeline p
        JOIN pos_invoice d ON d.id = p.reference_id
       WHERE p.step IN ('invoice', 'sales_receipt')
         AND p.status = 'confirmed'
         AND p.qb_txn_id IS NOT NULL
         AND d.status = 'voided'
         AND p.confirmed_at > NOW() - ($1 || ' days')::interval
         AND p.confirmed_at < NOW() - ($2 || ' minutes')::interval
         AND NOT EXISTS (
               SELECT 1 FROM qb_order_pipeline v
                WHERE v.reference_id = p.reference_id
                  AND v.step IN ('void_invoice', 'void_sales_receipt')
                  AND v.status <> 'skipped'
             )

      UNION ALL

      -- credit memo → pos_credit_memo.status
      SELECT p.step, p.reference_id, p.order_id,
             p.qb_txn_id, p.qb_ref_number, p.medusa_ref_number
        FROM qb_order_pipeline p
        JOIN pos_credit_memo d ON d.id = p.reference_id
       WHERE p.step = 'credit_memo'
         AND p.status = 'confirmed'
         AND p.qb_txn_id IS NOT NULL
         AND (d.status = 'voided' OR d.voided_at IS NOT NULL)
         AND p.confirmed_at > NOW() - ($1 || ' days')::interval
         AND p.confirmed_at < NOW() - ($2 || ' minutes')::interval
         AND NOT EXISTS (
               SELECT 1 FROM qb_order_pipeline v
                WHERE v.reference_id = p.reference_id
                  AND v.step = 'void_credit_memo'
                  AND v.status <> 'skipped'
             )

      UNION ALL

      -- sales order / estimate → la orden (o el draft) cancelada.
      -- Se keyean por order_id: su reference_id es NULL.
      SELECT p.step, p.reference_id, p.order_id,
             p.qb_txn_id, p.qb_ref_number, p.medusa_ref_number
        FROM qb_order_pipeline p
        JOIN "order" o ON o.id = p.order_id
       WHERE p.step IN ('sales_order', 'estimate')
         AND p.status = 'confirmed'
         AND p.qb_txn_id IS NOT NULL
         AND p.reference_id IS NULL
         AND o.status = 'canceled'
         AND p.confirmed_at > NOW() - ($1 || ' days')::interval
         AND p.confirmed_at < NOW() - ($2 || ' minutes')::interval
         AND NOT EXISTS (
               SELECT 1 FROM qb_order_pipeline v
                WHERE v.order_id = p.order_id
                  AND v.reference_id IS NULL
                  AND v.step IN ('void_sales_order', 'void_estimate',
                                 'estimate_deactivate', 'estimate_cancel')
                  AND v.status <> 'skipped'
             )

      UNION ALL

      -- inventory adjustment → inventory_count.voided_at.
      -- Su create lleva el id del conteo en order_id (asimetría conocida).
      SELECT p.step, p.reference_id, p.order_id,
             p.qb_txn_id, p.qb_ref_number, p.medusa_ref_number
        FROM qb_order_pipeline p
        JOIN inventory_count d ON d.id = COALESCE(p.reference_id, p.order_id)
       WHERE p.step = 'inventory_adjustment'
         AND p.status = 'confirmed'
         AND p.qb_txn_id IS NOT NULL
         AND d.voided_at IS NOT NULL
         AND p.confirmed_at > NOW() - ($1 || ' days')::interval
         AND p.confirmed_at < NOW() - ($2 || ' minutes')::interval
         AND NOT EXISTS (
               SELECT 1 FROM qb_order_pipeline v
                WHERE v.reference_id = COALESCE(p.reference_id, p.order_id)
                  AND v.step = 'void_inventory_adjustment'
                  AND v.status <> 'skipped'
             )
      `,
      [String(LOOKBACK_DAYS), String(SETTLE_MINUTES)]
    );

    if (rows.length === 0) return;

    // Que este job encuentre algo significa que el hook del confirm no lo
    // cubrió: es una señal sobre el CÓDIGO, no sólo sobre los datos. Por eso el
    // mensaje nombra los documentos — para que se puedan verificar contra QB
    // uno por uno (`/qb-trace`) antes de decidir nada.
    const sample = rows
      .slice(0, 10)
      .map(
        (r) =>
          `${r.create_step}:${r.medusa_ref_number ?? r.qb_ref_number ?? r.qb_txn_id}` +
          ` (txn ${r.qb_txn_id})`
      )
      .join(", ");
    logger.warn(
      `${TAG} ${rows.length} documento(s) voideado(s) en Medusa sin fila de void en el pipeline. ` +
        `NO se encoló nada: hay que verificar en QuickBooks si el documento sigue vivo ` +
        `(puede haberse voideado a mano, por fuera del pipeline). ` +
        `${sample}${rows.length > 10 ? " …" : ""}`
    );
  } catch (err) {
    logger.warn(
      `${TAG} barrido falló: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export const config = {
  name: "qb-void-reconciler",
  schedule: "*/15 * * * *",
};
