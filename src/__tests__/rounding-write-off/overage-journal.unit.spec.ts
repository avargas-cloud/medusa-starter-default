/**
 * El payload del asiento de overage.
 *
 * Lo que cuidan estos tests es que el asiento **balancee** y que lleve el
 * `EntityRef`: sin el cliente, el movimiento de A/R no se imputa a nadie y el
 * crédito que sobraba sigue colgado en su cuenta corriente. Un asiento así
 * "funciona" —QuickBooks lo acepta— y no arregla nada.
 */

import { buildOverageJournal } from "../../lib/rounding/overage-qb";

const AR = "80000047-1331073116";
const OVERAGES = "80000100-1454537520";

const BASE = {
  amountCents: 1,
  customerListId: "80001777-1605105028",
  overageAccountListId: OVERAGES,
  date: "2026-08-13",
  memo: "Rounding - PAY 3420",
};

describe("buildOverageJournal", () => {
  it("debita A/R y acredita Overages por el mismo monto", () => {
    const p = buildOverageJournal(BASE, AR);
    expect(p.debitLines[0]?.accountListId).toBe(AR);
    expect(p.creditLines[0]?.accountListId).toBe(OVERAGES);
    expect(p.debitLines[0]?.amount).toBe(0.01);
    expect(p.creditLines[0]?.amount).toBe(0.01);
  });

  it("BALANCEA — débitos y créditos suman igual", () => {
    const p = buildOverageJournal({ ...BASE, amountCents: 4 }, AR);
    const sum = (ls: Array<{ amount: number }>) =>
      Math.round(ls.reduce((t, l) => t + l.amount, 0) * 100);
    expect(sum(p.debitLines)).toBe(sum(p.creditLines));
  });

  it("la línea de A/R lleva EntityRef — sin él no cancela el crédito de nadie", () => {
    const p = buildOverageJournal(BASE, AR);
    expect(p.debitLines[0]?.entityListId).toBe(BASE.customerListId);
  });

  it("la línea de ingreso NO lleva EntityRef (no es un movimiento de cliente)", () => {
    const p = buildOverageJournal(BASE, AR);
    expect((p.creditLines[0] as any).entityListId).toBeUndefined();
  });

  it("lleva fecha explícita — sin ella QB estampa el reloj de su propia PC", () => {
    expect(buildOverageJournal(BASE, AR).date).toBe("2026-08-13");
  });

  it("el memo viaja en las dos líneas", () => {
    const p = buildOverageJournal(BASE, AR);
    expect(p.debitLines[0]?.memo).toBe(BASE.memo);
    expect(p.creditLines[0]?.memo).toBe(BASE.memo);
  });

  it("TIRA sin cliente en vez de emitir un asiento que no imputa a nadie", () => {
    expect(() =>
      buildOverageJournal({ ...BASE, customerListId: "" }, AR)
    ).toThrow(/ListID del cliente/);
  });

  it("TIRA si falta una cuenta", () => {
    expect(() => buildOverageJournal(BASE, "")).toThrow(/cuentas/);
    expect(() =>
      buildOverageJournal({ ...BASE, overageAccountListId: "" }, AR)
    ).toThrow(/cuentas/);
  });

  it("TIRA con monto no entero, cero o negativo", () => {
    for (const bad of [0, -1, 0.5, Number.NaN]) {
      expect(() =>
        buildOverageJournal({ ...BASE, amountCents: bad }, AR)
      ).toThrow(/monto inválido/);
    }
  });
});
