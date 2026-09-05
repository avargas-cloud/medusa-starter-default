import type { Pool } from "pg";

import { allocateInvoicedToLines } from "../../../../../lib/invoices/per-line-invoiced";
import { liveFulfilledSql } from "../../_lib/separation-sql";

/**
 * El PISO de una línea de orden: cuántas unidades ya no se pueden deshacer.
 *
 * Regla del operador (2026-09-05): una línea sólo se puede reducir si la nueva
 * cantidad es MAYOR O IGUAL a lo facturado/entregado, y por lo tanto sólo se
 * puede borrar si ese piso es 0.
 *
 * Hasta hoy nada lo verificaba. `delete-item-force` borraba la línea EN DURO y
 * soltaba sus reservas mirando únicamente si la orden estaba `archived`, y el
 * botón de borrar de `LineItemsTable` está siempre visible: un cajero podía
 * sacar de la orden una línea ya facturada, dejando la factura apuntando a una
 * línea inexistente. Medido en producción el 2026-09-05: 5.339 de 5.575 líneas
 * vivas (96%) tienen piso > 0, así que la ruta estaba desprotegida justo donde
 * casi todo el trabajo ocurre.
 *
 * NINGUNO de los dos números se deriva acá. Los dos tienen dueño y este repo ya
 * se quemó dos veces reimplementándolos:
 *
 *  · ENTREGADO — `liveFulfilledSql`: fulfillments VIVOS, nunca el agregado
 *    `order_item.fulfilled_quantity`, que se escribe hacia adelante y no se
 *    revierte al anular (mal en 25 líneas de 6 órdenes, regla 2026-08-20).
 *  · FACTURADO — `allocateInvoicedToLines`: atribución directa por
 *    `order_line_item_id` MÁS el pool FIFO por variante/SKU, porque los
 *    invoices anteriores al 2026-08-08 facturan una variante y no una línea.
 *    Sin el pool, sus unidades leen como no facturadas.
 */
export interface LineFloor {
  lineId: string;
  quantity: number;
  invoiced: number;
  fulfilled: number;
  /** max(facturado, entregado) — el mínimo al que se puede bajar la línea. */
  floor: number;
}

/**
 * El piso: lo facturado O lo entregado, lo que sea mayor. NO su suma — una
 * unidad facturada Y entregada es UNA unidad.
 *
 * Vive aparte, y no inline en el map de `loadLineFloors`, para que se pueda
 * afirmar sin base de datos: los datos reales no ejercitan el caso
 * `entregado > facturado` (medido el 2026-09-05: 0 de las 1.379 líneas que la
 * §2 del verificador compara), así que inline quedaba sin cobertura y una
 * mutación que ignorara el fulfillment pasaba el gate entero en verde.
 */
export function computeFloor(invoiced: number, fulfilled: number): number {
  return Math.max(invoiced, fulfilled);
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Pisos de todas las líneas VIVAS de una orden, keyeados por line item id.
 *
 * El join contra `order` lleva `oi.version = o.version` — sin eso una orden
 * editada N veces devuelve N filas por línea y los conteos se multiplican
 * (medido: 19.321 filas contra las 5.577 reales). Mismo shape que
 * `loadSeparationData`, a propósito.
 */
export async function loadLineFloors(
  pool: Pool,
  orderId: string
): Promise<Map<string, LineFloor>> {
  const lineRes = await pool.query<{
    line_id: string;
    variant_id: string | null;
    sku: string | null;
    quantity: unknown;
    fulfilled_live: unknown;
    invoiced_direct: unknown;
  }>(
    `SELECT oli.id                  AS line_id,
            oli.variant_id          AS variant_id,
            oli.variant_sku         AS sku,
            oi.quantity             AS quantity,
            ${liveFulfilledSql("oi.order_id", "oli.id")} AS fulfilled_live,
            COALESCE(inv.qty, 0)    AS invoiced_direct
       FROM order_item oi
       JOIN "order" o
         ON o.id = oi.order_id
        AND oi.version = o.version
       JOIN order_line_item oli
         ON oli.id = oi.item_id
        AND oli.deleted_at IS NULL
       LEFT JOIN LATERAL (
            SELECT SUM(pii.quantity) AS qty
              FROM pos_invoice_item pii
              JOIN pos_invoice pi
                ON pi.id = pii.invoice_id
               AND pi.deleted_at IS NULL
               AND pi.status NOT IN ('voided', 'draft')
             WHERE pii.order_line_item_id = oli.id
               AND pii.deleted_at IS NULL
       ) inv ON true
      WHERE oi.order_id = $1
        AND oi.deleted_at IS NULL
      ORDER BY oli.created_at ASC, oli.id ASC`,
    [orderId]
  );

  // Invoices que facturaron una variante sin decir qué línea (pre-2026-08-08).
  const unattributedRes = await pool.query<{
    variant_id: string | null;
    sku: string | null;
    qty: unknown;
  }>(
    `SELECT pii.variant_id, pii.sku, SUM(pii.quantity) AS qty
       FROM pos_invoice_item pii
       JOIN pos_invoice pi
         ON pi.id = pii.invoice_id
        AND pi.deleted_at IS NULL
        AND pi.status NOT IN ('voided', 'draft')
      WHERE pi.order_id = $1
        AND pii.order_line_item_id IS NULL
        AND pii.deleted_at IS NULL
      GROUP BY pii.variant_id, pii.sku`,
    [orderId]
  );

  const invoicedByLine = allocateInvoicedToLines(
    lineRes.rows.map((r) => ({
      lineId: r.line_id,
      variantId: r.variant_id,
      sku: r.sku,
      quantity: num(r.quantity),
      directInvoiced: num(r.invoiced_direct),
    })),
    unattributedRes.rows.map((r) => ({
      variantId: r.variant_id,
      sku: r.sku,
      quantity: num(r.qty),
    }))
  );

  const out = new Map<string, LineFloor>();
  for (const r of lineRes.rows) {
    const invoiced = num(invoicedByLine.get(r.line_id));
    const fulfilled = num(r.fulfilled_live);
    out.set(r.line_id, {
      lineId: r.line_id,
      quantity: num(r.quantity),
      invoiced,
      fulfilled,
      floor: computeFloor(invoiced, fulfilled),
    });
  }
  return out;
}

export interface FloorDenial {
  error: string;
  code: "BELOW_INVOICED_FLOOR";
  line_item_id: string;
  floor: number;
  invoiced: number;
  fulfilled: number;
  requested: number;
}

/**
 * `null` = la operación está permitida.
 *
 * Sólo muerde cuando la operación BAJA la cantidad por debajo del piso. Es
 * deliberado y no es laxitud: hay 14 líneas en producción que ya están por
 * debajo del suyo (3 órdenes `completed`, con el fulfillment contado doble —
 * dato roto anterior a esta regla). Un guard que rechazara por el ESTADO en vez
 * de por el EFECTO las dejaría congeladas para siempre, sin poder corregirles
 * ni el título. Bajar de 2 a 2 con piso 10 no empeora nada; bajar de 10 a 2 sí.
 *
 * `nextQuantity` null/undefined = la operación no toca la cantidad (un cambio
 * de título o de precio) y nunca se bloquea.
 */
export function floorDenial(
  floor: LineFloor | undefined,
  nextQuantity: number | null | undefined,
  { deleting = false }: { deleting?: boolean } = {}
): FloorDenial | null {
  if (!floor) return null;
  if (floor.floor <= 0) return null;

  // El BORRADO se resuelve ANTES de la excepción de abajo. Con piso positivo
  // siempre se rechaza — sin esto, una línea que ya estaba en cantidad 0 con
  // piso 3 caía en `requested >= floor.quantity` (0 >= 0) y se dejaba ELIMINAR,
  // que es justo la referencia facturada que el guard existe para proteger.
  if (deleting) {
    return buildDenial(floor, 0, true);
  }

  const requested = nextQuantity;
  if (requested === null || requested === undefined) return null;
  if (requested >= floor.floor) return null;
  // Ya estaba por debajo: sólo se rechaza si la operación la baja MÁS.
  if (requested >= floor.quantity) return null;

  return buildDenial(floor, requested, false);
}

function buildDenial(
  floor: LineFloor,
  requested: number,
  deleting: boolean
): FloorDenial {
  const what = deleting ? "eliminar" : `bajar a ${requested}`;
  const why =
    floor.fulfilled >= floor.invoiced
      ? `${floor.fulfilled} entregada(s)`
      : `${floor.invoiced} facturada(s)`;
  return {
    error:
      `No se puede ${what} esta línea: tiene ${why}. ` +
      `La cantidad no puede bajar de ${floor.floor}. ` +
      `Para deshacerlo, primero voideá la factura o anulá el envío.`,
    code: "BELOW_INVOICED_FLOOR",
    line_item_id: floor.lineId,
    floor: floor.floor,
    invoiced: floor.invoiced,
    fulfilled: floor.fulfilled,
    requested,
  };
}
