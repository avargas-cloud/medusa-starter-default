import type { MedusaContainer } from "@medusajs/framework/types";

import {
  extractSupervisorPin,
  guardSupervisorPin,
  pinGuardResponse,
  resolveActorId,
} from "../../../../../lib/pos/supervisor-pin-guard";
import type { PinConn } from "../../../../../lib/pos/verify-supervisor-pin";

/**
 * Una orden que vino de la WEB necesita PIN de supervisor para editarse.
 *
 * ── El pedido del operador ────────────────────────────────────────────────────
 * Un cliente que compró por la web llama por teléfono y pide cambiar algo —
 * sacar un producto, agregar otro. Decirle "cancelá y volvé a comprar" pierde
 * la venta, así que la orden SE PUEDE editar. Pero no como una del mostrador:
 * editar una orden que ya se cobró por internet exige autorización.
 *
 * ── Por qué existe este archivo ───────────────────────────────────────────────
 * El candado ya existía... en la pantalla. `hooks/useWebOrderLock.ts` detecta el
 * origen web, nace bloqueado y pide PIN — pero comparaba en el navegador y el
 * backend no sabía que el candado existía. Tres formas de pasarlo sin conocer el
 * PIN: leerlo de la respuesta de `/admin/stores`, editar el estado de React, o
 * simplemente llamar a la ruta de edición, que no pedía nada.
 *
 * ── Fail-CLOSED, a diferencia de su hermano ───────────────────────────────────
 * `assertOrderEditable` falla OPEN a propósito: es defensa en profundidad sobre
 * órdenes archivadas y un error de query transitorio no puede dejar la caja sin
 * poder editar. Éste es lo contrario: es LA autorización. Si no se puede
 * establecer el origen de la orden, se exige PIN. Pedir autorización de más es
 * recuperable; de menos, no.
 *
 * ── Qué cuenta como "web" ─────────────────────────────────────────────────────
 * La ausencia de `pos_created`, igual que el hook del frontend. Se mira el
 * canal de venta como confirmación: una orden del canal POS es del mostrador
 * aunque le falte la metadata.
 */
export interface WebOrderAuthResult {
  /** null = autorizada (o no hace falta). Si viene, responder con status+body. */
  denial: { status: number; body: Record<string, unknown> } | null;
}

export async function assertWebOrderAuthorized(
  scope: MedusaContainer,
  orderId: string,
  req: unknown
): Promise<WebOrderAuthResult> {
  return assertWebOrdersAuthorized(scope, [orderId], req);
}

/**
 * Variante multi-orden: refunds y credit memos tocan dinero de una o varias
 * órdenes (locked_order_id, metadata.order_id, applications) — si CUALQUIERA
 * es web, la operación exige PIN. Un solo query y UN solo intento contra el
 * guard (llamarlo por orden inflaría el contador de throttle por cada fallo).
 */
export async function assertWebOrdersAuthorized(
  scope: MedusaContainer,
  orderIds: Array<string | null | undefined>,
  req: unknown
): Promise<WebOrderAuthResult> {
  const ids = [...new Set(orderIds.filter((v): v is string => !!v))];
  if (ids.length === 0) return { denial: null };

  const pg = scope.resolve("__pg_connection__") as PinConn;

  let webOrderPresent: boolean;
  try {
    const placeholders = ids.map(() => "?").join(", ");
    const { rows } = (await pg.raw(
      `SELECT o.metadata->>'pos_created' AS pos_created,
              sc.name                    AS channel_name
         FROM "order" o
         LEFT JOIN sales_channel sc ON sc.id = o.sales_channel_id
        WHERE o.id IN (${placeholders}) AND o.deleted_at IS NULL`,
      ids
    )) as { rows: Array<{ pos_created: string | null; channel_name: string | null }> };
    // Ids inexistentes no cuentan: que cada ruta conteste su propio 404.
    webOrderPresent = (rows ?? []).some((row) => {
      const posCreated = String(row.pos_created ?? "") === "true";
      const channelIsPos = /pos/i.test(String(row.channel_name ?? ""));
      return !posCreated && !channelIsPos;
    });
  } catch {
    // Fail-CLOSED: no se pudo establecer el origen → se exige PIN.
    webOrderPresent = true;
  }

  if (!webOrderPresent) return { denial: null };

  const guard = await guardSupervisorPin({
    scope: scope as unknown as { resolve: (k: string) => unknown },
    db: pg,
    // Header o body: el PIN de una edicion de orden llega por header porque un
    // solo guardado pega a ocho rutas distintas.
    pin: extractSupervisorPin(req),
    actorId: resolveActorId(req),
  });

  if (guard.ok) return { denial: null };

  const { status, body: pinBody } = pinGuardResponse(guard);
  return {
    denial: {
      status,
      body: {
        ...pinBody,
        // Para que el POS pueda explicar POR QUÉ pide PIN en esta orden y no en
        // la de al lado.
        reason: "WEB_ORDER_EDIT",
        message:
          "Esta orden vino de la web — editarla requiere PIN de supervisor.",
      },
    },
  };
}
