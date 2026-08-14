/**
 * src/modules/invoices/models/rounding-adjustment.ts
 *
 * Ajuste de redondeo: cómo se saldó el residuo de centavos que deja una orden
 * facturada en partes. La lógica y el porqué viven en `lib/rounding/write-off.ts`.
 *
 * NO es un pago y NO es una aplicación de pago:
 *
 *   - un `customer_payment` es plata que entró,
 *   - un `payment_application` dice dónde aterrizó esa plata (impacto CERO en el
 *     balance del cliente — no mueve dinero, sólo lo ubica),
 *   - esta fila es un asiento de AJUSTE que SÍ mueve el balance: cancela un
 *     residuo que nadie va a pagar (o que sobró) contra una cuenta de resultados.
 *
 * Guardarlo como un pago de un centavo —que es como se venía conciliando a
 * mano— mete plata inventada en el historial del cliente: alguien que audite esa
 * cuenta corriente ve un cobro que nunca ocurrió. Por eso tiene tabla propia.
 *
 * La factura NUNCA se edita. Es un snapshot fiscal inmutable: se salda, no se
 * reescribe.
 */

import { model } from "@medusajs/utils";

const RoundingAdjustment = model.define("pos_rounding_adjustment", {
  id: model.id({ prefix: "radj" }).primaryKey(),

  /**
   * Objetivo del ajuste. Exactamente UNO de los dos según la dirección:
   *
   *   shortage → `invoice_id`: la factura pide más de lo que entró, y este
   *              asiento cierra su `balance_due`.
   *   overage  → `payment_id`: entró más de lo que las facturas piden, y este
   *              asiento consume el sobrante del pago.
   *
   * El CHECK de la migración impone el "exactamente uno" — un modelo que
   * permitiera los dos o ninguno haría que el lector tuviera que adivinar a qué
   * documento pertenece el ajuste.
   */
  invoice_id: model.text().nullable(),
  payment_id: model.text().nullable(),
  /** Orden de origen. Informativo: sirve para reportar por orden sin joins. */
  order_id: model.text().nullable(),

  /**
   * Monto en CENTAVOS, SIEMPRE POSITIVO — `direction` carga el signo contable.
   *
   * (Las columnas de dinero del POS son cents; las de `order` de Medusa son
   * dólares. Acá son cents, y nunca pasan de `ROUNDING_WRITE_OFF_CAP_CENTS`.)
   *
   * Es `number` y no `bigNumber` a propósito: un valor de 1 a 5 centavos no
   * necesita precisión arbitraria, y `bigNumber` arrastraría una columna
   * `raw_amount_cents` espejo que hay que mantener sincronizada a mano en todo
   * fix de SQL — un footgun conocido a cambio de cero beneficio acá.
   */
  amount_cents: model.number(),

  direction: model.enum(["shortage", "overage"]),

  /** ListID de la subcuenta de QuickBooks donde cayó. Congelado al emitir. */
  account_list_id: model.text(),

  /** Motivo. Hoy siempre `tax_rounding_partial_invoice`. */
  reason_code: model.text(),

  /** Memo que viajó a QuickBooks — distingue el asiento de un descuadre de caja. */
  memo: model.text().nullable(),

  /** Quién lo originó (email del admin, o el job que lo emitió). */
  actor: model.text().nullable(),

  /**
   * Estado de la pata contable en QuickBooks. La fila local es autoritativa para
   * el POS y NO espera a QB: si QB rechaza, esto queda `failed`, el digest lo
   * levanta, y la factura conserva su residual — que es el estado de hoy. Marcar
   * `confirmed` exige haber POLLEADO el resultado del bridge, nunca el encolado.
   *
   * `skipped` = el mecanismo estaba apagado (sin cuentas configuradas) cuando se
   * emitió, así que no hay nada que esperar de QuickBooks.
   */
  qb_status: model
    .enum(["pending", "confirmed", "failed", "skipped"])
    .default("pending"),
  qb_op_id: model.text().nullable(),
  qb_error: model.text().nullable(),

  /** Reversión. Un ajuste nunca se borra: se anula dejando la fila. */
  voided_at: model.dateTime().nullable(),
  void_reason: model.text().nullable(),
  voided_by: model.text().nullable(),

  metadata: model.json().nullable(),
});

export default RoundingAdjustment;
