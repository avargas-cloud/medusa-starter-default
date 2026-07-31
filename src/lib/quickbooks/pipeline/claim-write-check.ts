import { getDbPool } from "../../../api/utils/db-pool";

/**
 * Reclama el derecho a emitir UN `CheckAdd` para un refund, ANTES de tocar el bridge.
 *
 * Por qué existe: `CheckAdd` no es idempotente — cada llamada mintea un cheque REAL
 * en QuickBooks. La ruta de sync llamaba al bridge y recién después escribía su fila
 * de pipeline, así que su guard (un SELECT sobre esa fila) no cubría ni dos requests
 * concurrentes ni un reintento tras una respuesta perdida. El claim invierte el orden:
 * primero se gana la fila, después se emite.
 *
 * La atomicidad la da el índice `uq_qb_pipeline_write_check_live`
 * (migración 1782100000000), no este código: dos requests simultáneos entran los dos
 * al INSERT y Postgres deja pasar exactamente uno.
 *
 * El `rowId` que devuelve es TAMBIÉN el token de generación del `Idempotency-Key`:
 *
 *   - Un reintento tras un ADD fallado REUSA la fila `failed` (mismo id ⇒ misma key),
 *     así que si el fallo fue ambiguo —el bridge llegó a crear el cheque pero no
 *     pudimos verlo— el bridge dedupea y no se emite un segundo cheque.
 *   - Un cheque `confirmed` no se puede reusar nunca: cualquier emisión futura
 *     legítima (post-revert) necesita una fila nueva y por lo tanto una key nueva,
 *     que es justo lo que evita que el bridge se trague un cheque legítimo.
 *
 * Una key fija por pago (`write-check:<cpay_id>`) no sirve: el día que alguien
 * habilite re-emitir tras un revert, el bridge se comería el segundo cheque en
 * silencio — plata faltante e invisible, que es peor que un duplicado visible.
 */
export type WriteCheckClaim =
  | { ok: true; rowId: string; reused: boolean }
  | { ok: false; reason: "in_flight" };

export async function claimWriteCheckAttempt(input: {
  referenceId: string;
  medusaRefNumber: string;
  payload: Record<string, unknown>;
}): Promise<WriteCheckClaim> {
  const pool = getDbPool();
  const payloadJson = JSON.stringify(input.payload);

  // 1. Reintento del MISMO intento: reusar la fila `failed`. Conserva el id (⇒ la
  //    idempotency key) y limpia el estado del fallo anterior. `retry_count` se
  //    incrementa para que la fila cuente su historia como cualquier otra.
  const { rows: reused } = await pool.query(
    `UPDATE qb_order_pipeline
        SET status        = 'processing',
            updated_at    = NOW(),
            error         = NULL,
            failed_at     = NULL,
            bridge_op_id  = NULL,
            qb_result     = NULL,
            next_retry_at = NULL,
            payload       = $3::jsonb,
            medusa_ref_number = COALESCE($2, medusa_ref_number),
            retry_count   = retry_count + 1
      WHERE id = (
        SELECT id FROM qb_order_pipeline
         WHERE step = 'write_check'
           AND reference_id = $1
           AND status = 'failed'
         ORDER BY COALESCE(updated_at, created_at) DESC
         LIMIT 1
      )
      RETURNING id`,
    [input.referenceId, input.medusaRefNumber, payloadJson]
  );
  if (reused.length > 0) {
    return { ok: true, rowId: reused[0].id as string, reused: true };
  }

  // 2. Intento nuevo. El índice parcial es quien decide bajo concurrencia: si ya
  //    hay una fila viva (pending/processing/submitted/waiting/confirmed) el
  //    INSERT no entra y no se devuelve ninguna fila.
  const { rows: inserted } = await pool.query(
    `INSERT INTO qb_order_pipeline
       (reference_id, reference_type, step, status, medusa_ref_number, payload)
     VALUES ($1, 'customer_payment', 'write_check', 'processing', $2, $3::jsonb)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [input.referenceId, input.medusaRefNumber, payloadJson]
  );
  if (inserted.length > 0) {
    return { ok: true, rowId: inserted[0].id as string, reused: false };
  }

  return { ok: false, reason: "in_flight" };
}

/**
 * Libera un claim cuyo ADD nunca llegó a QuickBooks (el bridge tiró error o no
 * devolvió `operation_id`). Deja la fila `failed`, que el índice parcial NO cubre,
 * así el operador puede reintentar — y ese reintento reusará esta misma fila,
 * conservando la idempotency key.
 *
 * No se usa `failPipelineRow` porque acá no queremos backoff ni presupuesto de
 * reintentos automáticos: este step lo dispara una persona desde la pantalla.
 */
export async function releaseWriteCheckClaim(
  rowId: string,
  error: string
): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `UPDATE qb_order_pipeline
        SET status = 'failed', error = $2, failed_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [rowId, error.slice(0, 500)]
  );
}

/** Key 1:1 con el cheque que este intento va a crear. Ver el docstring de arriba. */
export function writeCheckIdempotencyKey(rowId: string): string {
  return `write-check:${rowId}`;
}
