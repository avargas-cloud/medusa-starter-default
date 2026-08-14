/**
 * src/lib/rounding/write-off.ts
 *
 * Write-off del residuo de redondeo de una orden facturada en partes.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────
 * El sales tax se redondea al centavo UNA VEZ POR FACTURA, y
 * `Σ round(baseᵢ × tasa) ≠ round(Σ baseᵢ × tasa)`. Partir una orden en dos
 * facturas deja entonces una diferencia de centavos contra lo que se cobró:
 *
 *   orden entera (42u): 827.92 × 7% = 57.9544 → 57.95   (redondea ABAJO)
 *   factura A   (10u): 197.12 × 7% = 13.7984 → 13.80   (redondea ARRIBA)
 *   factura B   (32u): 630.80 × 7% = 44.1560 → 44.16   (redondea ARRIBA)
 *                                              ───────
 *                                    A + B  =   57.96  → un centavo de más
 *
 * Florida §212.12(10) computa el tax POR FACTURA, así que 13.80 y 44.16 son los
 * dos correctos: 57.96 es el tax que legalmente se remite. El centavo NO es un
 * error de cálculo — es el resultado correcto de haber emitido dos facturas.
 *
 * Por eso este módulo NO toca la factura. La factura es un snapshot inmutable:
 * se SALDA, no se edita. Lo que se ajusta es cómo se canceló el residuo.
 *
 * ── Por qué no se corrige moviendo el descuento ───────────────────────────────
 * El mecanismo anterior (`reconciliationResult` en el POS) absorbía la variancia
 * en el descuento a nivel orden. Además de ser el mecanismo de MAYOR riesgo de
 * auditoría (el documento declara "Order Discount (5%)" sobre un valor que no es
 * el 5% de la línea), es matemáticamente incapaz de acertar justo en los casos
 * que generan el problema — porque el desvío existe PRECISAMENTE cuando las
 * fracciones caen en el borde del redondeo:
 *
 *   base 91650 → tax 6415.5 → 64.16 → total 98066   (sobra 1)
 *   base 91649 → tax 6415.4 → 64.15 → total 98064   (falta 1)
 *                                     objetivo 98065  ← INALCANZABLE
 *
 * Bajar la base cruza el borde, el tax se cae un centavo, y el total SALTEA el
 * número buscado. Caso real: orden S10684.
 *
 * ── El tope es la protección, no un gate humano ───────────────────────────────
 * No hay PIN ni override. Un gate humano sobre un ajuste automático de un centavo
 * garantiza que nadie lo lea, y un ajuste sin límite es riesgo de auditoría alto
 * aunque cada caso individual sea trivial. La protección es un TOPE DURO más la
 * auditoría completa de cada fila (actor, motivo, factura, cuenta).
 *
 * Techo derivado: N facturas parciales de una orden desvían como máximo
 * N × 0.5¢ (cada redondeo se aleja a lo sumo medio centavo del valor exacto).
 * CAP = 5¢ cubre hasta diez facturas parciales con margen. Por encima de eso NO
 * es redondeo — es otro problema, y absorberlo lo taparía.
 */

/**
 * Tope duro del write-off automático, en centavos. Sin override: por encima el
 * residuo se RECHAZA y se expone. Ver el techo derivado en el docstring del módulo.
 */
export const ROUNDING_WRITE_OFF_CAP_CENTS = 5;

/** Motivo único que llevan las filas emitidas por este mecanismo. */
export const ROUNDING_REASON_CODE = "tax_rounding_partial_invoice" as const;

/**
 * Dirección del residuo, desde el punto de vista de la caja:
 *
 * - `shortage` — la factura pide MÁS de lo que entró. Vinimos cortos y lo
 *   absorbemos. Postea a `Cash Discrepancies:Shortages` (ingreso negativo) y
 *   cierra LA FACTURA.
 * - `overage` — entró MÁS de lo que las facturas piden. Sobra plata sin factura
 *   donde aplicarla. Postea a `Cash Discrepancies:Overages` (ingreso positivo)
 *   y cierra EL PAGO.
 *
 * Las dos direcciones ocurren: cuál sale depende de si las fracciones del tax
 * redondearon arriba o abajo, que es azar aritmético y no una regla. Un
 * mecanismo que sólo supiera absorber en una dirección se cuelga la primera vez
 * que toca el otro lado.
 */
export type RoundingDirection = "shortage" | "overage";

export type RoundingResolution =
  /** Sin residuo: no se emite nada. Es el caso del 99% de las facturas. */
  | { kind: "none" }
  /** Residuo dentro del tope: se absorbe. */
  | {
      kind: "writeoff";
      direction: RoundingDirection;
      /** SIEMPRE positivo — la dirección ya carga el signo contable. */
      amountCents: number;
      accountKey: RoundingAccountKey;
    }
  /** Fuera del tope o entrada inválida: NO se absorbe, se expone. */
  | { kind: "refused"; residualCents: number; reason: string };

/**
 * Dirección → clave de la config. Las cuentas viven en `store.metadata`
 * (`./config.ts`), NO en env: una env var se pierde al reiniciar y no deja
 * rastro — pasó dos veces durante el desarrollo.
 */
export type RoundingAccountKey = "shortage" | "overage";

/**
 * Decide qué hacer con el residuo de una factura.
 *
 * @param residualCents `total de la factura − Σ aplicado`, en CENTAVOS enteros.
 *   Positivo = la factura pide más de lo que entró (shortage).
 *   Negativo = entró más de lo que la factura pide (overage).
 *
 * Función pura: no lee env, no toca la DB, no habla con QuickBooks. Todo lo que
 * decide sale del argumento, para que las cuatro ramas se puedan testear sin
 * montar nada.
 */
export function resolveRoundingResidual(
  residualCents: number
): RoundingResolution {
  if (!Number.isFinite(residualCents)) {
    return {
      kind: "refused",
      residualCents: 0,
      reason: "residual no es un número finito",
    };
  }

  // Centavos son enteros. Un fraccionario acá significa que alguien pasó
  // dólares, o que una resta de BigNumber se coló sin coercionar — y redondearlo
  // en silencio convertiría un bug de unidades en un ajuste contable.
  if (!Number.isInteger(residualCents)) {
    return {
      kind: "refused",
      residualCents,
      reason: `residual debe ser un entero de centavos, llegó ${residualCents}`,
    };
  }

  if (residualCents === 0) return { kind: "none" };

  const magnitude = Math.abs(residualCents);

  if (magnitude > ROUNDING_WRITE_OFF_CAP_CENTS) {
    return {
      kind: "refused",
      residualCents,
      reason:
        `residual de ${magnitude}¢ supera el tope de ` +
        `${ROUNDING_WRITE_OFF_CAP_CENTS}¢ — no es redondeo de tax`,
    };
  }

  return residualCents > 0
    ? {
        kind: "writeoff",
        direction: "shortage",
        amountCents: magnitude,
        accountKey: "shortage",
      }
    : {
        kind: "writeoff",
        direction: "overage",
        amountCents: magnitude,
        accountKey: "overage",
      };
}

/**
 * Memo que viaja a QuickBooks. Es lo único que distingue, leyendo el registro de
 * la cuenta, un redondeo de tax de un descuadre real de caja — que es el precio
 * de compartir las subcuentas existentes en vez de crear un par dedicado.
 *
 * Dice "Rounding", no "Tax rounding": el residuo lo puede producir el redondeo del
 * DESCUENTO igual que el del tax. Y queda simétrico con el memo del overage
 * (`Rounding - PAY ####`), que es lo que permite barrer los dos con un solo
 * patrón al conciliar el registro de las cuentas.
 *
 * ASCII puro, deliberadamente. El `escapeXml` del bridge translitera el no-ASCII
 * (un em dash sale del otro lado como `-`), así que un memo con caracteres
 * lindos quedaría guardado acá de una forma y visible en QuickBooks de otra —
 * justo en el campo que existe para que los dos lados se puedan cruzar. Además,
 * un carácter no-ASCII pegado desde Word (un U+00A0) ya tumbó un request entero
 * de este bridge: no hay upside que justifique el riesgo en un memo.
 */
export function buildRoundingMemo(invoiceNumber: string | number): string {
  return `Rounding - INV ${invoiceNumber}`;
}
