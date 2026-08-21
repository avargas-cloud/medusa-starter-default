/**
 * cancel-draft-order.ts
 *
 * La parte de DOMINIO de anular un draft order (estimate): verificar que se
 * pueda, estampar el estado, y cancelar. Nada de HTTP y nada de QuickBooks.
 *
 * Existe porque hay DOS caminos que necesitan exactamente esto y llegan por
 * motivos opuestos:
 *
 *   · `POST /admin/draft-orders/:id/void` — un operador anula un estimate que
 *     puede llevar meses vivo y estar sincronizado a QuickBooks.
 *   · `POST /admin/draft-orders/:id/convert-force`, rama `deduplicated` — el
 *     guard anti-duplicado probó que otra orden idéntica ya existe, así que
 *     este draft es el PERDEDOR de un doble submit y nació hace segundos.
 *
 * La desactivación del Estimate en QuickBooks NO vive acá, y es deliberado: el
 * route la corre fire-and-forget DESPUÉS de responder, y el perdedor de un doble
 * submit no tiene estimate en QB que desactivar (nace y muere dentro de la misma
 * ventana de segundos, mucho antes de que el cron de lazy-sync lo mire). Meterla
 * en el helper le agregaría a la limpieza una dependencia externa que no puede
 * hacer nada útil.
 *
 * CONTRATO: esta función NUNCA tira. Devuelve un resultado discriminado. Su
 * caller del lado de convert-force está en el camino de una venta que YA ocurrió
 * y no puede trabarse porque una limpieza cosmética falle.
 */

export type CancelDraftOrderOutcome =
  | { ok: true; canceled: true }
  /** Ya estaba cancelada, o no es un draft: no hay nada que hacer y no es un error. */
  | { ok: true; canceled: false; reason: "already_canceled" | "not_a_draft" | "not_found" }
  | { ok: false; reason: "has_active_fulfillments" | "cancel_failed"; error: string };

export interface CancelDraftOrderInput {
  /** Contenedor de Medusa del request (`req.scope`). */
  scope: any;
  orderId: string;
  /**
   * Claves que se mergean al metadata ANTES de cancelar. El caller decide la
   * narrativa: el void del operador estampa `order_status: "Voided"`, la
   * supersesión estampa a quién perdió contra quién.
   */
  metadataPatch?: Record<string, unknown>;
}

export async function cancelDraftOrder({
  scope,
  orderId,
  metadataPatch,
}: CancelDraftOrderInput): Promise<CancelDraftOrderOutcome> {
  const { Modules } = await import("@medusajs/utils");
  const orderModule = scope.resolve(Modules.ORDER) as any;

  // ── 1. Precondiciones ────────────────────────────────────────────────────
  // Se re-leen ACÁ ADENTRO, no se confían del caller: entre que convert-force
  // resolvió su duplicado y llega a limpiar, otra sesión pudo convertir o
  // cancelar este mismo draft. Cancelar sobre una suposición vieja es cómo se
  // anula un documento vivo.
  let order: any;
  try {
    order = await orderModule.retrieveOrder(orderId, {
      select: ["id", "display_id", "status", "is_draft_order", "metadata"],
    });
  } catch {
    return { ok: true, canceled: false, reason: "not_found" };
  }

  if (!order?.is_draft_order) {
    return { ok: true, canceled: false, reason: "not_a_draft" };
  }
  if (order.status === "canceled") {
    // Idempotente a propósito: repetir la limpieza es un no-op, no un error.
    return { ok: true, canceled: false, reason: "already_canceled" };
  }

  // ── 2. Estampar antes de cancelar ────────────────────────────────────────
  // Antes, porque si la cancelación falla queremos igual el rastro de por qué
  // se intentó. Es no-crítico: perder el stamp no puede impedir la cancelación.
  if (metadataPatch) {
    try {
      await orderModule.updateOrders(orderId, {
        metadata: { ...(order.metadata || {}), ...metadataPatch },
      });
    } catch {
      /* non-critical — el rastro es deseable, no obligatorio */
    }
  }

  // ── 3. Cancelar ──────────────────────────────────────────────────────────
  try {
    const { cancelOrderWorkflow } = await import("@medusajs/core-flows");
    await cancelOrderWorkflow(scope).run({ input: { order_id: orderId } });
    return { ok: true, canceled: true };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    // cancelOrderWorkflow tira cuando hay fulfillments activos. Se distingue
    // porque el route lo convierte en un 409 accionable para el operador.
    if (
      msg.toLowerCase().includes("fulfillment") ||
      msg.includes("All fulfillments must be canceled")
    ) {
      return { ok: false, reason: "has_active_fulfillments", error: msg };
    }
    return { ok: false, reason: "cancel_failed", error: msg };
  }
}

/**
 * Metadata que marca a un draft como perdedor de un doble submit.
 *
 * El estado canónico sigue siendo `canceled` — esto es la RELACIÓN, no un
 * estado nuevo. `supersession_cleanup_status` queda como señal durable: hoy
 * nadie la barre (ver la deuda declarada en el plan), y una marca sin barredora
 * es preferible a una barredora que pueda cancelar un estimate legítimo.
 */
export function supersededMetadata(winnerOrderId: string, nowIso: string) {
  return {
    order_status: "Voided",
    superseded_by_order_id: winnerOrderId,
    superseded_at: nowIso,
    superseded_reason: "duplicate_submit",
    supersession_cleanup_status: "done",
  } as const;
}
