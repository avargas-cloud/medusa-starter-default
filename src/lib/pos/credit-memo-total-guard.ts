/**
 * src/lib/pos/credit-memo-total-guard.ts
 *
 * Un credit memo acredita dinero al cliente: su total tiene que ser POSITIVO.
 *
 * Por qué existe (2026-09-17, CM-1173/CM-1174 de la orden 2577): una devolución
 * PARCIAL heredó el descuento de orden de la factura como monto FIJO entero
 * (−$198.61 sobre $154.98 de ítems). El POS clampeó el total a $0.00 y lo
 * guardó; `complete` emitió el store credit por el SUBTOTAL (fallback
 * `total || subtotal`), el GL registró `Sales Discounts −198.61`, y QuickBooks
 * rechazó el documento con 3180 "Transaction amount must be positive". Tres
 * capas con tres números distintos para el mismo documento, y ninguna avisó.
 *
 * La regla vive acá, compartida por `sync` (el draft), `complete` (la
 * transición que emite el crédito) y `edit` (la corrección de uno completado):
 * un guard en la pantalla no protege la operación.
 */

export interface CreditMemoTotalsCents {
  subtotal: number;
  discount: number;
  shipping: number;
  tax: number;
  total: number;
}

const dollars = (cents: number): string => (cents / 100).toFixed(2);

/**
 * Devuelve el mensaje de rechazo, o `null` si los totales son válidos.
 * Los montos llegan en CENTAVOS (como se persisten en `pos_credit_memo`).
 */
export function creditMemoTotalViolation(
  t: CreditMemoTotalsCents
): string | null {
  const subtotal = Number(t.subtotal ?? 0);
  const discount = Number(t.discount ?? 0);
  const total = Number(t.total ?? 0);

  if (discount > subtotal) {
    return (
      `Credit memo total must be positive: the order discount $${dollars(discount)} ` +
      `exceeds the returned items $${dollars(subtotal)}. ` +
      `Reduce or remove the discount before saving.`
    );
  }
  if (total <= 0) {
    return `Credit memo total must be positive (got $${dollars(total)}).`;
  }
  return null;
}
