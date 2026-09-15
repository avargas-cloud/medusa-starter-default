import { BANK_SIDE_TYPES } from "../qb-import/classify";
import { planQbImportVoid, QB_IMPORT_VOIDABLE_TYPES, type QbImportVoidContext } from "../qb-import/void";
import { LedgerError } from "../types";

/**
 * qb-import-void-ui-20260915 — el plan PURO del void de un documento importado
 * de QuickBooks. Cada rechazo tiene nombre; la matriz de abajo es la que la UI
 * traduce (`qbImportVoidReason` en store-pos).
 */
const base: QbImportVoidContext = {
  txn_id: "1C527B-1779565679",
  entry_id: "bje_test",
  day: "2026-06-15",
  txn_type: "Check",
  reference: "QB Check 1042 · ACME",
  amount_cents: 12345,
  reversed: false,
  live_match: null,
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

describe("qb-import void — planQbImportVoid", () => {
  it("un doc bancario libre se anula el MISMO día del original, con su TxnVoidType", () => {
    expect(planQbImportVoid(base, base.txn_id)).toEqual({ entry_id: "bje_test", day: "2026-06-15", qb_txn_type: "Check" });
    expect(planQbImportVoid({ ...base, txn_type: "Credit Card Charge" }, base.txn_id).qb_txn_type).toBe("CreditCardCharge");
    expect(planQbImportVoid({ ...base, txn_type: "Credit Card Credit" }, base.txn_id).qb_txn_type).toBe("CreditCardCredit");
    expect(planQbImportVoid({ ...base, txn_type: "General Journal" }, base.txn_id).qb_txn_type).toBe("JournalEntry");
    expect(planQbImportVoid({ ...base, txn_type: "Deposit" }, base.txn_id).qb_txn_type).toBe("Deposit");
  });

  it("la allowlist es un subconjunto de los tipos bancarios del importador — Transfer queda afuera (sin TxnVoid en QBXML)", () => {
    for (const label of Object.keys(QB_IMPORT_VOIDABLE_TYPES)) expect(BANK_SIDE_TYPES.has(label)).toBe(true);
    expect(QB_IMPORT_VOIDABLE_TYPES.Transfer).toBeUndefined();
  });

  it("rechazos nombrados: no importado · ya reversado · tipo no anulable · con match vivo", () => {
    expect(reasonOf(() => planQbImportVoid(null, "1C-nope"))).toBe("not_imported");
    expect(reasonOf(() => planQbImportVoid({ ...base, reversed: true }, base.txn_id))).toBe("already_reversed");
    for (const t of ["Transfer", "Invoice", "Bill", "Payment", "Bill Pmt -Check", "Sales Tax Payment", ""]) {
      expect(reasonOf(() => planQbImportVoid({ ...base, txn_type: t }, base.txn_id))).toBe("type_not_voidable");
    }
    const matched = { ...base, live_match: { match_id: "bsm_1", statement_id: "bst_1", statement_status: "draft" as const } };
    expect(reasonOf(() => planQbImportVoid(matched, base.txn_id))).toBe("entry_matched");
    const closed = { ...matched, live_match: { ...matched.live_match, statement_status: "closed" as const } };
    expect(reasonOf(() => planQbImportVoid(closed, base.txn_id))).toBe("entry_matched");
  });

  it("el rechazo por match lleva el extracto y su estado (la UI decide: descasar vs reabrir)", () => {
    try {
      planQbImportVoid({ ...base, live_match: { match_id: "m", statement_id: "s", statement_status: "closed" } }, base.txn_id);
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(LedgerError);
      expect((error as LedgerError).details).toEqual({ reason: "entry_matched", match_id: "m", statement_id: "s", statement_status: "closed" });
    }
  });

  it("orden de precedencia: reversado gana a tipo, tipo gana a match (nunca se propone descasar algo que no se puede anular)", () => {
    const worst = { ...base, reversed: true, txn_type: "Transfer", live_match: { match_id: "m", statement_id: "s", statement_status: "draft" as const } };
    expect(reasonOf(() => planQbImportVoid(worst, base.txn_id))).toBe("already_reversed");
    expect(reasonOf(() => planQbImportVoid({ ...worst, reversed: false }, base.txn_id))).toBe("type_not_voidable");
  });
});
