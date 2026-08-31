/**
 * Derives the order-level separation state from per-line separated quantities.
 *
 *   none    — nothing separated
 *   partial — some open quantity separated, some not
 *   full    — every open line fully separated
 *
 * `metadata.is_separated` stays a boolean mirror of `full` so the Separated
 * tab, Meili derivation (is_separated && !closed && !fully_invoiced) and every
 * legacy reader keep working untouched.
 *
 * Legacy orders: `is_separated === true` with zero separation rows predates
 * per-line tracking — honored as `full` without migrating data.
 */

export type SeparationStatus = "none" | "partial" | "full";

/**
 * The Meili predicate behind the Separated tab — ONE literal, two consumers
 * (`orders/filter/route.ts` and `orders/counts/route.ts`).
 *
 * It filters `separation_state`, the tri-state indexed field, NOT `is_separated`:
 * that boolean is the mirror of `metadata.is_separated`, which is written only
 * for `full`, so a tab filtering on it could never show a partial separation —
 * two of the three live ones were invisible until 2026-08-13.
 *
 * Shared rather than written twice because a badge computing its own version of
 * a tab's membership is the list contradicting itself, and these two have
 * already been caught disagreeing once.
 */
export const SEPARATED_TAB_FILTER = 'separation_state IN ["partial", "full"]';

/**
 * Si el booleano `metadata.is_separated` puede hablar por esta orden.
 *
 * Sólo puede cuando la orden NO tiene ninguna fila en `order_line_separation`:
 * ahí el booleano es el único registro que existe de su separación y honrarlo
 * como `full` evita migrar datos. En cuanto hay una fila —aunque valga 0— el
 * registro por línea es la verdad y el booleano es un espejo, no una fuente.
 *
 * Vive acá, con un nombre, porque escrito en línea se escribió MAL: durante
 * meses los llamadores pasaban `metadata.is_separated` crudo, y como
 * `deriveSeparationStatus` toma la rama legacy cuando ninguna línea tiene
 * cantidad > 0, una orden con todas sus filas en CERO se hacía pasar por
 * legacy. Como la ruta de escritura estampa ese booleano al llegar a `full`,
 * el Save siguiente leía su propio rastro: **una orden que llegaba a `full` no
 * se podía des-apartar nunca más** (S11326 lo reportó el 2026-08-12 y se
 * atribuyó a órdenes viejas; lo alcanzaba a cualquiera).
 *
 * El único llamador que NO usa esto es la ruta de escritura, que pasa `false`
 * fijo porque está a punto de escribir filas.
 */
export function legacyFullFlagOf(
  isSeparatedMeta: boolean,
  hasSeparationRows: boolean
): boolean {
  return isSeparatedMeta && !hasSeparationRows;
}

export interface SeparationStatusLine {
  /** Order quantity of the line. */
  quantity: number;
  /** Fulfilled quantity (already out — needs no separation). */
  fulfilled: number;
  /** Separated quantity recorded for the line (0 when no row). */
  separated: number;
}

function nz(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export function deriveSeparationStatus(
  lines: SeparationStatusLine[],
  legacyFlag: boolean
): SeparationStatus {
  let open = 0;
  let separated = 0;
  let anyRow = false;

  for (const line of lines) {
    const lineOpen = Math.max(0, nz(line.quantity) - nz(line.fulfilled));
    const lineSep = Math.min(nz(line.separated), lineOpen);
    open += lineOpen;
    separated += lineSep;
    if (nz(line.separated) > 0) anyRow = true;
  }

  if (!anyRow) {
    // Pre-per-line orders carry only the boolean; keep honoring it.
    return legacyFlag ? "full" : "none";
  }
  if (open === 0) return "full";
  if (separated >= open) return "full";
  return separated > 0 ? "partial" : "none";
}
