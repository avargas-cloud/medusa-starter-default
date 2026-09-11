/**
 * qb-gl-import — paridad mensual por cuenta (docs/QB_GL_IMPORT.md §5). Pura.
 *
 * Lado QB: TODOS los documentos del reporte (en alcance o no) sumados por
 * (cuenta, mes). Lado libro: lo que devuelva la DB por (cuenta, mes) para el
 * conjunto de fuentes que se quiera comparar (qb_import + documentos del POS).
 * La comparación es por NETO (débito − crédito): es lo que mueve el saldo.
 */
import type { QbGlDocument } from "./types";

/** Separador de la clave (cuenta, mes): un tab no puede aparecer en un FullName de QB. */
const SEP = "\t";

export function monthlyKey(account: string, month: string): string {
  return `${account}${SEP}${month}`;
}

export function qbMonthlyNet(documents: Iterable<QbGlDocument>): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const doc of documents) {
    const month = doc.date.slice(0, 7);
    for (const row of doc.rows) {
      const key = monthlyKey(row.account, month);
      out.set(key, (out.get(key) ?? 0n) + row.debit_cents - row.credit_cents);
    }
  }
  return out;
}

export interface ParityDiff {
  account: string;
  month: string;
  qb_net_cents: bigint;
  ledger_net_cents: bigint;
  diff_cents: bigint;
}

/** `ledger` viene keyeado con `monthlyKey(account, month)`, igual que `qbMonthlyNet`. */
export function compareMonthlyNet(
  qb: Map<string, bigint>,
  ledger: Map<string, bigint>
): { diffs: ParityDiff[]; compared: number; equal: number } {
  const keys = new Set([...qb.keys(), ...ledger.keys()]);
  const diffs: ParityDiff[] = [];
  let equal = 0;
  for (const key of keys) {
    const [account = "", month = ""] = key.split(SEP);
    const q = qb.get(key) ?? 0n;
    const l = ledger.get(key) ?? 0n;
    if (q === l) {
      equal += 1;
      continue;
    }
    diffs.push({ account, month, qb_net_cents: q, ledger_net_cents: l, diff_cents: q - l });
  }
  const abs = (v: bigint) => (v < 0n ? -v : v);
  diffs.sort(
    (a, b) =>
      (abs(b.diff_cents) > abs(a.diff_cents) ? 1 : abs(b.diff_cents) < abs(a.diff_cents) ? -1 : 0) ||
      a.account.localeCompare(b.account) ||
      a.month.localeCompare(b.month)
  );
  return { diffs, compared: keys.size, equal };
}

export function formatCents(cents: bigint): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}
