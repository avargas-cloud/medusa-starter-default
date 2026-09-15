import { diffControlAccount, type PosContribution, type QbContribution } from "../qb-import/ar-ap-diff";

const q = (txn_id: string, date: string, cents: number, txn_type = "Invoice"): QbContribution => ({ txn_id, txn_type, date, ref_number: null, name: null, cents: BigInt(cents) });
const p = (txn_id: string | null, day: string, cents: number, source_kind = "pos_invoice"): PosContribution => ({ entry_id: `e_${Math.random()}`, source_kind, source_id: "x", document_number: null, day, txn_id, cents: BigInt(cents) });

describe("diffControlAccount (arap-parity-20260915)", () => {
  it("iguales por TxnID → sin residuos; totales y Δ en cero", () => {
    const r = diffControlAccount([q("A", "2026-01-05", 1000), q("B", "2026-01-06", -400)], [p("A", "2026-01-05", 1000), p("B", "2026-01-06", -400)]);
    expect(r.delta).toBe(0n); expect(r.residuals).toEqual([]); expect(r.matched).toBe(2);
  });
  it("clasifica amount_differs / qb_only / pos_only (con y sin TxnID) y suma Δ = QB − POS", () => {
    const r = diffControlAccount(
      [q("A", "2026-04-05", 1000), q("Q", "2026-04-06", 250, "Invoice")],
      [p("A", "2026-04-05", 900), p("P", "2026-04-07", 300), p(null, "2026-04-08", -90, "journal_entry")]
    );
    expect(r.residuals.map((x) => [x.klass, x.txn_id, Number(x.delta_cents)]).sort()).toEqual([
      ["amount_differs", "A", 100], ["pos_only", "P", -300], ["pos_only", null, 90], ["qb_only", "Q", 250],
    ].sort());
    expect(Number(r.delta)).toBe(1250 - 1110);
    expect(r.residuals.reduce((s, x) => s + Number(x.delta_cents), 0)).toBe(Number(r.delta));
  });
  it("mismo monto en otro mes → date_differs, Δ 0, y el mes lo refleja", () => {
    const r = diffControlAccount([q("A", "2026-05-31", 500)], [p("A", "2026-06-01", 500)]);
    expect(r.residuals).toHaveLength(1); expect(r.residuals[0]!.klass).toBe("date_differs"); expect(r.delta).toBe(0n);
    expect(r.byMonth).toEqual([{ month: "2026-05", qb: 500n, pos: 0n, delta: 500n }, { month: "2026-06", qb: 0n, pos: 500n, delta: -500n }]);
  });
  it("varias líneas QB y varios documentos POS con el mismo TxnID se agregan antes de comparar", () => {
    const r = diffControlAccount([q("A", "2026-02-01", 600), q("A", "2026-02-01", 400)], [p("A", "2026-02-01", 700, "pos_invoice"), p("A", "2026-02-01", 300, "rounding_adjustment")]);
    expect(r.residuals).toEqual([]); expect(r.matched).toBe(1);
  });
});
