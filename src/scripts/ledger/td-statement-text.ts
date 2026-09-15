/**
 * td-statement-text — lee el TEXTO de un extracto mensual de TD Bank (el PDF pasado por
 * pdftotext -layout) y devuelve sus líneas con fecha completa y signo del libro.
 *
 * TD ·9209 sólo tiene feed de Plaid desde el 2026-07-01; los meses anteriores salen de los
 * PDF del banco. Este lector alimenta a reconcile-feed-statement (`--td <txt>`) con el mismo
 * contrato que el feed: líneas {day, amount_cents, description}, con el PDF como evidencia.
 *
 * Secciones de "DAILY ACCOUNT ACTIVITY" y su signo:
 *   Deposits · Electronic Deposits · Other Credits            → entra (+)
 *   Checks Paid (dos columnas: fecha, serial, monto ×2)       → sale (−), descripción "CHECK # <serial>"
 *   Electronic Payments · Other Withdrawals · Service Charges → sale (−)
 * Una línea de descripción puede continuar en la siguiente (sangría, sin fecha ni monto).
 *
 * El lector se auto-verifica: cada sección suma su "Subtotal:" y
 * Beginning Balance + entradas − salidas = Ending Balance. Si no, lanza.
 */
import { readFileSync } from "node:fs";

export type TdLine = {
  /** Estable por extracto: sección + posición; nunca el texto (se repite). */
  external_key: string;
  day: string; // YYYY-MM-DD
  amount_cents: number; // + entra, − sale (signo del libro)
  description: string;
};

export type TdStatement = {
  period_from: string;
  period_to: string;
  beginning_balance_cents: number;
  ending_balance_cents: number;
  lines: TdLine[];
};

const MONTHS: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};
const CREDIT_SECTIONS = ["Deposits", "Electronic Deposits", "Other Credits"];
const DEBIT_SECTIONS = ["Electronic Payments", "Other Withdrawals", "Service Charges"];
const AMOUNT = /^\d{1,3}(,\d{3})*\.\d{2}$/;

const toCents = (s: string): number => Math.round(Number(s.replace(/,/g, "")) * 100);

function parsePeriod(text: string): { from: string; to: string } {
  const m = /Statement Period:\s+([A-Z][a-z]{2}) (\d{2}) (\d{4})-([A-Z][a-z]{2}) (\d{2}) (\d{4})/.exec(text);
  if (!m) throw new Error("td-statement-text: no encuentro 'Statement Period'");
  const [, m1, d1, y1, m2, d2, y2] = m;
  return { from: `${y1}-${MONTHS[m1!]}-${d1}`, to: `${y2}-${MONTHS[m2!]}-${d2}` };
}

function summaryAmount(text: string, label: string): number | null {
  const m = new RegExp(`^${label}\\s+(\\d{1,3}(?:,\\d{3})*\\.\\d{2})`, "m").exec(text);
  return m ? toCents(m[1]!) : null;
}

/** mm/dd del extracto → YYYY-MM-DD, con el año del período (un extracto no cruza el año). */
function fullDay(mmdd: string, period: { from: string; to: string }): string {
  const [mm, dd] = mmdd.split("/");
  return `${period.from.slice(0, 4)}-${mm}-${dd}`;
}

export function parseTdStatementText(text: string): TdStatement {
  const period = parsePeriod(text);
  const beginning = summaryAmount(text, "Beginning Balance");
  const ending = summaryAmount(text, "Ending Balance");
  if (beginning === null || ending === null)
    throw new Error("td-statement-text: no encuentro Beginning/Ending Balance en el resumen");

  const lines: TdLine[] = [];
  const sectionSums = new Map<string, number>();
  let section: string | null = null;
  let sign = 0;
  let inActivity = false;
  let lastWasRow = false; // la continuación sólo sigue a una fila (o a otra continuación), nunca a un encabezado de página
  const counters = new Map<string, number>();
  const push = (day: string, cents: number, description: string): void => {
    const n = (counters.get(section!) ?? 0) + 1;
    counters.set(section!, n);
    lines.push({
      external_key: `td:${period.to}:${section!.toLowerCase().replace(/\s+/g, "-")}:${n}`,
      day: fullDay(day, period),
      amount_cents: sign * cents,
      description,
    });
    sectionSums.set(section!, (sectionSums.get(section!) ?? 0) + cents);
  };

  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const wasRow = lastWasRow;
    lastWasRow = false;
    if (/^DAILY ACCOUNT ACTIVITY/.test(line)) { inActivity = true; continue; }
    if (/^DAILY BALANCE SUMMARY|How to Balance your Account/.test(line)) { inActivity = false; section = null; continue; }
    if (!inActivity) continue;
    const head = /^([A-Z][A-Za-z ]+?)(?: \(continued\))?(?:\s{2,}.*|\s+No\. Checks:.*)?$/.exec(line);
    if (head && !/^(POSTING )?DATE\b/.test(line)) {
      const name = head[1]!.trim();
      if (CREDIT_SECTIONS.includes(name)) { section = name; sign = 1; continue; }
      if (DEBIT_SECTIONS.includes(name)) { section = name; sign = -1; continue; }
      if (name === "Checks Paid") { section = name; sign = -1; continue; }
    }
    if (!section) continue;
    const sub = /Subtotal:\s+(\d{1,3}(?:,\d{3})*\.\d{2})\s*$/.exec(line);
    if (sub) {
      const declared = toCents(sub[1]!);
      const got = sectionSums.get(section) ?? 0;
      if (declared !== got)
        throw new Error(`td-statement-text: ${section} suma ${got} ≠ subtotal ${declared}`);
      section = null;
      continue;
    }
    if (section === "Checks Paid") {
      // "12/01   1051   2,250.00   12/31   1060   1,500.00" (una o dos columnas)
      const re = /(\d{2}\/\d{2})\s+(\d+)\*?\s+(\d{1,3}(?:,\d{3})*\.\d{2})/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line))) push(m[1]!, toCents(m[3]!), `CHECK # ${m[2]}`);
      continue;
    }
    const row = /^(\d{2}\/\d{2})\s+(.+?)\s+(\d{1,3}(?:,\d{3})*\.\d{2})$/.exec(line);
    if (row && AMOUNT.test(row[3]!)) {
      push(row[1]!, toCents(row[3]!), row[2]!.trim());
      lastWasRow = true;
      continue;
    }
    // Continuación de la descripción anterior (sangría, sin fecha, pegada a la fila).
    const cont = /^\s{4,}(\S.*)$/.exec(line);
    if (cont && wasRow && lines.length) {
      const last = lines[lines.length - 1]!;
      last.description = `${last.description} ${cont[1]!.trim()}`.slice(0, 500);
      lastWasRow = true;
    }
  }
  if (section) throw new Error(`td-statement-text: la sección ${section} no cerró con Subtotal`);

  // Cada rubro del resumen tiene que coincidir con lo leído (una sección que el lector no
  // conoce aparecería acá como diferencia).
  for (const name of [...CREDIT_SECTIONS, ...DEBIT_SECTIONS, "Checks Paid"]) {
    const declared = summaryAmount(text, name);
    const got = sectionSums.get(name) ?? 0;
    if ((declared ?? 0) !== got)
      throw new Error(`td-statement-text: resumen ${name} ${declared ?? 0} ≠ líneas ${got}`);
  }
  const net = lines.reduce((s, l) => s + l.amount_cents, 0);
  if (beginning + net !== ending)
    throw new Error(`td-statement-text: ${beginning} + ${net} ≠ ${ending} (Beginning + movimientos ≠ Ending)`);
  return { period_from: period.from, period_to: period.to, beginning_balance_cents: beginning, ending_balance_cents: ending, lines };
}

export function readTdStatement(path: string): TdStatement {
  return parseTdStatementText(readFileSync(path, "utf8"));
}

/**
 * Varios extractos consecutivos → las líneas de [from, to] con apertura/cierre calculados
 * desde los saldos del banco (apertura = saldo al INICIO de `from`; cierre = saldo al fin de `to`).
 */
export function tdWindow(
  statements: TdStatement[],
  from: string,
  to: string
): { opening_cents: number; closing_cents: number; lines: TdLine[] } {
  const sorted = [...statements].sort((a, b) => a.period_from.localeCompare(b.period_from));
  for (let i = 1; i < sorted.length; i++)
    if (sorted[i - 1]!.ending_balance_cents !== sorted[i]!.beginning_balance_cents)
      throw new Error(`td-statement-text: ${sorted[i - 1]!.period_to} cierra ${sorted[i - 1]!.ending_balance_cents} y ${sorted[i]!.period_from} abre ${sorted[i]!.beginning_balance_cents}`);
  const first = sorted[0]!, last = sorted[sorted.length - 1]!;
  if (from < first.period_from || to > last.period_to)
    throw new Error(`td-statement-text: ${from}..${to} no está cubierto por ${first.period_from}..${last.period_to}`);
  const all = sorted.flatMap((s) => s.lines);
  const before = all.filter((l) => l.day < from).reduce((s, l) => s + l.amount_cents, 0);
  const after = all.filter((l) => l.day > to).reduce((s, l) => s + l.amount_cents, 0);
  return {
    opening_cents: first.beginning_balance_cents + before,
    closing_cents: last.ending_balance_cents - after,
    lines: all.filter((l) => l.day >= from && l.day <= to),
  };
}
