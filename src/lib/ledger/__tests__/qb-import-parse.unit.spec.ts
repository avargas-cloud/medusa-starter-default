import {
  parseCents,
  parseGeneralLedgerReport,
  QbGlParseError,
  verifyParsedTotals,
  type RawReportRet,
} from "../qb-import";

/**
 * Fixture con la forma REAL del bridge (medida el 2026-09-11 sobre una semana):
 * ColDesc con 13 columnas, DataRow por sección de cuenta, "Total <cuenta>" sin
 * TxnType, SubtotalRow por cuenta. Nombres anonimizados.
 */
const COLS = ["Blank", "TxnType", "Date", "RefNumber", "Name", "Memo", "Account", "SplitAccount", "ClearedStatus", "Debit", "Credit", "Amount", "TxnID"];
const col = (i: number) => String(i + 1);
const cell = (type: string, value: string) => ({ $: { colID: col(COLS.indexOf(type)), value } });
const row = (account: string, cells: Array<[string, string]>) => ({
  RowData: { $: { rowType: "account", value: account } },
  ColData: cells.map(([t, v]) => cell(t, v)),
});

function fixture(): RawReportRet {
  return {
    NumRows: "9",
    ColDesc: COLS.map((c, i) => ({ $: { colID: col(i), dataType: "STRTYPE" }, ColType: c })),
    ReportData: {
      DataRow: [
        // Cheque 1042: banco (crédito) + gasto (débito) — dos secciones
        row("Chase Checking", [["TxnType", "Check"], ["Date", "2026-01-05"], ["RefNumber", "1042"], ["Name", "Vendor A"], ["Memo", "rent"], ["SplitAccount", "Rent Expense"], ["ClearedStatus", "Cleared"], ["Credit", "1000.00"], ["Amount", "-1000.00"], ["TxnID", "T-CHK-1"]]),
        row("Chase Checking", [["Blank", "Total Chase Checking"]]),
        row("Rent Expense", [["TxnType", "Check"], ["Date", "2026-01-05"], ["RefNumber", "1042"], ["Name", "Vendor A"], ["Memo", "rent"], ["SplitAccount", "Chase Checking"], ["ClearedStatus", "Cleared"], ["Debit", "1000.00"], ["Amount", "1000.00"], ["TxnID", "T-CHK-1"]]),
        // Sales Receipt 28994: UF + income con TxnID; inventario/COGS SIN TxnID
        row("Undeposited Funds", [["TxnType", "Sales Receipt"], ["Date", "2026-01-06"], ["RefNumber", "28994"], ["Name", "Customer B"], ["SplitAccount", "-SPLIT-"], ["ClearedStatus", "NotCleared"], ["Debit", "10.70"], ["Amount", "10.70"], ["TxnID", "T-SR-1"]]),
        row("Sales", [["TxnType", "Sales Receipt"], ["Date", "2026-01-06"], ["RefNumber", "28994"], ["Name", "Customer B"], ["SplitAccount", "Undeposited Funds"], ["ClearedStatus", "NotCleared"], ["Credit", "10.00"], ["Amount", "-10.00"], ["TxnID", "T-SR-1"]]),
        row("Sales Tax Payable", [["TxnType", "Sales Receipt"], ["Date", "2026-01-06"], ["RefNumber", "28994"], ["Name", "Customer B"], ["SplitAccount", "Undeposited Funds"], ["ClearedStatus", "NotCleared"], ["Credit", "0.70"], ["Amount", "-0.70"], ["TxnID", "T-SR-1"]]),
        row("Inventory Asset", [["TxnType", "Sales Receipt"], ["Date", "2026-01-06"], ["RefNumber", "28994"], ["Name", "Customer B"], ["Memo", "LED strip"], ["SplitAccount", "Undeposited Funds"], ["ClearedStatus", "NotCleared"], ["Credit", "4.00"], ["Amount", "-4.00"]]),
        row("Cost of Goods Sold", [["TxnType", "Sales Receipt"], ["Date", "2026-01-06"], ["RefNumber", "28994"], ["Name", "Customer B"], ["Memo", "LED strip"], ["SplitAccount", "Undeposited Funds"], ["ClearedStatus", "NotCleared"], ["Debit", "4.00"], ["Amount", "4.00"]]),
      ],
      SubtotalRow: [
        { RowData: { $: { rowType: "account", value: "Chase Checking" } }, ColData: [cell("Blank", "Total Chase Checking"), cell("Debit", "0.00"), cell("Credit", "1000.00"), cell("Amount", "-1000.00")] },
        { RowData: { $: { rowType: "account", value: "Rent Expense" } }, ColData: [cell("Blank", "Total Rent Expense"), cell("Debit", "1000.00"), cell("Credit", "0.00")] },
        { RowData: { $: { rowType: "account", value: "Undeposited Funds" } }, ColData: [cell("Debit", "10.70"), cell("Credit", "0.00")] },
        { RowData: { $: { rowType: "account", value: "Sales" } }, ColData: [cell("Debit", "0.00"), cell("Credit", "10.00")] },
        { RowData: { $: { rowType: "account", value: "Sales Tax Payable" } }, ColData: [cell("Credit", "0.70")] },
        { RowData: { $: { rowType: "account", value: "Inventory Asset" } }, ColData: [cell("Credit", "4.00")] },
        { RowData: { $: { rowType: "account", value: "Cost of Goods Sold" } }, ColData: [cell("Debit", "4.00")] },
      ],
    },
  };
}

describe("qb-import parse-report", () => {
  it("parseCents es exacto y rechaza basura", () => {
    expect(parseCents("15243.62")).toBe(1524362n);
    expect(parseCents("-7.5")).toBe(-750n);
    expect(parseCents("1,000")).toBe(100000n);
    expect(parseCents("")).toBe(0n);
    expect(parseCents(undefined)).toBe(0n);
    expect(() => parseCents("12.345")).toThrow(QbGlParseError);
    expect(() => parseCents("abc")).toThrow(QbGlParseError);
  });

  it("una fila por línea contable, la cuenta viene de la sección y el TxnID puede faltar", () => {
    const report = parseGeneralLedgerReport(fixture(), { from: "2026-01-01", to: "2026-01-07" });
    expect(report.num_rows).toBe(9);
    expect(report.rows).toHaveLength(7); // el "Total Chase Checking" no es una fila
    const chk = report.rows.filter((r) => r.txn_id === "T-CHK-1");
    expect(chk.map((r) => [r.account, r.debit_cents, r.credit_cents])).toEqual([
      ["Chase Checking", 0n, 100000n],
      ["Rent Expense", 100000n, 0n],
    ]);
    expect(chk[0].cleared_status).toBe("Cleared");
    expect(chk[0].ref_number).toBe("1042");
    const noId = report.rows.filter((r) => r.txn_id === null);
    expect(noId.map((r) => r.account)).toEqual(["Inventory Asset", "Cost of Goods Sold"]);
    expect(noId[0].txn_type).toBe("Sales Receipt");
    expect(report.totals).toHaveLength(7);
  });

  it("verifyParsedTotals: cuadra con los subtotales de QB y detecta filas perdidas", () => {
    const ok = parseGeneralLedgerReport(fixture(), { from: "2026-01-01", to: "2026-01-07" });
    expect(verifyParsedTotals(ok)).toEqual([]);
    const truncated = { ...ok, rows: ok.rows.filter((r) => r.account !== "Rent Expense") };
    const mism = verifyParsedTotals(truncated);
    expect(mism).toHaveLength(1);
    expect(mism[0]).toMatchObject({ account: "Rent Expense", expected_debit: 100000n, actual_debit: 0n });
  });

  it("verifyParsedTotals: el subtotal de una cuenta padre suma sus subcuentas (jerárquico)", () => {
    const raw = fixture();
    const data = raw.ReportData as { DataRow: unknown[]; SubtotalRow: unknown[] };
    data.DataRow.push(
      row("Chase Checking", [["TxnType", "Deposit"], ["Date", "2026-01-07"], ["SplitAccount", "Sales:LED"], ["Debit", "50.00"], ["TxnID", "T-DEP-1"]]),
      row("Sales:LED", [["TxnType", "Deposit"], ["Date", "2026-01-07"], ["SplitAccount", "Chase Checking"], ["Credit", "50.00"], ["TxnID", "T-DEP-1"]])
    );
    // subtotales: Chase sube a 50 de débito; "Sales" (padre) suma Sales + Sales:LED; "Sales:LED" propio; padres sin filas valen 0
    data.SubtotalRow = [
      { RowData: { $: { rowType: "account", value: "Chase Checking" } }, ColData: [cell("Debit", "50.00"), cell("Credit", "1000.00")] },
      { RowData: { $: { rowType: "account", value: "Rent Expense" } }, ColData: [cell("Debit", "1000.00")] },
      { RowData: { $: { rowType: "account", value: "Undeposited Funds" } }, ColData: [cell("Debit", "10.70")] },
      { RowData: { $: { rowType: "account", value: "Sales" } }, ColData: [cell("Credit", "60.00")] },
      { RowData: { $: { rowType: "account", value: "Sales:LED" } }, ColData: [cell("Credit", "50.00")] },
      { RowData: { $: { rowType: "account", value: "Sales Tax Payable" } }, ColData: [cell("Credit", "0.70")] },
      { RowData: { $: { rowType: "account", value: "Inventory Asset" } }, ColData: [cell("Credit", "4.00")] },
      { RowData: { $: { rowType: "account", value: "Cost of Goods Sold" } }, ColData: [cell("Debit", "4.00")] },
      { RowData: { $: { rowType: "account", value: "Loans Payable" } }, ColData: [cell("Debit", "0.00"), cell("Credit", "0.00")] },
    ];
    const report = parseGeneralLedgerReport(raw, { from: "2026-01-01", to: "2026-01-07" });
    expect(verifyParsedTotals(report)).toEqual([]);
    // y si el padre declara más de lo que suman sus hijas, se detecta
    (data.SubtotalRow[3] as { ColData: unknown[] }).ColData = [cell("Credit", "61.00")];
    const bad = parseGeneralLedgerReport(raw, { from: "2026-01-01", to: "2026-01-07" });
    expect(verifyParsedTotals(bad).map((m) => m.account)).toEqual(["Sales"]);
  });

  it("un padre con movimientos propios imprime 'Total X - Other' (directo) y 'Total X' (subárbol)", () => {
    const raw = fixture();
    const data = raw.ReportData as { DataRow: unknown[]; SubtotalRow: unknown[] };
    data.DataRow.push(
      row("Chase Checking", [["TxnType", "Check"], ["Date", "2026-01-08"], ["RefNumber", "1043"], ["SplitAccount", "Services"], ["Credit", "25.00"], ["TxnID", "T-CHK-2"]]),
      row("Services", [["TxnType", "Check"], ["Date", "2026-01-08"], ["RefNumber", "1043"], ["SplitAccount", "Chase Checking"], ["Debit", "10.00"], ["TxnID", "T-CHK-2"]]),
      row("Services:Electrical Services", [["TxnType", "Check"], ["Date", "2026-01-08"], ["RefNumber", "1043"], ["SplitAccount", "Chase Checking"], ["Debit", "15.00"], ["TxnID", "T-CHK-2"]])
    );
    data.SubtotalRow = [
      { RowData: { $: { rowType: "account", value: "Chase Checking" } }, ColData: [cell("Blank", "Total Chase Checking"), cell("Credit", "1025.00")] },
      { RowData: { $: { rowType: "account", value: "Rent Expense" } }, ColData: [cell("Blank", "Total Rent Expense"), cell("Debit", "1000.00")] },
      { RowData: { $: { rowType: "account", value: "Undeposited Funds" } }, ColData: [cell("Debit", "10.70")] },
      { RowData: { $: { rowType: "account", value: "Sales" } }, ColData: [cell("Credit", "10.00")] },
      { RowData: { $: { rowType: "account", value: "Sales Tax Payable" } }, ColData: [cell("Credit", "0.70")] },
      { RowData: { $: { rowType: "account", value: "Inventory Asset" } }, ColData: [cell("Credit", "4.00")] },
      { RowData: { $: { rowType: "account", value: "Cost of Goods Sold" } }, ColData: [cell("Debit", "4.00")] },
      { RowData: { $: { rowType: "account", value: "Services:Electrical Services" } }, ColData: [cell("Blank", "Total Electrical Services"), cell("Debit", "15.00")] },
      { RowData: { $: { rowType: "account", value: "Services" } }, ColData: [cell("Blank", "Total Services - Other"), cell("Debit", "10.00")] },
      { RowData: { $: { rowType: "account", value: "Services" } }, ColData: [cell("Blank", "Total Services"), cell("Debit", "25.00")] },
    ];
    const report = parseGeneralLedgerReport(raw, { from: "2026-01-01", to: "2026-01-08" });
    expect(report.totals.filter((t) => t.account === "Services").map((t) => [t.scope, t.debit_cents])).toEqual([
      ["direct", 1000n],
      ["subtree", 2500n],
    ]);
    expect(verifyParsedTotals(report)).toEqual([]);
  });

  it("rechaza un reporte sin las columnas obligatorias", () => {
    const raw = fixture();
    raw.ColDesc = (raw.ColDesc as Array<{ ColType?: string }>).filter((c) => c.ColType !== "TxnID");
    expect(() => parseGeneralLedgerReport(raw, { from: "2026-01-01", to: "2026-01-07" })).toThrow(/TxnID/);
  });
});
