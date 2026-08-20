/**
 * Los fragmentos SQL que definen los hechos de la separación, escritos UNA vez.
 *
 * Dos consultas distintas alimentan la misma verdad: `separation-data.ts` (el
 * modal y el camino de escritura) y `separation-availability.ts` (la lista de
 * órdenes). Comparten `computeSeparationCaps` desde el principio, así que la
 * ARITMÉTICA nunca estuvo duplicada — pero cada una traía sus propias columnas
 * con su propio SQL, y ahí sí había dos copias.
 *
 * El 2026-08-20 eso costó un bug en producción el mismo día que shipeó: netear
 * `separated` por lo entregado entró en el modal y no en la lista, y S11320
 * (LEG-AALSL6: 9 ordenadas, 1 entregada, 8 apartadas) mostró ámbar por la
 * última unidad en el modal y ningún `To Separate` en la fila. Dos archivos,
 * una regla, un solo lugar editado.
 *
 * Regla: si los dos lados necesitan el mismo hecho, el hecho vive acá y se
 * interpola. Un cambio de definición pasa a ser UNA edición, y las dos
 * consultas no pueden divergir aunque alguien se olvide de la otra.
 *
 * SIN SIGNOS DE PREGUNTA, ni en el SQL ni en estos comentarios: uno de los
 * consumidores es knex, que trata cada `?` como binding posicional. El otro es
 * el pool de pg con `$1`. Los fragmentos no llevan placeholders de ningún tipo
 * — sólo expresiones de columna — y por eso sirven a los dos.
 */

/**
 * Unidades de una línea cubiertas por un fulfillment VIVO.
 *
 * Nunca `order_item.fulfilled_quantity`: Medusa escribe ese agregado hacia
 * adelante y no lo revierte, así que un fulfillment cancelado y borrado deja sus
 * unidades contadas para siempre. Medido en producción el 2026-08-20: mal en 25
 * líneas de 6 órdenes. En la lista el daño es peor que un número feo — un
 * `fulfilled` inflado hace que una separación viva parezca despachada, su
 * reclamo sale del pool cross-orden, y otra orden se lleva unidades que están
 * en el estante.
 *
 * `orderCol` y `lineCol` son las expresiones de columna en scope donde se
 * interpola (por ejemplo `oi.order_id` y `oli.id`).
 */
export function liveFulfilledSql(orderCol: string, lineCol: string): string {
  return `
  COALESCE((
    SELECT SUM(ffi.quantity)
      FROM order_fulfillment ofl
      JOIN fulfillment f
        ON f.id = ofl.fulfillment_id
       AND f.canceled_at IS NULL
       AND f.deleted_at IS NULL
      JOIN fulfillment_item ffi
        ON ffi.fulfillment_id = f.id
       AND ffi.deleted_at IS NULL
     WHERE ofl.order_id = ${orderCol}
       AND ofl.deleted_at IS NULL
       AND ffi.line_item_id = ${lineCol}
  ), 0)`;
}

/**
 * La separación de una línea NETA de lo que ya salió del depósito.
 *
 * La columna `order_line_separation.qty` es una marca corrida que nadie
 * decrementa al despachar, así que una línea cuyas unidades apartadas se
 * entregaron seguía anunciándolas para siempre. Todo lector ve el valor neteado;
 * `clearDeliveredSeparations` además lleva a 0 las líneas totalmente entregadas,
 * y el próximo Save persiste el neto.
 *
 * `sepCol` es la expresión de la cantidad guardada (por ejemplo `sep.qty`).
 */
export function netSeparatedSql(
  sepCol: string,
  orderCol: string,
  lineCol: string
): string {
  return `GREATEST(0, COALESCE(${sepCol}, 0) - ${liveFulfilledSql(
    orderCol,
    lineCol
  )})`;
}
