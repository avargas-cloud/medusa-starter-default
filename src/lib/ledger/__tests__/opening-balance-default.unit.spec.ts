import { DEFAULT_OPENING_DAY } from "../documents/opening-balance";
import { POS_CUTOFF_DAY } from "../qb-import";

/**
 * Corte del libro (decisión 2026-09-11, docs/QB_GL_IMPORT.md §3): la apertura
 * por cuenta va al cierre del ejercicio anterior porque todo 2026 entra al
 * libro desde el reporte General Ledger de QuickBooks. Este spec existe para
 * que mover la fecha sea una decisión explícita y no un efecto colateral.
 */
describe("apertura del libro (DEFAULT_OPENING_DAY)", () => {
  it("la apertura por default es el cierre 2025-12-31", () => {
    expect(DEFAULT_OPENING_DAY).toBe("2025-12-31");
  });

  it("la apertura queda antes del corte de tipos del POS y del replay del GL", () => {
    expect(DEFAULT_OPENING_DAY < POS_CUTOFF_DAY).toBe(true);
    expect(DEFAULT_OPENING_DAY < "2026-04-14").toBe(true); // GL_REPLAY_FROM (jobs/ledger-reconciler.ts)
  });
});
