import { assembleDocuments, type QbGlRow } from "../qb-import";

function r(partial: Partial<QbGlRow> & Pick<QbGlRow, "account">): QbGlRow {
  return {
    txn_type: "Sales Receipt",
    txn_id: null,
    date: "2026-01-06",
    ref_number: "28994",
    name: "Customer B",
    memo: null,
    split_account: null,
    cleared_status: "NotCleared",
    debit_cents: 0n,
    credit_cents: 0n,
    ...partial,
  };
}

describe("qb-import assemble (filas → documentos por TxnID)", () => {
  it("une las filas de inventario/COGS sin TxnID al documento con la misma clave", () => {
    const rows = [
      r({ account: "Undeposited Funds", txn_id: "T-SR-1", debit_cents: 1070n }),
      r({ account: "Sales", txn_id: "T-SR-1", credit_cents: 1000n }),
      r({ account: "Sales Tax Payable", txn_id: "T-SR-1", credit_cents: 70n }),
      r({ account: "Inventory Asset", credit_cents: 400n }),
      r({ account: "Cost of Goods Sold", debit_cents: 400n }),
    ];
    const out = assembleDocuments(rows);
    expect(out.blocked).toEqual([]);
    expect(out.documents).toHaveLength(1);
    expect(out.documents[0].txn_id).toBe("T-SR-1");
    expect(out.documents[0].rows.map((x) => x.account)).toEqual([
      "Undeposited Funds", "Sales", "Sales Tax Payable", "Inventory Asset", "Cost of Goods Sold",
    ]);
  });

  it("una fila sin TxnID sin documento que la reclame se bloquea como huérfana", () => {
    const out = assembleDocuments([
      r({ account: "Chase Checking", txn_type: "Check", txn_id: "T-CHK-1", ref_number: "1042", credit_cents: 100000n }),
      r({ account: "Rent Expense", txn_type: "Check", txn_id: "T-CHK-1", ref_number: "1042", debit_cents: 100000n }),
      r({ account: "Inventory Asset", ref_number: "99999", credit_cents: 400n }),
    ]);
    expect(out.documents.map((d) => d.txn_id)).toEqual(["T-CHK-1"]);
    expect(out.blocked).toHaveLength(1);
    expect(out.blocked[0]).toMatchObject({ reason: "orphan_rows_without_txn_id", txn_type: "Sales Receipt", rows: 1 });
  });

  it("dos documentos con la misma clave y filas sin TxnID: los dos se bloquean como ambiguos", () => {
    const out = assembleDocuments([
      r({ account: "Undeposited Funds", txn_id: "T-A", debit_cents: 500n }),
      r({ account: "Sales", txn_id: "T-A", credit_cents: 500n }),
      r({ account: "Undeposited Funds", txn_id: "T-B", debit_cents: 700n }),
      r({ account: "Sales", txn_id: "T-B", credit_cents: 700n }),
      r({ account: "Inventory Asset", credit_cents: 100n }),
    ]);
    expect(out.documents).toEqual([]);
    expect(out.blocked.map((b) => b.reason).sort()).toEqual([
      "ambiguous_rows_without_txn_id", "ambiguous_rows_without_txn_id", "ambiguous_rows_without_txn_id",
    ]);
  });

  it("dos Item Receipts del mismo proveedor y día: las filas sin TxnID se reparten por balance (caso real 2026-01-14)", () => {
    const ir = (over: Partial<QbGlRow> & Pick<QbGlRow, "account">) =>
      r({ txn_type: "Item Receipt", date: "2026-01-14", ref_number: null, name: "VEETECH Co., Ltd", ...over });
    const out = assembleDocuments([
      ir({ account: "Accounts Payable", txn_id: "T-IR-A", credit_cents: 30000n }),
      ir({ account: "Accounts Payable", txn_id: "T-IR-B", credit_cents: 12500n }),
      // inventario de ambos recibos, sin TxnID: 20000+10000 sólo balancea A; 12500 sólo B
      ir({ account: "Inventory Asset", debit_cents: 20000n }),
      ir({ account: "Inventory Asset", debit_cents: 12500n }),
      ir({ account: "Inventory Asset", debit_cents: 10000n }),
    ]);
    expect(out.blocked).toEqual([]);
    const byId = Object.fromEntries(out.documents.map((d) => [d.txn_id, d.rows.map((x) => x.debit_cents - x.credit_cents)]));
    expect(byId["T-IR-A"]).toEqual([-30000n, 20000n, 10000n]);
    expect(byId["T-IR-B"]).toEqual([-12500n, 12500n]);
  });

  it("pares que se cancelan (ajuste de costo de un recibo) se reparten sin bloquear — caso Goodlite SH041268 ×2", () => {
    const ir = (over: Partial<QbGlRow> & Pick<QbGlRow, "account">) =>
      r({ txn_type: "Item Receipt", date: "2026-01-26", ref_number: "SH041268", name: "Goodlite", ...over });
    const out = assembleDocuments([
      ir({ account: "Inventory Asset", txn_id: "T-A", debit_cents: 16450n }),
      ir({ account: "Inventory Offset Account", txn_id: "T-A", credit_cents: 16450n }),
      ir({ account: "Inventory Asset", txn_id: "T-B", debit_cents: 15800n }),
      ir({ account: "Inventory Offset Account", txn_id: "T-B", credit_cents: 15800n }),
      ir({ account: "Inventory Asset", credit_cents: 13601n }),
      ir({ account: "Purchases - Resale Items:Ecopowertech", debit_cents: 13601n }),
      ir({ account: "Inventory Asset", credit_cents: 401n }),
      ir({ account: "Purchases - Resale Items:Ecopowertech", debit_cents: 401n }),
    ]);
    expect(out.blocked).toEqual([]);
    expect(out.documents).toHaveLength(2);
    for (const d of out.documents) {
      const net = d.rows.reduce((s, x) => s + x.debit_cents - x.credit_cents, 0n);
      expect(net).toBe(0n);
    }
    expect(out.documents.reduce((n, d) => n + d.rows.length, 0)).toBe(8); // ninguna fila se pierde
  });

  it("sin ninguna partición balanceada, los documentos con la misma clave se bloquean", () => {
    const ir = (over: Partial<QbGlRow> & Pick<QbGlRow, "account">) =>
      r({ txn_type: "Item Receipt", date: "2026-01-14", ref_number: null, name: "Vendor X", ...over });
    const out = assembleDocuments([
      ir({ account: "Accounts Payable", txn_id: "T-1", credit_cents: 300n }),
      ir({ account: "Accounts Payable", txn_id: "T-2", credit_cents: 300n }),
      ir({ account: "Inventory Asset", debit_cents: 250n }), // 250 no balancea a ninguno de los dos
    ]);
    expect(out.documents).toEqual([]);
    expect(out.blocked.every((b) => b.reason === "ambiguous_rows_without_txn_id")).toBe(true);
  });

  it("descarta filas en cero y salta documentos voideados sin bloquearlos", () => {
    const out = assembleDocuments([
      r({ account: "Chase Checking", txn_type: "Check", txn_id: "T-VOID", ref_number: "7" }),
      r({ account: "Rent Expense", txn_type: "Check", txn_id: "T-VOID", ref_number: "7" }),
      r({ account: "Chase Checking", txn_type: "Check", txn_id: "T-OK", ref_number: "8", credit_cents: 100n }),
      r({ account: "Rent Expense", txn_type: "Check", txn_id: "T-OK", ref_number: "8", debit_cents: 100n }),
      r({ account: "Fees", txn_type: "Check", txn_id: "T-OK", ref_number: "8" }),
    ]);
    expect(out.skipped_zero_documents).toBe(1);
    expect(out.dropped_zero_rows).toBe(3);
    expect(out.documents.map((d) => [d.txn_id, d.rows.length])).toEqual([["T-OK", 2]]);
    expect(out.blocked).toEqual([]);
  });

  it("un documento que no balancea o con una sola línea se bloquea con su motivo", () => {
    const out = assembleDocuments([
      r({ account: "Chase Checking", txn_type: "Check", txn_id: "T-UNB", ref_number: "1", credit_cents: 100n }),
      r({ account: "Rent Expense", txn_type: "Check", txn_id: "T-UNB", ref_number: "1", debit_cents: 90n }),
      r({ account: "Chase Checking", txn_type: "Deposit", txn_id: "T-ONE", ref_number: null, debit_cents: 50n }),
    ]);
    expect(out.documents).toEqual([]);
    expect(out.blocked.map((b) => [b.key, b.reason])).toEqual([
      ["T-UNB", "unbalanced"],
      ["T-ONE", "line_count_out_of_range"],
    ]);
  });

  it("ordena por fecha y luego por TxnID", () => {
    const out = assembleDocuments([
      r({ account: "A", txn_type: "Check", txn_id: "T-2", date: "2026-02-01", ref_number: "2", credit_cents: 1n }),
      r({ account: "B", txn_type: "Check", txn_id: "T-2", date: "2026-02-01", ref_number: "2", debit_cents: 1n }),
      r({ account: "A", txn_type: "Check", txn_id: "T-1", date: "2026-01-01", ref_number: "1", credit_cents: 1n }),
      r({ account: "B", txn_type: "Check", txn_id: "T-1", date: "2026-01-01", ref_number: "1", debit_cents: 1n }),
    ]);
    expect(out.documents.map((d) => d.txn_id)).toEqual(["T-1", "T-2"]);
  });
});
