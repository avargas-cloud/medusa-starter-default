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
