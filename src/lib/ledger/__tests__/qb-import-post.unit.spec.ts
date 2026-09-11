import type { LedgerAccount } from "../types";
import { QB_IMPORT_ACTOR, QbImportAccountError, toPostInput, type QbGlDocument } from "../qb-import";

const acct = (id: string, name: string, type: string, nb: "debit" | "credit"): LedgerAccount => ({
  id, name, account_type: type, currency: "USD", normal_balance: nb,
});
const INDEX = new Map<string, LedgerAccount>([
  ["Chase Checking", acct("L-CHASE", "Chase Checking", "Bank", "debit")],
  ["Rent Expense", acct("L-RENT", "Rent Expense", "Expense", "debit")],
]);

const CHECK: QbGlDocument = {
  txn_id: "1CF02A-1788441984",
  txn_type: "Check",
  date: "2026-01-05",
  ref_number: "1042",
  name: "Vendor A",
  rows: [
    { account: "Chase Checking", txn_type: "Check", txn_id: "1CF02A-1788441984", date: "2026-01-05", ref_number: "1042", name: "Vendor A", memo: "rent", split_account: "Rent Expense", cleared_status: "Cleared", debit_cents: 0n, credit_cents: 100000n },
    { account: "Rent Expense", txn_type: "Check", txn_id: "1CF02A-1788441984", date: "2026-01-05", ref_number: "1042", name: "Vendor A", memo: "rent", split_account: "Chase Checking", cleared_status: "Cleared", debit_cents: 100000n, credit_cents: 0n },
  ],
};

describe("qb-import post (documento QB → PostDocumentInput)", () => {
  it("una línea por fila, roles l001.., cuentas del espejo, snapshot serializable con ClearedStatus", () => {
    const input = toPostInput(CHECK, "bank_side", INDEX);
    expect(input.source_kind).toBe("qb_import");
    expect(input.source_id).toBe("1CF02A-1788441984");
    expect(input.day).toBe("2026-01-05");
    expect(input.document_number).toBe("Check 1042");
    expect(input.actor_id).toBe(QB_IMPORT_ACTOR);
    expect(input.lines.map((l) => [l.role, l.account.id, l.debit_cents, l.credit_cents])).toEqual([
      ["l001", "L-CHASE", 0n, 100000n],
      ["l002", "L-RENT", 100000n, 0n],
    ]);
    const snap = input.source_snapshot as { policy: string; rows: Array<{ cleared_status: string | null; debit_cents: string }> };
    expect(snap.policy).toBe("bank_side");
    expect(snap.rows[0].cleared_status).toBe("Cleared");
    expect(snap.rows[1].debit_cents).toBe("100000");
    expect(() => JSON.stringify(input.source_snapshot)).not.toThrow();
    expect(input.source_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("el hash es estable para el mismo documento y cambia si cambia una fila", () => {
    const a = toPostInput(CHECK, "bank_side", INDEX).source_hash;
    const b = toPostInput(CHECK, "bank_side", INDEX).source_hash;
    expect(a).toBe(b);
    const changed = { ...CHECK, rows: [CHECK.rows[0], { ...CHECK.rows[1], memo: "rent (edited)" }] };
    expect(toPostInput(changed, "bank_side", INDEX).source_hash).not.toBe(a);
  });

  it("una cuenta sin espejo no se inventa: lanza QbImportAccountError con el nombre", () => {
    const doc = { ...CHECK, rows: [CHECK.rows[0], { ...CHECK.rows[1], account: "Sales:Merchandise" }] };
    expect(() => toPostInput(doc, "bank_side", INDEX)).toThrow(QbImportAccountError);
    try {
      toPostInput(doc, "bank_side", INDEX);
    } catch (err) {
      expect((err as QbImportAccountError).account).toBe("Sales:Merchandise");
    }
  });

  it("usa el TxnID como número cuando QB no asignó RefNumber (cheques por imprimir, depósitos)", () => {
    const input = toPostInput({ ...CHECK, ref_number: null, txn_type: "Deposit" }, "bank_side", INDEX);
    expect(input.document_number).toBe("Deposit 1CF02A-1788441984");
  });
});
