// El FLETE como ingreso — el término invoice-level que faltaba.
//
// ## Por qué existe (2026-09-04)
//
// El total de ventas del POS no cuadraba con el de QuickBooks: agosto 2026 daba
// $310,00 de menos, que es al centavo `Σ pos_invoice.shipping` del mes. El item
// de QB `SHIPPING & HANDLING` apunta a `Sales:Shipping and Delivery Income`
// —cuenta de INGRESO— así que *Sales by Customer Summary* lo cuenta como venta;
// nosotros sumábamos sólo líneas de ítem y la columna `pos_invoice.shipping` no
// aparecía en ningún SELECT de `reports/`.
//
// Ninguna de las dos cifras estaba corrupta: medían cosas distintas. El diff
// documento por documento de agosto contra QB dio 335/335 idénticos y
// $134.586,53 los dos lados — nunca fue un bug de sincronización.
// Detalle y medición: `docs/REPORTS_SHIPPING_PARITY_PLAN.md`.
//
// ## Las dos reglas que hacen que esto no rompa nada
//
// 1. **`NET_ITEM_REVENUE` NO se toca.** Es una expresión por LÍNEA y
//    `commission-expr.ts` la usa como PESO para prorratear la comisión de una
//    orden entre sus facturas. Meterle el flete redistribuye centavos de
//    comisiones YA LIQUIDADAS a gente real. El flete entra como término propio
//    a nivel FACTURA, jamás dentro de la expresión por línea.
//
// 2. **El flete nunca se suma del lado del JOIN.** Las rutas de reportes hacen
//    `JOIN pos_invoice_item`; un `SUM(i.shipping)` ahí multiplica el flete por
//    la cantidad de líneas de la factura. Todo lo de abajo reduce por factura
//    ANTES de cualquier join, igual que `CM_REFUNDS_BY_CUSTOMER_CTE`.
//
// ## Por qué el archivo es propio y no un bloque de `sales-revenue.ts`
//
// Por el límite de 300 líneas del repo, y porque la dirección del import
// importa: acá se importa DESDE `sales-revenue`, nunca al revés. El import
// inverso cierra un ciclo y Medusa muere al registrar las rutas con "Cannot
// access CM_REFUND_CENTS_EXPR before initialization" — y `yarn type-check` y
// `yarn build` pasan los DOS con ese ciclo puesto: sólo lo caza arrancar el
// servidor.

import {
  CM_REFUND_DATE_COL,
  CM_REFUND_SCOPE_SQL,
  SALES_ACTIVE_STATUSES_SQL,
  SALES_DATE_FILTER_SQL,
} from "./sales-revenue"

/** Flete facturado de UNA factura, en centavos. Requiere el alias `i` en scope. */
export const INVOICE_SHIPPING_CENTS = `COALESCE(i.shipping, 0)`

/** Flete devuelto por UN credit memo, en centavos. Requiere el alias `cm`. */
export const CM_SHIPPING_REFUND_CENTS = `COALESCE(cm.shipping, 0)`

/**
 * El rótulo del bucket sintético en `by-item` / `by-category`.
 *
 * El flete no es un producto —`by-item` incluso filtra `pii.variant_id IS NOT
 * NULL`— así que no tiene dónde caer naturalmente. QuickBooks tampoco lo
 * inventa: en *Sales by Item Summary* el flete es SU PROPIA FILA, con el nombre
 * del item. Se replica ese nombre EXACTO para que las dos pantallas se puedan
 * comparar renglón contra renglón.
 */
export const SHIPPING_LINE_LABEL = "SHIPPING & HANDLING"

/** El scope de facturas de todo este módulo — el mismo que usa `sales/`. */
const INVOICE_SCOPE_SQL = `i.deleted_at IS NULL
       AND ${SALES_ACTIVE_STATUSES_SQL}
       AND ${SALES_DATE_FILTER_SQL}`

/**
 * ## Por qué `refunded_shipping` NO aparece en ningún lado de este archivo
 *
 * `pos_invoice.refunded_shipping` es el espejo invoice-level de
 * `pii.refunded_quantity`, y ese ya se reporta como dato INFORMATIVO
 * (`item_refunded`) sin restarse del ingreso: en todos estos reportes las
 * devoluciones son CM-autoritativas. Restar las dos cosas contaría la misma
 * devolución dos veces. El flete devuelto entra por el credit memo, que es
 * exactamente el mismo camino que ya siguen los ítems.
 *
 * Hoy las dos columnas están en cero en toda la historia (verificado contra
 * producción el 2026-09-04), así que la simetría no mueve un centavo todavía.
 * Se implementa igual: si el flete es ingreso, el flete devuelto lo resta.
 */
const NET_SHIPPING_UNION_SQL = `
      SELECT %AXIS_INV% AS axis_key, ${INVOICE_SHIPPING_CENTS} AS cents
      FROM pos_invoice i %JOIN%
      WHERE ${INVOICE_SCOPE_SQL}
      UNION ALL
      SELECT %AXIS_CM% AS axis_key, -${CM_SHIPPING_REFUND_CENTS} AS cents
      FROM pos_credit_memo cm
      WHERE ${CM_REFUND_SCOPE_SQL}
        AND ${CM_REFUND_DATE_COL} >= ? AND ${CM_REFUND_DATE_COL} < ?`

/**
 * CTE de flete NETO agrupado por un eje, para las rutas que piden una fila por
 * cliente / vendedor / balde de tiempo en vez de un escalar. Emite una sola
 * columna `shipping_cents`; se `LEFT JOIN`ea contra el agregado que ya existía.
 *
 * Facturado y devuelto viajan en UN `UNION ALL` en vez de dos CTEs a propósito:
 * cada CTE que se agrega a una ruta es un par de placeholders más que
 * reacomodar, y el orden de los bindings es donde este tipo de cambio se
 * rompe en silencio. Uno solo = un solo punto de inserción por ruta.
 *
 * Verificado contra producción el 2026-09-04: toda factura con flete tiene
 * líneas y tiene `order_id`, así que ningún `LEFT JOIN` pierde plata ni manda
 * un flete a 'Unassigned Agent'.
 *
 * Lleva **CUATRO** placeholders `?` en este orden: desde/hasta de FACTURAS,
 * después desde/hasta de DEVOLUCIONES — en la posición en que el CTE aparezca
 * en el TEXTO del SQL.
 *
 * @param cteName  nombre del CTE
 * @param axisInv  expresión del eje sobre `pos_invoice i`
 * @param axisCm   expresión del eje sobre `pos_credit_memo cm`. El eje del lado
 *                 devolución tiene que ser el MISMO concepto que el de ventas o
 *                 el neteo cae en el balde equivocado.
 * @param joinSql  JOINs extra sobre `pos_invoice i` (`by-pos-user` necesita `order`)
 */
export function shippingByAxisCte(
  cteName: string,
  axisInv: string,
  axisCm: string,
  joinSql = ""
): string {
  const union = NET_SHIPPING_UNION_SQL
    .replace("%AXIS_INV%", axisInv)
    .replace("%AXIS_CM%", axisCm)
    .replace("%JOIN%", joinSql)
  return `
  ${cteName} AS (
    SELECT axis_key, SUM(cents)::bigint AS shipping_cents
    FROM (${union}
    ) _ship
    GROUP BY axis_key
  )`
}

/**
 * El caso que usan NUEVE rutas (las 8 de `customers/` y `sales/by-customer`),
 * listo para pegar al lado de `CM_REFUNDS_BY_CUSTOMER_CTE`. Comparte forma con
 * él a propósito: que las dos familias de reportes usen la misma definición es
 * lo único que evita que vuelvan a dar números distintos para el mismo cliente.
 *
 * Cuatro placeholders `?`, en el orden documentado arriba.
 */
export const SHIPPING_BY_CUSTOMER_CTE = shippingByAxisCte(
  "ship",
  "i.customer_id",
  "cm.customer_id"
)

/**
 * Flete NETO facturado en [from, to), en centavos. Para las rutas de cifra
 * ESCALAR (`sales/summary`, `month-close-data`) que hoy piden el total con un
 * `SUM(...)` suelto.
 *
 * Consulta propia y no un `SUM` agregado a la query existente, a propósito:
 * ésa hace `JOIN pos_invoice_item` y el flete se multiplicaría por la cantidad
 * de líneas.
 */
export async function fetchShippingCentsForPeriod(
  pg: any,
  from: string,
  to: string
): Promise<number> {
  const [billed, refunded] = await Promise.all([
    pg.raw(
      `SELECT COALESCE(SUM(${INVOICE_SHIPPING_CENTS}), 0)::bigint AS cents
       FROM pos_invoice i
       WHERE ${INVOICE_SCOPE_SQL}`,
      [from, to]
    ),
    pg.raw(
      `SELECT COALESCE(SUM(${CM_SHIPPING_REFUND_CENTS}), 0)::bigint AS cents
       FROM pos_credit_memo cm
       WHERE ${CM_REFUND_SCOPE_SQL}
         AND ${CM_REFUND_DATE_COL} >= ? AND ${CM_REFUND_DATE_COL} < ?`,
      [from, to]
    ),
  ])
  return Number(billed.rows[0]?.cents ?? 0) - Number(refunded.rows[0]?.cents ?? 0)
}

/**
 * La variante SIN VENTANA, para `customers/top-performers`, cuya columna
 * `lifetime_revenue` tampoco la lleva. Su comentario ya deja la regla escrita:
 * "lifetime NO lleva ventana: su contraparte de ingreso tampoco la lleva".
 * Cero placeholders.
 */
export const SHIPPING_BY_CUSTOMER_LIFETIME_CTE = `
  ship_lifetime AS (
    SELECT axis_key, SUM(cents)::bigint AS shipping_cents
    FROM (
      SELECT i.customer_id AS axis_key, ${INVOICE_SHIPPING_CENTS} AS cents
      FROM pos_invoice i
      WHERE i.deleted_at IS NULL AND ${SALES_ACTIVE_STATUSES_SQL}
      UNION ALL
      SELECT cm.customer_id AS axis_key, -${CM_SHIPPING_REFUND_CENTS} AS cents
      FROM pos_credit_memo cm
      WHERE ${CM_REFUND_SCOPE_SQL}
    ) _ship
    GROUP BY axis_key
  )`

/**
 * Subconsulta que produce UNA fila `{cents, invoices}` con el flete NETO del
 * período — la materia prima de la fila sintética de `by-item`/`by-category`.
 *
 * Esas dos pantallas TOTALIZAN, y por eso el flete va como fila propia igual
 * que en *Sales by Item Summary* de QuickBooks. El ranking por SKU de
 * `sales/profit-summary` es otra cosa y deliberadamente NO la lleva: es un
 * `LIMIT 20` por margen, y una fila con COGS cero tendría margen 100%.
 *
 * Cuatro placeholders `?`: desde/hasta de FACTURAS, desde/hasta de DEVOLUCIONES.
 */
export const NET_SHIPPING_ROW_SQL = `
      SELECT COALESCE(SUM(cents), 0)::bigint            AS cents,
             COUNT(*) FILTER (WHERE cents <> 0)::int    AS invoices
      FROM (
        SELECT ${INVOICE_SHIPPING_CENTS} AS cents
        FROM pos_invoice i
        WHERE ${INVOICE_SCOPE_SQL}
        UNION ALL
        SELECT -${CM_SHIPPING_REFUND_CENTS}
        FROM pos_credit_memo cm
        WHERE ${CM_REFUND_SCOPE_SQL}
          AND ${CM_REFUND_DATE_COL} >= ? AND ${CM_REFUND_DATE_COL} < ?
      ) _s`
