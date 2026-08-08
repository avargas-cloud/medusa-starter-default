/**
 * Barrido de huérfanos de void: documento voideado en Medusa + ADD confirmado
 * con TxnID + ninguna fila de void viva en el pipeline. Es la red para lo que
 * se le escape a `pipeline/void-intent.ts` (el hook del confirm).
 *
 * La query vive UNA sola vez acá y la comparten el job `qb-void-reconciler`
 * (barrido cada 15 min → warning en logs) y la sección del digest diario
 * (`jobs/_lib/_qb-void-orphan-section.ts` → email). Cuando eran capas
 * distintas con listas propias ya divergieron una vez: el reconciler cubría
 * cinco tipos de documento y a `payment` no lo miraba nadie — así el pago
 * 3420 quedó vivo en QB sin que ninguna red lo denunciara.
 *
 * READ-ONLY a propósito: reporta, NO encola. La DB sola no puede distinguir
 * "nunca se voideó en QB" de "se voideó por fuera del pipeline" (CM-1090
 * estaba voideado a mano y auto-encolar habría re-voideado sobre una premisa
 * no verificada). Cada hallazgo se verifica con /qb-trace antes de decidir.
 */

import { getDbPool } from "../../../api/utils/db-pool";

/**
 * Ventana hacia atrás. Los huérfanos históricos anteriores a esto ya fueron
 * resueltos a mano y volver a barrerlos no aporta — pero un documento que
 * quedó huérfano hoy entra de sobra.
 */
export const VOID_ORPHAN_LOOKBACK_DAYS = 30;

/**
 * Un ADD recién confirmado todavía puede estar siendo procesado por el hook
 * del confirm. Esperar un poco evita que el barrido y el hook denuncien/
 * encolen lo mismo al mismo tiempo.
 */
export const VOID_ORPHAN_SETTLE_MINUTES = 5;

export interface VoidOrphanRow {
  create_step: string;
  reference_id: string | null;
  order_id: string | null;
  qb_txn_id: string;
  qb_ref_number: string | null;
  medusa_ref_number: string | null;
  confirmed_at: string | Date;
}

export async function scanVoidOrphans(): Promise<VoidOrphanRow[]> {
  const pool = getDbPool();
  // Un solo barrido con UNION: cada rama define cómo se sabe que ESE tipo de
  // documento está voideado, y todas exigen lo mismo — ADD confirmado con
  // TxnID y ninguna fila de void para la misma clave.
  const { rows } = await pool.query<VoidOrphanRow>(
    `
    -- invoice / sales receipt → pos_invoice.status
    SELECT p.step AS create_step, p.reference_id, p.order_id,
           p.qb_txn_id, p.qb_ref_number, p.medusa_ref_number, p.confirmed_at
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
           p.qb_txn_id, p.qb_ref_number, p.medusa_ref_number, p.confirmed_at
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
           p.qb_txn_id, p.qb_ref_number, p.medusa_ref_number, p.confirmed_at
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
           p.qb_txn_id, p.qb_ref_number, p.medusa_ref_number, p.confirmed_at
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

    UNION ALL

    -- payment → customer_payment.status. La señal es la COLUMNA, nunca
    -- metadata.qb_sync_status: esa clave la escriben también los caminos de
    -- confirm del ADD (el inline la estampaba synced y así se perdió el
    -- void del pago 3420). qb_void_operation_id prueba que el TxnDel sí
    -- salió; un pago embebido en un Sales Receipt no tiene ReceivePayment
    -- propio que borrar (se voidea el SR).
    SELECT p.step, p.reference_id, p.order_id,
           p.qb_txn_id, p.qb_ref_number, p.medusa_ref_number, p.confirmed_at
      FROM qb_order_pipeline p
      JOIN customer_payment d ON d.id = p.reference_id
     WHERE p.step = 'payment'
       AND p.status = 'confirmed'
       AND p.qb_txn_id IS NOT NULL
       AND d.status = 'voided'
       AND d.metadata->>'qb_void_operation_id' IS NULL
       AND COALESCE(d.metadata->>'qb_source', '') <> 'sales_receipt'
       AND p.confirmed_at > NOW() - ($1 || ' days')::interval
       AND p.confirmed_at < NOW() - ($2 || ' minutes')::interval
       AND NOT EXISTS (
             SELECT 1 FROM qb_order_pipeline v
              WHERE v.reference_id = p.reference_id
                AND v.step = 'void_payment'
                AND v.status <> 'skipped'
           )
    `,
    [String(VOID_ORPHAN_LOOKBACK_DAYS), String(VOID_ORPHAN_SETTLE_MINUTES)]
  );
  return rows;
}
