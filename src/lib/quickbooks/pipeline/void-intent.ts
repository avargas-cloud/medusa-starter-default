/**
 * Materialización diferida de un void cuyo documento todavía no existía en QB.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────
 * Un void emitido mientras el ADD del documento sigue en vuelo no tiene TxnID
 * que apuntar. Los handlers de void resuelven el TxnID del estado persistido y,
 * al no encontrarlo, retornan sin encolar nada. El evento de void dispara UNA
 * sola vez, así que nadie lo reintenta: el ADD termina, crea el documento en QB
 * y lo deja vivo y huérfano.
 *
 * POS Invoice 21246 / QB 19637 (2026-07-29) es el incidente que lo probó:
 *
 *   15:01:46  se crea el pos_invoice
 *   15:02:27  el usuario hace void      <- todavía no hay TxnID → no-op mudo
 *   15:04:02  QB devuelve el TxnID      <- la invoice nace ya voideada en Medusa
 *
 * QB 19637 quedó con $18.917,94 de balance y el Sales Order 6442 con una línea
 * en `invoiced 2` sobre `ordered 1`.
 *
 * ── El invariante ─────────────────────────────────────────────────────────────
 * El momento en que se conoce el TxnID es el confirm del ADD, y es por lo tanto
 * el único punto de reintento correcto. Este módulo se llama desde TODOS los
 * caminos que confirman un ADD — el asíncrono del consolidator y los seis
 * inline de los handlers — para que la cobertura no dependa de por dónde
 * confirmó el documento. El incidente de arriba ocurrió exactamente porque el
 * guard existía sólo en el camino asíncrono.
 *
 * ── Por qué no `depends_on` ───────────────────────────────────────────────────
 * Encadenar el void al ADD con `depends_on` parece la solución obvia y ya está
 * implementada en dos callsites — pero nace sin `qb_txn_id`, y
 * `runWakeDependentsPass` sólo flipea el status: no copia el TxnID del padre.
 * La hija despierta sin TxnID y muere en `resubmit-by-step` con
 * "missing qb_txn_id — cannot void". Además un padre que termina `skipped` o
 * `failed` no despierta a nadie nunca. Las dos únicas filas de void con
 * `depends_on` que existieron en producción terminaron ambas en `fixed`, o sea
 * que las dos necesitaron mano humana.
 *
 * La intención de void NO necesita estado nuevo: el estado del propio documento
 * (`pos_invoice.status='voided'`, la orden `canceled`, etc.) YA es durable y ya
 * es la fuente de verdad. Este módulo sólo la lee en el momento correcto.
 */
import { getDbPool } from "../../../api/utils/db-pool";

import { writePipelineRow } from "./row-mutations";

/** Los steps de void que este módulo puede materializar. */
export const MATERIALIZABLE_VOID_STEPS = [
  "void_invoice",
  "void_sales_receipt",
  "void_credit_memo",
  "void_sales_order",
  "void_estimate",
  "void_inventory_adjustment",
  "void_cm_damage_adjustment",
  "void_payment",
] as const;

export type MaterializableVoidStep =
  (typeof MATERIALIZABLE_VOID_STEPS)[number];

/**
 * Cómo se decide, para un ADD confirmado, si su documento ya estaba voideado.
 *
 * `resolve` recibe las dos claves posibles porque el pipeline no es uniforme:
 * invoice / SR / credit memo se keyean por `reference_id`, mientras que sales
 * order y estimate viven con `reference_id` NULL y se keyean por `order_id`.
 * Devolver `null` significa "no hay intención de void" — el caso normal.
 */
interface VoidIntentSpec {
  resolve: (keys: {
    referenceId: string | null;
    orderId: string | null;
  }) => Promise<{
    voidStep: MaterializableVoidStep;
    referenceId: string | null;
    referenceType: string | null;
    orderId: string | null;
  } | null>;
}

/** Lee una fila y devuelve la primera, o null. */
async function queryOne(
  sql: string,
  params: unknown[]
): Promise<Record<string, any> | null> {
  const { rows } = await getDbPool().query(sql, params);
  return rows[0] ?? null;
}

/**
 * `pos_invoice` cubre DOS steps de create (invoice y sales_receipt) y sus dos
 * voids. El discriminante es `metadata.is_sales_receipt`, no el step del create:
 * mandar un `void_invoice` a un Sales Receipt falla en QB.
 */
async function resolvePosInvoiceIntent(keys: {
  referenceId: string | null;
  orderId: string | null;
}) {
  if (!keys.referenceId) return null;
  const row = await queryOne(
    `SELECT status, metadata->>'is_sales_receipt' AS is_sr
       FROM pos_invoice WHERE id = $1`,
    [keys.referenceId]
  );
  if (row?.status !== "voided") return null;
  return {
    voidStep: (row.is_sr === "true"
      ? "void_sales_receipt"
      : "void_invoice") as MaterializableVoidStep,
    referenceId: keys.referenceId,
    referenceType: "pos_invoice",
    orderId: keys.orderId,
  };
}

const VOID_INTENT_SPECS: Record<string, VoidIntentSpec> = {
  invoice: { resolve: resolvePosInvoiceIntent },
  sales_receipt: { resolve: resolvePosInvoiceIntent },

  credit_memo: {
    resolve: async ({ referenceId, orderId }) => {
      if (!referenceId) return null;
      const row = await queryOne(
        `SELECT status, voided_at FROM pos_credit_memo WHERE id = $1`,
        [referenceId]
      );
      if (row?.status !== "voided" && !row?.voided_at) return null;
      return {
        voidStep: "void_credit_memo" as const,
        referenceId,
        referenceType: "credit_memo",
        orderId,
      };
    },
  },

  // Ajuste de inventario por defectuosos de un credit memo.
  //
  // Mientras su ADD viaja, el credit memo NO tiene todavía
  // `qb_inventory_adjustment_txn_id`, así que el chokepoint de defectuosos lee
  // "no hay ajuste" y no encola nada. Sin este spec, voidear el credit memo —o
  // simplemente bajar los defectuosos a cero— en esa ventana deja en
  // QuickBooks un write-off vivo que ya no le pertenece a nada.
  //
  // Dos condiciones, no una: el credit memo voideado, y también el credit memo
  // vivo que se quedó sin unidades defectuosas. Las dos dejan al ajuste sin
  // dueño, y la segunda no es hipotética — es el mismo botón que ya edita
  // defectuosos sobre un credit memo completado.
  cm_damage_adjustment: {
    resolve: async ({ referenceId, orderId }) => {
      if (!referenceId) return null;
      const cm = await queryOne(
        `SELECT status, voided_at FROM pos_credit_memo WHERE id = $1`,
        [referenceId]
      );
      if (!cm) return null;

      const isVoided = cm.status === "voided" || !!cm.voided_at;
      let hasDamage = false;
      if (!isVoided) {
        const live = await queryOne(
          `SELECT 1 AS one
             FROM pos_credit_memo_item
            WHERE credit_memo_id = $1
              AND deleted_at IS NULL
              AND COALESCE(damaged_qty, 0) > 0
            LIMIT 1`,
          [referenceId]
        );
        hasDamage = !!live;
      }
      if (!isVoided && hasDamage) return null;

      return {
        voidStep: "void_cm_damage_adjustment" as const,
        referenceId,
        referenceType: "credit_memo",
        orderId,
      };
    },
  },

  sales_order: {
    resolve: async ({ orderId }) => {
      if (!orderId) return null;
      const row = await queryOne(
        `SELECT status FROM "order" WHERE id = $1`,
        [orderId]
      );
      if (row?.status !== "canceled") return null;
      // SO y estimate viven con reference_id NULL — se keyean por order_id.
      return {
        voidStep: "void_sales_order" as const,
        referenceId: null,
        referenceType: null,
        orderId,
      };
    },
  },

  estimate: {
    resolve: async ({ orderId }) => {
      if (!orderId) return null;
      const row = await queryOne(
        `SELECT status FROM "order" WHERE id = $1`,
        [orderId]
      );
      if (row?.status !== "canceled") return null;
      return {
        voidStep: "void_estimate" as const,
        referenceId: null,
        referenceType: null,
        orderId,
      };
    },
  },

  payment: {
    resolve: async ({ referenceId, orderId }) => {
      if (!referenceId) return null;
      const row = await queryOne(
        `SELECT status,
                metadata->>'qb_void_operation_id'  AS void_op,
                metadata->>'qb_source'             AS source
           FROM customer_payment WHERE id = $1`,
        [referenceId]
      );
      if (!row) return null;
      // El pago está voideado en Medusa PERO nunca se emitió el borrado en QB.
      // La señal es la COLUMNA `status` — la verdad durable del documento,
      // igual que en los otros resolvers. NUNCA `metadata.qb_sync_status`:
      // esa clave la escriben también los caminos de confirm del ADD (el
      // inline la estampaba 'synced' un instante antes de llamar acá, y el
      // intent del pago 3420 se perdió exactamente así).
      // `qb_void_operation_id` es la prueba de que el TxnDel sí salió: el camino
      // directo lo estampa al confirmar. Sin esa key, el pago quedó voideado
      // acá y vivo en QuickBooks — que es exactamente la carrera.
      if (row.status !== "voided") return null;
      if (row.void_op) return null;
      // Un pago embebido en un Sales Receipt no es un ReceivePayment propio: se
      // quita voideando el SR, nunca borrando un documento que no existe.
      if (row.source === "sales_receipt") return null;
      return {
        voidStep: "void_payment" as const,
        referenceId,
        referenceType: "customer_payment",
        orderId,
      };
    },
  },

  inventory_adjustment: {
    resolve: async ({ referenceId, orderId }) => {
      // El create de inventory_adjustment lleva el id del conteo en `order_id`
      // (así lo lee el propio confirm del consolidator), mientras que su void lo
      // lleva en `reference_id`. Aceptar los dos evita depender de esa asimetría.
      const countId = referenceId ?? orderId;
      if (!countId) return null;
      const row = await queryOne(
        `SELECT voided_at FROM inventory_count WHERE id = $1`,
        [countId]
      );
      if (!row?.voided_at) return null;
      return {
        voidStep: "void_inventory_adjustment" as const,
        referenceId: countId,
        referenceType: "inventory_count",
        orderId,
      };
    },
  },
};

/** Los steps de create que este módulo sabe evaluar. */
export const VOID_INTENT_CREATE_STEPS = Object.keys(VOID_INTENT_SPECS);

export interface EnqueueVoidIfAlreadyVoidedInput {
  /** El step del ADD que acaba de confirmar. */
  createStep: string;
  referenceId: string | null;
  orderId: string | null;
  /** El TxnID recién conocido. Sin esto no hay nada que materializar. */
  qbTxnId: string | null;
  qbRefNumber?: string | null;
  medusaRefNumber?: string | null;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
}

/**
 * Se llama JUSTO DESPUÉS de confirmar un ADD, desde cualquier camino.
 *
 * Si el documento subyacente ya está voideado, encola su void con el TxnID
 * recién conocido y devuelve el id de la fila. Si no, devuelve null — que es el
 * caso abrumadoramente normal y no cuesta nada (una lectura por PK).
 *
 * Nunca lanza: un fallo acá no puede tumbar la confirmación de un ADD que ya
 * ocurrió en QuickBooks. Se loguea y sigue; el reconciliador lo levanta después.
 */
export async function enqueueVoidIfAlreadyVoided(
  input: EnqueueVoidIfAlreadyVoidedInput
): Promise<string | null> {
  const log = input.logger;
  try {
    if (!input.qbTxnId) return null;

    const spec = VOID_INTENT_SPECS[input.createStep];
    if (!spec) return null;

    const intent = await spec.resolve({
      referenceId: input.referenceId,
      orderId: input.orderId,
    });
    if (!intent) return null;

    // Idempotencia. El índice único parcial es la garantía dura bajo
    // concurrencia; este SELECT evita el ruido de un conflicto esperado y cubre
    // el caso de un void ya despachado o ya confirmado.
    //
    // Se busca EXACTAMENTE este step, no "cualquier void de esta clave". Una
    // orden tiene Sales Order Y Estimate como documentos QB distintos, los dos
    // voideables: preguntar por cualquiera hacía que un `void_sales_order` ya
    // encolado suprimiera el `void_estimate`, dejando el Estimate abierto en QB.
    const existing = await queryOne(
      `SELECT id, status FROM qb_order_pipeline
        WHERE step = $1
          AND (
            ($2::text IS NOT NULL AND reference_id = $2::text)
            OR ($2::text IS NULL AND $3::text IS NOT NULL AND reference_id IS NULL AND order_id = $3::text)
          )
        LIMIT 1`,
      [intent.voidStep, intent.referenceId, intent.orderId]
    );
    if (existing) {
      log?.info(
        `[void-intent] ${intent.voidStep} ya existe (${existing.status}) para ${intent.referenceId ?? intent.orderId} — no se duplica`
      );
      return null;
    }

    const rowId = await writePipelineRow({
      orderId: intent.orderId,
      referenceId: intent.referenceId,
      referenceType: intent.referenceType,
      step: intent.voidStep,
      status: "pending",
      qbTxnId: input.qbTxnId,
      qbRefNumber: input.qbRefNumber ?? null,
      medusaRefNumber: input.medusaRefNumber ?? null,
    });

    log?.info(
      `[void-intent] ⚠️ ${intent.referenceId ?? intent.orderId} ya estaba voideado cuando su ${input.createStep} confirmó — ` +
        `auto-encolado ${intent.voidStep} con TxnID=${input.qbTxnId} (fila ${rowId})`
    );
    return rowId;
  } catch (err: any) {
    log?.warn(
      `[void-intent] no se pudo evaluar/encolar el void post-confirm de ${input.referenceId ?? input.orderId}: ${err?.message}`
    );
    return null;
  }
}
