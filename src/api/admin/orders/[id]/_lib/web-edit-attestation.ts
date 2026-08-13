import type { MedusaContainer } from "@medusajs/framework/types";

import {
  recordPosActivity,
  type KnexRawConnection,
} from "../../../../../lib/pos/order-activity";
import { resolveActorId } from "../../../../../lib/pos/supervisor-pin-guard";

/**
 * Attestation de una edición de orden WEB: el registro estructurado de que el
 * CLIENTE confirmó el cambio (por email, teléfono o en persona) antes de que
 * un admin editara su orden. No es prueba del email — es la declaración del
 * operador, con actor, hora y ruta sellados por el servidor.
 *
 * ── Cortes de despliegue (decisión del plan descuentos-canonicos-v1) ─────────
 *   1. el backend la ACEPTA y la sella si viene (este archivo)      ← vivo
 *   2. el POS la manda con cada edición de orden web                ← vivo
 *   3. el backend la EXIGE fail-closed                              ← flip futuro,
 *      documentado en .claude/rules/orders-fulfillment.md; NO activarlo sin
 *      confirmar que el POS desplegado ya la manda (frontend-first).
 *
 * ── Por qué se sella DESPUÉS del efecto ──────────────────────────────────────
 * Un Save del POS pega a varias rutas gateadas: registrar "autorizado" al
 * pasar el guard produciría N huellas por un solo save y registraría
 * autorizaciones de mutaciones que después fallaron. La huella se escribe al
 * final de la operación que tuvo efecto, y `operation_id` deduplica las rutas
 * de un mismo Save (la primera que termina la escribe, las demás la ven).
 */
export interface WebEditAttestation {
  /** Cómo confirmó el cliente: 'email' | 'phone' | 'in_person' | otro. */
  channel?: string;
  /** Cuándo confirmó (ISO), según el operador. */
  confirmed_at?: string;
  /** Referencia libre: "cliente confirmó por email 8/14", nro de ticket, etc. */
  reference?: string;
}

export interface WebEditAuditContext {
  operationId?: string;
  attestation?: WebEditAttestation | null;
  actorId?: string | null;
}

const str = (v: unknown, max = 500): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

/** Lee la attestation opcional del body. Corte 1: aceptar, jamás exigir. */
export function extractWebEditAudit(req: unknown): WebEditAuditContext {
  const body = ((req as { body?: unknown })?.body ?? {}) as Record<
    string,
    unknown
  >;
  const raw = body.web_edit_attestation as
    | Record<string, unknown>
    | undefined;
  const attestation: WebEditAttestation | null =
    raw && typeof raw === "object"
      ? {
          channel: str(raw.channel, 40),
          confirmed_at: str(raw.confirmed_at, 40),
          reference: str(raw.reference),
        }
      : null;
  return {
    operationId: str(body.web_edit_operation_id, 80),
    attestation,
    actorId: resolveActorId(req) || null,
  };
}

/**
 * Sella la huella `pos_activity` de una edición de orden web YA EFECTUADA.
 * No-op silencioso para órdenes POS (resuelve el origen él mismo) y para la
 * segunda ruta del mismo `operation_id`. Best-effort como toda actividad:
 * registrar jamás voltea la operación que ya ocurrió.
 */
export async function recordWebOrderEditFootprint(
  scope: MedusaContainer,
  orderId: string,
  route: string,
  ctx: WebEditAuditContext
): Promise<void> {
  try {
    const pg = scope.resolve("__pg_connection__") as KnexRawConnection;

    const { rows } = await pg.raw(
      `SELECT o.metadata->>'pos_created' AS pos_created, sc.name AS channel_name
         FROM "order" o
         LEFT JOIN sales_channel sc ON sc.id = o.sales_channel_id
        WHERE o.id = ? AND o.deleted_at IS NULL`,
      [orderId]
    );
    const row = rows?.[0];
    if (!row) return;
    const isWeb =
      String(row.pos_created ?? "") !== "true" &&
      !/pos/i.test(String(row.channel_name ?? ""));
    if (!isWeb) return;

    if (ctx.operationId) {
      const dup = await pg.raw(
        `SELECT 1 FROM order_change
          WHERE order_id = ? AND change_type = 'pos_activity'
            AND internal_note LIKE ?
          LIMIT 1`,
        [orderId, `%"operation_id":"${ctx.operationId}"%`]
      );
      if (dup.rows?.length) return;
    }

    await recordPosActivity(pg, {
      orderId,
      event: "web_order_edit",
      details: {
        route,
        ...(ctx.operationId ? { operation_id: ctx.operationId } : {}),
        ...(ctx.attestation &&
        (ctx.attestation.channel ||
          ctx.attestation.reference ||
          ctx.attestation.confirmed_at)
          ? { customer_confirmation: ctx.attestation }
          : {}),
      },
      userId: ctx.actorId ?? null,
    });
  } catch (err) {
    console.error("[web-edit-attestation] footprint failed:", err);
  }
}
