/**
 * Ingreso NETO por línea de factura — la única forma canónica de repartir el
 * dinero de un documento entre sus ítems.
 *
 * ## Qué se arregló (2026-09-01) y por qué importaba
 *
 * La versión anterior era:
 *
 *   pii.total * i.subtotal / (i.subtotal + i.discount)
 *
 * y su comentario decía "distribuye el descuento de orden proporcionalmente".
 * Dos cosas estaban mal:
 *
 *  1. `pii.total` es **BRUTO** — es literalmente `unit_price × quantity`
 *     (verificado: se cumple en 188 de 188 líneas con descuento de ítem). El
 *     neto post-descuento-de-línea vive en `pii.net_total_cents`, congelado al
 *     emitir la factura, que es lo que el sync a QuickBooks ya lee.
 *
 *  2. `i.discount` **no es sólo el descuento de orden**: agrega los descuentos
 *     de ÍTEM y el de ORDEN. Al repartir ese total por peso BRUTO, el descuento
 *     que recibió UNA línea se esparcía sobre TODAS.
 *
 * El total de la factura salía bien igual (Σ = i.subtotal por construcción), y
 * por eso vivió sin que nadie lo notara: lo que estaba mal era la ATRIBUCIÓN.
 * Un ítem con 50% off se reportaba a $59.94 cuando le correspondían $30.38, y
 * uno regalado al 100% recibía ingreso que en realidad pagaron sus vecinos.
 * Medido sobre 66 facturas / 311 líneas: $2,324.02 mal atribuidos.
 *
 * ## La forma correcta
 *
 *   neto_línea × i.subtotal / Σ(neto_línea de esa factura)
 *
 * El numerador ya trae descontado el descuento de ÍTEM, así que el cociente
 * reparte únicamente el de ORDEN — y lo hace por peso NETO, que es el peso con
 * el que cada línea realmente contribuye. Sigue valiendo Σ = i.subtotal, o sea
 * que ningún total se mueve; sólo se acomoda quién aporta cuánto.
 *
 * ## Por qué una subconsulta y no una window function
 *
 * El denominador es un agregado por factura. Una window function
 * (`SUM(...) OVER (PARTITION BY ...)`) sería lo natural, pero **las rutas
 * consumidoras hacen `SUM(${NET_ITEM_REVENUE})`** y Postgres rechaza un
 * agregado que contenga una window. Una subconsulta escalar correlacionada sí
 * es válida ahí dentro, y además deja la expresión como reemplazo directo: las
 * 10 rutas de sales/ y purchases/ que ya la usaban quedan corregidas sin
 * tocarlas.
 *
 * ## Facturas legacy
 *
 * `net_total_cents` existe desde 2026-04-14. Quedan 7 líneas anteriores sin el
 * campo (0.1%), y **ninguna tiene descuento de ítem**, así que para ellas
 * `COALESCE` cae en `pii.total` y el resultado es idéntico al de antes. El
 * arreglo cubre el 100% de las facturas realmente afectadas sin backfill.
 */


/** Neto de la línea post-descuento de ÍTEM, pre-descuento de ORDEN, en centavos. */
export const LINE_NET_CENTS = `COALESCE(pii.net_total_cents, pii.total)`

/**
 * Σ de los netos de la factura a la que pertenece `pii`. Correlacionada a
 * propósito — ver el encabezado. Repite el filtro `deleted_at IS NULL` porque
 * una línea borrada no aporta al neto que `i.subtotal` representa.
 */
const INVOICE_NET_SUM = `(
  SELECT SUM(COALESCE(x.net_total_cents, x.total))
  FROM pos_invoice_item x
  WHERE x.invoice_id = pii.invoice_id AND x.deleted_at IS NULL
)`

/**
 * Ingreso neto atribuible a esta línea: su neto, menos la parte del descuento
 * de ORDEN que le toca por peso neto. Σ sobre una factura === `i.subtotal`.
 *
 * Requiere los alias `pii` (pos_invoice_item) e `i` (pos_invoice) en scope.
 */
export const NET_ITEM_REVENUE = `
  CASE WHEN ${INVOICE_NET_SUM} > 0
    THEN ${LINE_NET_CENTS}::numeric * i.subtotal::numeric / ${INVOICE_NET_SUM}::numeric
    ELSE ${LINE_NET_CENTS}::numeric
  END
`
