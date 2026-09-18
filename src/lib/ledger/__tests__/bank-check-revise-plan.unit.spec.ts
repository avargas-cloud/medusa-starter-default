import { planMatchCarryOver } from "../documents/bank-check-revise";
import { LedgerError } from "../types";

/**
 * check-revise-20260918 — el plan PURO del carry-over de matches de extracto
 * cuando un cheque posteado se corrige en el lugar. Sólo se llevan los matches
 * de un BORRADOR y sólo si, para el banco, la línea nueva es la misma cosa:
 * misma cuenta, mismo monto con signo, día dentro del extracto. Todo lo demás
 * → `entry_matched` (descasar primero, botón Corregir del Bank Feed).
 */
const oldLine = { id: "bjl_old", entry_id: "bje_old", account_list_id: "80000167-1", amount_cents: -6000, source_hash: "h1" };
const newLine = { id: "bjl_new", entry_id: "bje_new", account_list_id: "80000167-1", amount_cents: -6000, source_hash: "h2" };
const match = {
  id: "bsm_1",
  statement_id: "bst_sept",
  statement_line_id: "bsl_1",
  amount_cents: 6000,
  line_hash: "lh",
  statement_status: "draft",
  statement_account_list_id: "80000167-1",
  statement_to_day: "2026-09-30",
};

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof LedgerError && error.code === "GL_SOURCE_INVALID")
      return (error.details as { reason: string }).reason;
    throw error;
  }
  throw new Error("expected GL_SOURCE_INVALID");
}

describe("planMatchCarryOver", () => {
  it("no matches → nothing to carry (the common case: an unmatched check)", () => {
    expect(planMatchCarryOver([], oldLine, newLine, "2026-09-01")).toEqual({ carry: [] });
    expect(planMatchCarryOver([], null, null, "2026-09-01")).toEqual({ carry: [] });
  });

  it("carries a draft match when bank account, signed amount and statement window are unchanged", () => {
    expect(planMatchCarryOver([match], oldLine, newLine, "2026-09-03")).toEqual({ carry: [match] });
  });

  it("refuses when the amount changed (the bank line is no longer the same thing)", () => {
    expect(reasonOf(() => planMatchCarryOver([match], oldLine, { ...newLine, amount_cents: -6500 }, "2026-09-01"))).toBe(
      "entry_matched"
    );
  });

  it("refuses when the paying account changed, even to another account of the same type", () => {
    expect(
      reasonOf(() => planMatchCarryOver([match], oldLine, { ...newLine, account_list_id: "80000168-1" }, "2026-09-01"))
    ).toBe("entry_matched");
  });

  it("refuses when the new day falls after the statement's `to` (the book of a statement ends at its `to`)", () => {
    expect(reasonOf(() => planMatchCarryOver([match], oldLine, newLine, "2026-10-01"))).toBe("entry_matched");
  });

  it("refuses a match that lives in a CLOSED statement (the trigger would block the reversal anyway; belt and braces)", () => {
    expect(reasonOf(() => planMatchCarryOver([{ ...match, statement_status: "closed" }], oldLine, newLine, "2026-09-01"))).toBe(
      "entry_matched"
    );
  });

  it("refuses when either bank line is missing (a matched entry must map 1:1 to a new bank line)", () => {
    expect(reasonOf(() => planMatchCarryOver([match], oldLine, null, "2026-09-01"))).toBe("entry_matched");
  });
});
