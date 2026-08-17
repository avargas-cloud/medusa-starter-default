import { getDbPool } from "../../../api/utils/db-pool";

/**
 * Reclama el derecho a emitir UN `SalesReceiptAdd` para una orden/invoice,
 * ANTES de tocar el bridge.
 *
 * Por qué existe: un `SalesReceiptAdd` no es idempotente — cada llamada
 * mintea un documento REAL en QuickBooks. El flujo anterior
 * (`processSalesReceiptInQb`) llamaba al bridge y recién escribía su fila
 * de pipeline en el callback `onSubmitted`, DESPUÉS de que el bridge ya
 * aceptó el ADD. Un corte de red entre el submit y la confirmación dejaba
 * al sistema sin saber si el documento ya existía, y el reintento volvía a
 * emitirlo — INV-21474/21475/21476, 2026-08-17. El claim invierte el
 * orden: primero se gana la fila, después se emite.
 *
 * La atomicidad la da el índice `uq_qb_pipeline_sales_receipt_live`
 * (migración 1782800000000, scopeado por `order_id, reference_id` — NO
 * solo `order_id`, porque una orden puede re-facturarse legítimamente bajo
 * un `reference_id` nuevo), no este código.
 *
 * El `rowId` que devuelve es TAMBIÉN el token de generación del
 * `Idempotency-Key` (`sales-receipt:<rowId>`):
 *
 *   - Un reintento tras un ADD fallado o ambiguo REUSA la fila `failed`
 *     (mismo id ⇒ misma key), así que si el bridge llegó a crear el
 *     documento pero no pudimos confirmarlo, el bridge dedupea y no se
 *     emite un segundo Sales Receipt.
 *   - Una fila `confirmed` nunca se reusa: una re-invoice legítima (nuevo
 *     `reference_id`) obtiene fila y key nuevas.
 */
export type SalesReceiptClaim =
  | { ok: true; rowId: string; reused: boolean }
  | { ok: false; reason: "in_flight" };

export async function claimSalesReceiptAttempt(input: {
  orderId: string;
  referenceId: string;
  medusaRefNumber?: string | null;
  payload: Record<string, unknown>;
}): Promise<SalesReceiptClaim> {
  const pool = getDbPool();
  const payloadJson = JSON.stringify(input.payload);

  // 1. Reintento del MISMO intento: reusar la fila `failed`. Conserva el id
  //    (⇒ la idempotency key) y limpia el estado del fallo anterior.
  const { rows: reused } = await pool.query(
    `UPDATE qb_order_pipeline
        SET status        = 'processing',
            updated_at    = NOW(),
            error         = NULL,
            failed_at     = NULL,
            bridge_op_id  = NULL,
            qb_result     = NULL,
            next_retry_at = NULL,
            payload       = $4::jsonb,
            medusa_ref_number = COALESCE($3, medusa_ref_number),
            retry_count   = COALESCE(retry_count, 0) + 1
      WHERE id = (
        SELECT id FROM qb_order_pipeline
         WHERE step = 'sales_receipt'
           AND order_id = $1
           AND reference_id = $2
           AND status = 'failed'
         ORDER BY COALESCE(updated_at, created_at) DESC
         LIMIT 1
      )
      RETURNING id`,
    [input.orderId, input.referenceId, input.medusaRefNumber ?? null, payloadJson]
  );
  if (reused.length > 0) {
    return { ok: true, rowId: reused[0].id as string, reused: true };
  }

  // 2. Intento nuevo. El índice parcial decide bajo concurrencia: si ya hay
  //    una fila viva (pending/processing/submitted/confirmed) para este
  //    (order_id, reference_id), el INSERT no entra.
  const { rows: inserted } = await pool.query(
    `INSERT INTO qb_order_pipeline
       (order_id, reference_id, reference_type, step, status, medusa_ref_number, payload)
     VALUES ($1, $2, 'pos_invoice', 'sales_receipt', 'processing', $3, $4::jsonb)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [input.orderId, input.referenceId, input.medusaRefNumber ?? null, payloadJson]
  );
  if (inserted.length > 0) {
    return { ok: true, rowId: inserted[0].id as string, reused: false };
  }

  return { ok: false, reason: "in_flight" };
}

/**
 * Libera un claim cuyo ADD nunca llegó a QuickBooks (el bridge tiró error o
 * no devolvió `operationId`). Deja la fila `failed` (con backoff, a
 * diferencia de write_check: este ADD lo dispara un evento automático del
 * sistema, no una persona desde la pantalla, así que sí queremos reintento
 * automático) — el índice parcial NO cubre `failed`, así que el próximo
 * intento reusa esta misma fila, conservando la idempotency key.
 */
export async function releaseSalesReceiptClaim(
  rowId: string,
  error: string
): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `UPDATE qb_order_pipeline
        SET status        = 'failed',
            error         = $2,
            failed_at     = NOW(),
            updated_at    = NOW(),
            next_retry_at = NOW() + INTERVAL '2 minutes'
      WHERE id = $1`,
    [rowId, error]
  );
}

/**
 * Estampa el `bridge_op_id` en la fila reclamada apenas el bridge acepta el
 * ADD — ANTES de pollear la confirmación, para que un crash del server a
 * mitad del poll deje algo que el próximo tick pueda re-pollear en vez de
 * re-despachar.
 */
export async function markSalesReceiptSubmitted(
  rowId: string,
  bridgeOpId: string
): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `UPDATE qb_order_pipeline
        SET status       = 'submitted',
            bridge_op_id = $2,
            submitted_at = NOW(),
            updated_at   = NOW()
      WHERE id = $1`,
    [rowId, bridgeOpId]
  );
}

/**
 * Confirma la fila reclamada con el TxnID/RefNumber reales una vez que el
 * poll del bridge los devuelve.
 */
export async function confirmSalesReceiptRow(
  rowId: string,
  result: { txnId: string; refNumber?: string | null; bridgeOpId?: string | null }
): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `UPDATE qb_order_pipeline
        SET status        = 'confirmed',
            qb_txn_id     = $2,
            qb_ref_number = $3,
            bridge_op_id  = COALESCE($4, bridge_op_id),
            confirmed_at  = NOW(),
            updated_at    = NOW()
      WHERE id = $1`,
    [rowId, result.txnId, result.refNumber ?? null, result.bridgeOpId ?? null]
  );
}
