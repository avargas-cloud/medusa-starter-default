import { suggestStatement } from "../../lib/banking/statement-suggest";
import type { SuggestParams } from "../../lib/banking/statement-suggest-types";
import type {
  StatementBookItem,
  StatementContext,
  StatementLine,
} from "../../lib/banking/statement-types";

/**
 * El casador como librería pura (plan bank-feed-suggestions-20260915). Fixtures sintéticos de
 * las formas que costaron aprender: cheque partido (varias líneas del banco = un asiento), neteo
 * de la procesadora (una línea = ventas − reembolsos), empate real → AMBIGUA sin asignar, y
 * línea ya casada → `none`. La paridad contra los borradores reales vive en
 * `e2e-bank-suggest-parity-sandbox.ts`; acá se afirma la forma de la salida.
 */
let seq = 0;
function line(day: string, amount_cents: number, description = "LINE"): StatementLine {
  seq += 1;
  return {
    id: `bsl_${seq}`,
    statement_id: "bst_1",
    external_key: `k${seq}`,
    day,
    amount_cents,
    description,
    transaction_id: null,
    source_hash: `lh${seq}`,
    source_snapshot: {},
    matched_cents: 0,
    remaining_cents: Math.abs(amount_cents),
    blockers: [],
  };
}
function book(day: string, amount_cents: number, reference: string, description = reference): StatementBookItem {
  seq += 1;
  return {
    kind: "journal_line",
    id: `bjl_${seq}`,
    day,
    reference,
    description,
    amount_cents,
    matched_cents: 0,
    remaining_cents: Math.abs(amount_cents),
    source_hash: `bh${seq}`,
    transaction_id: null,
    blockers: [],
  };
}
function context(lines: StatementLine[], items: StatementBookItem[], matches: StatementContext["matches"] = []): StatementContext {
  return {
    statement: {
      id: "bst_1", revision: 1, status: "draft", account_list_id: "acct", opening_id: null, predecessor_id: null,
      closed_by: null, closed_at: null, input_hash: null, closed_snapshot: null, history: [],
      bank_account_id: "bacct", from: "2026-09-01", to: "2026-09-15", reference: "t", evidence_id: "ev",
      opening_balance_cents: 0, closing_balance_cents: 0, declared_line_count: lines.length,
      declared_credits_cents: 0, declared_debits_cents: 0, completeness_attested: true,
    },
    lines,
    book_items: items,
    matches,
    blockers: [],
    difference_cents: 0,
    book_balance_cents: 0,
    deposits_in_transit_cents: 0,
    outstanding_disbursements_cents: 0,
    source_hash: "ctx",
    needs_review: false,
    coverage: "bank_account_period",
    global_ledger_coverage: "partial",
    zero_gl: true,
  };
}
const params: SuggestParams = { toleranceDays: 5, bpToleranceDays: 30, posCheckNo: new Map(), canceled: new Set() };

describe("suggestStatement", () => {
  it("cheque partido: varias líneas del banco del mismo día = un asiento (5c)", () => {
    const l1 = line("2026-09-03", -932000, "ATM WITHDRAWAL"), l2 = line("2026-09-03", -44000, "ATM WITHDRAWAL"), l3 = line("2026-09-03", -2000, "ATM WITHDRAWAL"), l4 = line("2026-09-03", -2000, "ATM WITHDRAWAL");
    const cash = book("2026-09-03", -980000, "QB Check 796 Cash");
    const plan = suggestStatement(context([l1, l2, l3, l4], [cash]), params);
    expect(plan.allocations).toHaveLength(4);
    expect(plan.allocations.every((a) => a.book_id === cash.id && a.expected_book_hash === cash.source_hash)).toBe(true);
    expect(plan.allocations.reduce((s, a) => s + a.amount_cents, 0)).toBe(980000);
    for (const l of [l1, l2, l3, l4]) expect(plan.by_line.get(l.id)).toMatchObject({ kind: "match", stage: "bank_sum" });
    expect(plan.ambiguous).toHaveLength(0);
  });

  it("neteo de la procesadora: una línea = ventas − reembolsos del día (5d), asientos completos", () => {
    const dep = line("2026-09-05", 344484, "MERCHANT BNKCD DEPOSIT");
    const sales = book("2026-09-04", 370400, "Sales receipt"), tip = book("2026-09-04", 2242, "Sales receipt 2");
    const r1 = book("2026-09-04", -7264, "Refund A"), r2 = book("2026-09-04", -9793, "Refund B"), r3 = book("2026-09-04", -11101, "Refund C");
    const plan = suggestStatement(context([dep], [sales, tip, r1, r2, r3]), params);
    const own = plan.allocations.filter((a) => a.statement_line_id === dep.id);
    expect(own).toHaveLength(5);
    expect(own.map((a) => a.amount_cents).sort((x, y) => x - y)).toEqual([2242, 7264, 9793, 11101, 370400]);
    expect(plan.by_line.get(dep.id)).toMatchObject({ kind: "match", stage: "book_net" });
    // Los asientos de signo opuesto a la línea van PRIMERO (trigger de capacidad con signo).
    const firstSameSide = plan.allocations.findIndex((a) => [sales.id, tip.id].includes(a.book_id));
    const lastOpposite = plan.allocations.map((a) => [r1.id, r2.id, r3.id].includes(a.book_id)).lastIndexOf(true);
    expect(lastOpposite).toBeLessThan(firstSameSide);
  });

  it("empate real (mismo monto, misma distancia, referencias distintas) → ambigua, sin asignar", () => {
    const l = line("2026-09-10", -150000, "CHECK PAID");
    const a = book("2026-09-08", -150000, "BP-1051 Vendor A"), b = book("2026-09-12", -150000, "BP-1062 Vendor A");
    const plan = suggestStatement(context([l], [a, b]), params);
    expect(plan.allocations).toHaveLength(0);
    const s = plan.by_line.get(l.id);
    expect(s?.kind).toBe("ambiguous");
    expect(s?.alternatives.map((c) => c.book_id).sort()).toEqual([a.id, b.id].sort());
    expect(plan.ambiguous).toHaveLength(1);
  });

  it("número de cheque manda sobre la fecha (5a) y el BP-#### se resuelve por el puente de QB", () => {
    const l = line("2026-09-14", -150000, "CHECK # 1072");
    const near = book("2026-09-13", -150000, "BP-1062 Vendor A"), far = book("2026-08-20", -150000, "BP-1051 Vendor A");
    const plan = suggestStatement(context([l], [near, far]), { ...params, posCheckNo: new Map([["BP-1051 Vendor A", "1072"]]) });
    expect(plan.allocations).toEqual([
      { statement_line_id: l.id, book_kind: "journal_line", book_id: far.id, amount_cents: 150000, expected_book_hash: far.source_hash },
    ]);
    expect(plan.by_line.get(l.id)).toMatchObject({ kind: "match", stage: "check_number" });
  });

  it("línea ya casada → none; asiento anulado → nunca se propone", () => {
    const done = line("2026-09-02", -5000), open = line("2026-09-06", -7000);
    const b1 = book("2026-09-02", -5000, "X"), voided = book("2026-09-06", -7000, "Y");
    const plan = suggestStatement(
      context([done, open], [b1, voided], [{ id: "bsm_1", statement_line_id: done.id, book_kind: "journal_line", book_id: b1.id, amount_cents: 5000, book_hash: b1.source_hash, line_hash: done.source_hash }]),
      { ...params, canceled: new Set([voided.id]) }
    );
    expect(plan.allocations).toHaveLength(0);
    expect(plan.by_line.get(done.id)?.kind).toBe("none");
    expect(plan.by_line.get(open.id)?.kind).toBe("none");
  });
});
