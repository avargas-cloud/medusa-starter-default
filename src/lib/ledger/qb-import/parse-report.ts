/**
 * qb-gl-import — parser PURO del `ReportRet` de `GeneralDetailReportQueryRs`
 * (GeneralLedger) tal como lo devuelve el bridge (XML → JSON, un hijo = objeto,
 * varios = array).
 *
 * Forma medida el 2026-09-11 sobre una semana real (1342 DataRow, 13 columnas):
 * - `ColDesc[]` mapea `colID` → `ColType` (Blank, TxnType, Date, RefNumber,
 *   Name, Memo, Account, SplitAccount, ClearedStatus, Debit, Credit, Amount, TxnID).
 * - `ReportData.DataRow[]`: `RowData.$.rowType='account'` trae la cuenta de la
 *   sección; `ColData[].$.{colID,value}` las celdas. Las filas SIN `TxnType`
 *   son los "Total <cuenta>" (van vacías: el total vive en `SubtotalRow`).
 * - `ReportData.SubtotalRow[]`: total débito/crédito de cada cuenta.
 * - Los importes vienen como "15243.62" (sin separador de miles), signo en `Amount`.
 */
import type { QbClearedStatus, QbGlAccountTotal, QbGlReport, QbGlRow } from "./types";

type Cell = { $?: { colID?: string; value?: string } };
type RowData = { $?: { rowType?: string; value?: string } };
type DataRow = { RowData?: RowData; ColData?: Cell | Cell[] };
type SubtotalRow = { RowData?: RowData; ColData?: Cell | Cell[] };
type ColDesc = { $?: { colID?: string }; ColType?: string };

export interface RawReportRet {
  NumRows?: string;
  ColDesc?: ColDesc | ColDesc[];
  ReportData?: {
    DataRow?: DataRow | DataRow[];
    SubtotalRow?: SubtotalRow | SubtotalRow[];
  };
}

export class QbGlParseError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = "QbGlParseError";
  }
}

function asList<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** "15243.62" | "-7.5" | "" → centavos exactos (sin float). */
export function parseCents(value: string | undefined | null): bigint {
  const raw = (value ?? "").trim().replace(/,/g, "");
  if (raw === "") return 0n;
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!m) throw new QbGlParseError(`importe ilegible: "${value}"`);
  const sign = m[1] ?? "";
  const whole = m[2] ?? "0";
  const frac = m[3] ?? "";
  const cents = BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0"));
  return sign === "-" ? -cents : cents;
}

function clearedStatus(value: string | undefined): QbClearedStatus | null {
  if (value === "Cleared" || value === "NotCleared" || value === "Pending") return value;
  return null;
}

function cellsByType(cells: Cell | Cell[] | undefined, columns: Map<string, string>) {
  const out = new Map<string, string>();
  for (const cell of asList(cells)) {
    const id = cell.$?.colID;
    const type = id ? columns.get(id) : undefined;
    if (type && cell.$?.value !== undefined) out.set(type, cell.$.value);
  }
  return out;
}

const REQUIRED_COLUMNS = ["TxnType", "Date", "Debit", "Credit", "TxnID"] as const;

/** Parsea el `ReportRet` crudo. Lanza `QbGlParseError` ante cualquier forma inesperada. */
export function parseGeneralLedgerReport(
  raw: RawReportRet,
  window: { from: string; to: string }
): QbGlReport {
  const columns = new Map<string, string>();
  for (const col of asList(raw.ColDesc)) {
    if (col.$?.colID && col.ColType) columns.set(col.$.colID, col.ColType);
  }
  const present = new Set(columns.values());
  const missing = REQUIRED_COLUMNS.filter((c) => !present.has(c));
  if (missing.length)
    throw new QbGlParseError(`faltan columnas en el reporte: ${missing.join(", ")}`);

  const rows: QbGlRow[] = [];
  for (const row of asList(raw.ReportData?.DataRow)) {
    const account = row.RowData?.$?.rowType === "account" ? row.RowData.$.value : undefined;
    const cells = cellsByType(row.ColData, columns);
    const txnType = cells.get("TxnType");
    if (!txnType) continue; // "Total <cuenta>" — sin transacción
    if (!account) throw new QbGlParseError("fila con TxnType sin cuenta de sección", cells);
    const date = cells.get("Date");
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw new QbGlParseError(`fecha ilegible en ${txnType}: "${date}"`, cells);
    const debit = parseCents(cells.get("Debit"));
    const credit = parseCents(cells.get("Credit"));
    if (debit < 0n || credit < 0n)
      throw new QbGlParseError(`débito/crédito negativo en ${txnType} ${date}`, cells);
    rows.push({
      account,
      txn_type: txnType,
      txn_id: cells.get("TxnID") || null,
      date,
      ref_number: cells.get("RefNumber") || null,
      name: cells.get("Name") || null,
      memo: cells.get("Memo") || null,
      split_account: cells.get("SplitAccount") || null,
      cleared_status: clearedStatus(cells.get("ClearedStatus")),
      debit_cents: debit,
      credit_cents: credit,
    });
  }

  const totals: QbGlAccountTotal[] = [];
  for (const sub of asList(raw.ReportData?.SubtotalRow)) {
    const account = sub.RowData?.$?.rowType === "account" ? sub.RowData.$.value : undefined;
    if (!account) continue;
    const cells = cellsByType(sub.ColData, columns);
    // "Total Services - Other" = sólo las filas directas del padre; "Total Services" = el subárbol.
    const label = cells.get("Blank") ?? "";
    totals.push({
      account,
      scope: /\s-\sOther$/.test(label) ? "direct" : "subtree",
      debit_cents: parseCents(cells.get("Debit")),
      credit_cents: parseCents(cells.get("Credit")),
    });
  }

  return {
    from: window.from,
    to: window.to,
    num_rows: Number(raw.NumRows ?? 0),
    rows,
    totals,
  };
}

export interface TotalsMismatch {
  account: string;
  expected_debit: bigint;
  expected_credit: bigint;
  actual_debit: bigint;
  actual_credit: bigint;
}

/**
 * Fidelidad del parseo: la suma de las filas por cuenta tiene que dar EXACTO
 * el `SubtotalRow` que QB imprime para esa cuenta. Si no, el reporte llegó
 * truncado o el parser perdió filas — y no se importa nada de esa ventana.
 *
 * El subtotal es JERÁRQUICO (medido 2026-09-11, ventana 01-01..01-07): el de
 * `Sales` suma sus propias filas más las de `Sales:Ecopowertech:*`, etc. Por
 * eso cada total se compara contra las filas de la cuenta y de todas sus
 * descendientes (`X` o `X:…`). El reporte imprime además subtotales para
 * cuentas sin filas en la ventana (padres, inactivas): esos valen 0 y cuadran.
 */
export function verifyParsedTotals(report: QbGlReport): TotalsMismatch[] {
  const sums = new Map<string, { debit: bigint; credit: bigint }>();
  for (const row of report.rows) {
    const s = sums.get(row.account) ?? { debit: 0n, credit: 0n };
    s.debit += row.debit_cents;
    s.credit += row.credit_cents;
    sums.set(row.account, s);
  }
  const subtree = (account: string) => {
    const prefix = `${account}:`;
    let debit = 0n;
    let credit = 0n;
    for (const [name, s] of sums) {
      if (name === account || name.startsWith(prefix)) {
        debit += s.debit;
        credit += s.credit;
      }
    }
    return { debit, credit };
  };
  const mismatches: TotalsMismatch[] = [];
  for (const total of report.totals) {
    const s =
      total.scope === "direct"
        ? (sums.get(total.account) ?? { debit: 0n, credit: 0n })
        : subtree(total.account);
    if (s.debit !== total.debit_cents || s.credit !== total.credit_cents)
      mismatches.push({
        account: total.account,
        expected_debit: total.debit_cents,
        expected_credit: total.credit_cents,
        actual_debit: s.debit,
        actual_credit: s.credit,
      });
  }
  for (const [account, s] of sums) {
    if (!report.totals.some((t) => t.account === account)) {
      mismatches.push({
        account,
        expected_debit: 0n,
        expected_credit: 0n,
        actual_debit: s.debit,
        actual_credit: s.credit,
      });
    }
  }
  return mismatches;
}
