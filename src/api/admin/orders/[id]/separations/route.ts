/**
 * POST /admin/orders/:id/separations
 *
 * Writes per-line separated quantities. The MODAL only collects numbers — this
 * route is the authorization: every requested quantity is re-validated here
 * against fresh physical Miami inventory net of other orders' live
 * separations, never against what the screen believed.
 *
 * Body: { separations: [{ line_id, qty }] } — qty is the line's new TOTAL
 * separated amount (not a delta); 0 clears the mark. Lines not included keep
 * their stored value.
 *
 * ESA `qty` ESTÁ EN UNIDADES DE ESTANTE (netas), que es lo que el modal muestra
 * y lo que el operador cuenta: la columna, en cambio, vive en el eje ORDENADO y
 * cada lector le resta lo despachado. La conversión ocurre en el INSERT, abajo —
 * toda la validación de este archivo (caps, floor invoiced, reclamo cross-orden,
 * activity log) habla en netas y no debe convertir nada.
 *
 * Separation NEVER moves stock or reservations — it is an operational mark.
 * The row upserts and the derived order metadata (`separation_status` +
 * `is_separated`, the boolean mirror the Separated tab and Meili consume)
 * commit in ONE transaction; the UPDATE on "order" fires the Meili trigger.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../../../utils/db-pool";
import {
  recordPosActivity,
  type KnexRawConnection,
} from "../../../../../lib/pos/order-activity";
import {
  effectiveSeparatedOf,
  separationStatusLinesOf,
  validateSeparationRequest,
} from "../../_lib/separation-caps";
import { liveFulfilledSql } from "../../_lib/separation-sql";
import { deriveSeparationStatus } from "../../_lib/separation-status";
import { loadSeparationData } from "../_lib/separation-data";

interface SeparationInput {
  line_id?: unknown;
  qty?: unknown;
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const orderId = req.params.id ?? "";
  if (!orderId) {
    res.status(400).json({ error: "order id is required" });
    return;
  }
  const body = (req.body ?? {}) as { separations?: SeparationInput[] };

  if (!Array.isArray(body.separations) || body.separations.length === 0) {
    res.status(400).json({ error: "separations array is required" });
    return;
  }

  const requested = new Map<string, number>();
  for (const entry of body.separations) {
    const lineId = typeof entry.line_id === "string" ? entry.line_id : "";
    const qty = typeof entry.qty === "number" ? entry.qty : Number(entry.qty);
    if (!lineId || !Number.isFinite(qty) || qty < 0) {
      res.status(400).json({
        error: "each separation needs a line_id and a qty >= 0",
      });
      return;
    }
    requested.set(lineId, qty);
  }

  const pool = getDbPool();
  const data = await loadSeparationData(pool, orderId);
  if (!data) {
    res.status(404).json({ error: "order not found" });
    return;
  }

  const knownLineIds = new Set(data.lines.map((l) => l.lineId));
  for (const lineId of requested.keys()) {
    if (!knownLineIds.has(lineId)) {
      res.status(400).json({
        error: `line ${lineId} does not belong to this order's current version`,
      });
      return;
    }
  }

  const rejections = validateSeparationRequest(
    data.lines,
    data.inventory,
    requested
  );
  if (rejections.length) {
    // CUATRO rechazos distintos comparten esta respuesta y piden acciones
    // OPUESTAS — mandar el mensaje equivocado manda al depósito a buscar un
    // problema que no tiene.
    //
    // `exceeds_open_qty` tenía que compartir el texto del reclamo cross-orden,
    // así que pedir más unidades de las que la orden tiene abiertas contestaba
    // "otras órdenes se llevaron el resto": ni el operador ni el E2E podían
    // distinguir un error de tipeo de una disputa por stock. Cada motivo dice
    // ahora lo suyo, y el genérico queda SÓLO para una tanda mezclada.
    const allAre = (reason: string): boolean =>
      rejections.every((r) => r.reason === reason);

    const answer = allAre("not_separable")
      ? {
          error: "separation_line_not_separable",
          message: "Service and non-inventory lines have nothing to set aside.",
        }
      : allAre("below_invoiced_floor")
        ? {
            error: "separation_below_invoiced_floor",
            message:
              "Invoiced units that have not left the warehouse cannot be un-separated.",
          }
        : allAre("exceeds_open_qty")
          ? {
              error: "separation_exceeds_open_qty",
              message:
                "Some quantities are higher than what the order still has open.",
            }
          : allAre("exceeds_claimed_elsewhere")
            ? {
                error: "separation_exceeds_inventory",
                message:
                  "Some quantities exceed what is left after other orders' separations.",
              }
            : {
                error: "separation_rejected",
                message:
                  "Some lines could not be saved — see the reason on each one.",
              };

    res.status(409).json({ ...answer, rejections });
    return;
  }

  // Merge requested over stored to derive the resulting order-level status.
  // Las líneas sin inventario quedan AFUERA: aportarían pendiente que nadie
  // puede apartar, y una orden con una instalación no llegaría nunca a `full`.
  // `separated` va por `effectiveSeparatedOf` (piso facturado incluido) — el
  // valor crudo estampaba `partial` en órdenes cubiertas en parte sólo por
  // invoices, contradiciendo al modal y al badge de la lista (S11432/3021).
  // Para las líneas del request el valor tipeado ya pasó la validación del
  // piso (`below_invoiced_floor` rechaza arriba), así que se respeta tal cual.
  const mergedLines = separationStatusLinesOf(data.lines).map((l) => ({
    quantity: l.quantity,
    fulfilled: l.fulfilled,
    separated: requested.has(l.lineId)
      ? (requested.get(l.lineId) as number)
      : effectiveSeparatedOf(l),
  }));
  // `legacy = false` A PROPÓSITO, igual que `clearDeliveredSeparations`: este
  // request está por escribir filas, así que la orden TIENE tracking por línea
  // y su booleano ya no puede hablar por ella.
  //
  // Leerlo era un bucle cerrado sobre sí mismo. Esta misma ruta estampa
  // `is_separated: true` al llegar a `full`, y `loadSeparationData` corre ANTES
  // del write siguiente: guardar todo en 0 encontraba el flag que el Save
  // anterior acababa de poner, `deriveSeparationStatus` lo tomaba por una orden
  // pre-tracking (ninguna línea con cantidad > 0) y devolvía `full` otra vez.
  // Una orden que llegaba a `full` no se podía des-apartar NUNCA: 200, filas en
  // cero, "0 of N units set aside" en el modal, y el badge diciendo Separated.
  // Se descubrió el 2026-08-31 devolviendo S11543 a su estado inicial.
  const separation_status = deriveSeparationStatus(mergedLines, false);
  const isSeparated = separation_status === "full";

  const actorId = req.auth_context?.actor_id ?? null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [lineId, qty] of requested) {
      // NETO → BRUTO. `qty` llega en unidades DE ESTANTE (lo que el operador ve
      // y tipea); la columna se guarda en el eje ORDENADO y todo lector le resta
      // lo despachado (`netSeparatedSql`). Guardar el neto crudo hacía que la
      // línea perdiera exactamente `fulfilled` unidades en cada Save: en S11320
      // (9 ordenadas, 1 entregada) escribir 8 se releía como 7 para siempre, y
      // en la orden 3021 se comió 122 unidades apartadas hasta mostrar 0 — con
      // el agravante de que el reclamo cross-orden también se calcula neteado,
      // así que esas unidades quedaban ofrecidas a otra orden.
      //
      // La conversión usa el MISMO fragmento que los lectores, adentro de la
      // transacción, y no una variable de JS calculada antes: es la regla que
      // `separation-sql.ts` se puso a sí mismo (un hecho, un lugar), y de paso
      // cierra la carrera de un fulfillment que aterrice entre el read y el
      // write — ahí `fulfilled` de `loadSeparationData` ya sería viejo.
      await client.query(
        `INSERT INTO order_line_separation
                 (order_id, order_line_item_id, qty, updated_by)
          VALUES ($1, $2, $3::numeric + ${liveFulfilledSql("$1", "$2")}, $4)
          ON CONFLICT (order_id, order_line_item_id)
          DO UPDATE SET qty = EXCLUDED.qty,
                        updated_by = EXCLUDED.updated_by,
                        updated_at = now()`,
        [orderId, lineId, qty, actorId]
      );
    }
    // Same transaction as the rows so status and lines can never disagree.
    // The UPDATE on "order" fires the Meili sync trigger.
    await client.query(
      `UPDATE "order"
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
        WHERE id = $1`,
      [
        orderId,
        JSON.stringify({
          is_separated: isSeparated,
          separation_status,
        }),
      ]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // Native Activity Log footprint: WHO set aside WHAT (per-SKU from→to), so
  // the owner can track warehouse work per user. Only real changes are
  // recorded — re-saving identical values leaves no entry. Best-effort by
  // contract (recordPosActivity swallows failures): the save already
  // committed and activity must never undo it.
  const changes = [...requested]
    .map(([lineId, qty]) => {
      const l = data.lines.find((x) => x.lineId === lineId);
      if (!l || qty === l.separated) return null;
      return { sku: l.sku || "—", from: l.separated, to: qty };
    })
    .filter((c): c is { sku: string; from: number; to: number } => c !== null);
  if (changes.length) {
    const knexConn = req.scope.resolve("__pg_connection__") as KnexRawConnection;
    await recordPosActivity(knexConn, {
      orderId,
      event: "separation_saved",
      details: { changes, status: separation_status },
      userId: actorId,
    });
  }

  res.json({
    separation_status,
    is_separated: isSeparated,
    lines: mergedLines.length,
  });
}
