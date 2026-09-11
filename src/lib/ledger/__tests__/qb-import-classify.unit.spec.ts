import { BANK_SIDE_TYPES, classify, policyFor, POS_CUTOFF_DAY, POS_OWNED_TYPES } from "../qb-import";

describe("qb-import classify (regla de no doble conteo)", () => {
  it("el corte es el día anterior al replay del GL (2026-04-14)", () => {
    expect(POS_CUTOFF_DAY).toBe("2026-04-13");
  });

  it("las dos tablas son disjuntas", () => {
    for (const t of POS_OWNED_TYPES) expect(BANK_SIDE_TYPES.has(t)).toBe(false);
  });

  it("tipo del POS: entra hasta el corte inclusive; después se omite SOLO si el POS lo sincronizó", () => {
    expect(classify("Invoice", "2026-01-15")).toEqual({ action: "import", policy: "pos_owned" });
    expect(classify("Invoice", "2026-04-13", undefined, true)).toEqual({ action: "import", policy: "pos_owned" });
    // el POS conoce el TxnID → lo postea el replay → se omite
    expect(classify("Invoice", "2026-04-14", undefined, true)).toEqual({ action: "skip_pos_owned_after_cutoff", policy: "pos_owned" });
    // hecho directo en QB (0 de 10 Bill Pmt -Check conocidos, medido) → entra desde QB
    expect(classify("Bill Pmt -Check", "2026-09-01", undefined, false)).toEqual({ action: "import", policy: "pos_owned", qb_only: true });
    // sin dato de enlace: no contar dos veces vale más que importar de más
    expect(classify("Invoice", "2026-04-14")).toEqual({ action: "skip_pos_owned_after_cutoff", policy: "pos_owned" });
  });

  it("tipo bancario: entra todo el año salvo que el POS lo haya sincronizado (cheque de refund)", () => {
    for (const t of ["Check", "Deposit", "Credit Card Charge", "General Journal", "Transfer", "Inventory Adjust"]) {
      expect(classify(t, "2026-01-02")).toEqual({ action: "import", policy: "bank_side" });
      expect(classify(t, "2026-09-11")).toEqual({ action: "import", policy: "bank_side" });
      expect(classify(t, "2026-09-11", undefined, false)).toEqual({ action: "import", policy: "bank_side" });
    }
    expect(classify("Check", "2026-09-11", undefined, true)).toEqual({ action: "skip_pos_owned_after_cutoff", policy: "bank_side" });
    // antes del corte el enlace no importa: el replay no llega ahí
    expect(classify("Check", "2026-03-01", undefined, true)).toEqual({ action: "import", policy: "bank_side" });
  });

  it("el corte es parametrizable (apertura al 2025-12-31 → todo 2026 desde QB)", () => {
    expect(classify("Sales Receipt", "2026-06-01", "2026-12-31")).toEqual({ action: "import", policy: "pos_owned" });
  });

  it("un tipo que el diseño no nombró se bloquea, nunca se adivina", () => {
    expect(policyFor("Build Assembly")).toBeNull();
    expect(classify("Build Assembly", "2026-02-01")).toEqual({ action: "blocked_unknown_type" });
    expect(classify("", "2026-02-01")).toEqual({ action: "blocked_unknown_type" });
  });
});
