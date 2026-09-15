/**
 * ar-ap-diff — atribuye a documentos concretos la diferencia QB−POS de una cuenta
 * de control (Accounts Receivable / Accounts Payable) (plan arap-parity-20260915).
 *
 * Método (Codex + este plan): outer join por TxnID de la CONTRIBUCIÓN FIRMADA a la
 * cuenta (debe − haber), no del total del documento. Lado QB = filas del reporte
 * General Ledger sobre la cuenta; lado POS = líneas del libro sobre la cuenta,
 * agrupadas por asiento y resueltas a su TxnID (`pos_invoice.metadata.qb_txn_id`,
 * `customer_payment.metadata.qb_txn_id`, `pos_credit_memo.qb_txn_id`,
 * `vendor_*.qb_txn_id`, `gl_*.qb_txn_id`, `bank_deposit.qb_txn_id`, o el
 * `source_id` de un `qb_import`).
 *
 * Clases del residuo:
 *   amount_differs   mismo TxnID en los dos lados, contribución distinta
 *   qb_only          QB lo tiene, ningún documento del POS lleva ese TxnID
 *   pos_only         el POS lo postea y no tiene TxnID (nunca viajó) o QB no lo muestra
 *   date_differs     misma contribución, mes distinto (no mueve el acumulado; se lista aparte)
 * Todo puro: los loaders viven en el script.
 */

export interface QbContribution {
  txn_id: string;
  txn_type: string;
  date: string;
  ref_number: string | null;
  name: string | null;
  cents: bigint;
}

export interface PosContribution {
  entry_id: string;
  source_kind: string;
  source_id: string;
  document_number: string | null;
  day: string;
  txn_id: string | null;
  cents: bigint;
}

export type ResidualClass = "amount_differs" | "qb_only" | "pos_only" | "date_differs";

export interface Residual {
  klass: ResidualClass;
  txn_id: string | null;
  qb: QbContribution | null;
  pos: PosContribution[];
  qb_cents: bigint;
  pos_cents: bigint;
  /** QB − POS */
  delta_cents: bigint;
  month: string;
}

export interface DiffResult {
  qb_total: bigint;
  pos_total: bigint;
  delta: bigint;
  residuals: Residual[];
  byMonth: Array<{ month: string; qb: bigint; pos: bigint; delta: bigint }>;
  matched: number;
}

const month = (d: string) => d.slice(0, 7);
const isSalesNoise = (x: Residual): boolean =>
  x.klass === "pos_only" && x.pos.every((p) => p.source_kind === "pos_invoice" || p.source_kind === "customer_payment");

export function diffControlAccount(qb: QbContribution[], pos: PosContribution[]): DiffResult {
  const qbByTxn = new Map<string, QbContribution>();
  for (const q of qb) {
    const cur = qbByTxn.get(q.txn_id);
    qbByTxn.set(q.txn_id, cur ? { ...cur, cents: cur.cents + q.cents } : { ...q });
  }
  const posByTxn = new Map<string, PosContribution[]>();
  const posNoTxn: PosContribution[] = [];
  for (const p of pos) {
    if (!p.txn_id) { posNoTxn.push(p); continue; }
    posByTxn.set(p.txn_id, [...(posByTxn.get(p.txn_id) ?? []), p]);
  }
  const residuals: Residual[] = [];
  let matched = 0;
  for (const [txn, q] of qbByTxn) {
    const ps = posByTxn.get(txn) ?? [];
    const posCents = ps.reduce((s, p) => s + p.cents, 0n);
    if (!ps.length) { residuals.push({ klass: "qb_only", txn_id: txn, qb: q, pos: [], qb_cents: q.cents, pos_cents: 0n, delta_cents: q.cents, month: month(q.date) }); continue; }
    if (q.cents !== posCents) { residuals.push({ klass: "amount_differs", txn_id: txn, qb: q, pos: ps, qb_cents: q.cents, pos_cents: posCents, delta_cents: q.cents - posCents, month: month(q.date) }); continue; }
    matched += 1;
    if (ps.some((p) => month(p.day) !== month(q.date)))
      residuals.push({ klass: "date_differs", txn_id: txn, qb: q, pos: ps, qb_cents: q.cents, pos_cents: posCents, delta_cents: 0n, month: month(q.date) });
  }
  for (const [txn, ps] of posByTxn) {
    if (qbByTxn.has(txn)) continue;
    const posCents = ps.reduce((s, p) => s + p.cents, 0n);
    residuals.push({ klass: "pos_only", txn_id: txn, qb: null, pos: ps, qb_cents: 0n, pos_cents: posCents, delta_cents: -posCents, month: month(ps[0]!.day) });
  }
  for (const p of posNoTxn)
    residuals.push({ klass: "pos_only", txn_id: null, qb: null, pos: [p], qb_cents: 0n, pos_cents: p.cents, delta_cents: -p.cents, month: month(p.day) });

  const qbTotal = qb.reduce((s, q) => s + q.cents, 0n);
  const posTotal = pos.reduce((s, p) => s + p.cents, 0n);
  const months = new Map<string, { qb: bigint; pos: bigint }>();
  for (const q of qb) { const m = months.get(month(q.date)) ?? { qb: 0n, pos: 0n }; m.qb += q.cents; months.set(month(q.date), m); }
  for (const p of pos) { const m = months.get(month(p.day)) ?? { qb: 0n, pos: 0n }; m.pos += p.cents; months.set(month(p.day), m); }
  const byMonth = [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([m, v]) => ({ month: m, qb: v.qb, pos: v.pos, delta: v.qb - v.pos }));
  residuals.sort((a, b) => a.month.localeCompare(b.month) || (a.delta_cents < b.delta_cents ? 1 : -1));
  return { qb_total: qbTotal, pos_total: posTotal, delta: qbTotal - posTotal, residuals, byMonth, matched };
}

export const money = (c: bigint): string => (Number(c) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

export function renderDiff(account: string, r: DiffResult): string[] {
  const out = [`## ${account} — QB ${money(r.qb_total)} · POS ${money(r.pos_total)} · Δ (QB−POS) ${money(r.delta)} · TxnIDs iguales ${r.matched}`, "", "| mes | QB | POS | Δ mes |", "|---|---|---|---|"];
  for (const m of r.byMonth) out.push(`| ${m.month} | ${money(m.qb)} | ${money(m.pos)} | ${money(m.delta)} |`);
  // Ruido que no mueve nada: TxnIDs con Δ 0 (doc de $0 sobre la cuenta) y los pares
  // pos_invoice/customer_payment de un sales receipt (QB no toca AR en un Sales Receipt;
  // el POS lo postea como invoice + cobro que se cancelan) — se resumen, no se listan.
  const moving = r.residuals.filter((x) => x.klass !== "date_differs" && x.delta_cents !== 0n && !isSalesNoise(x));
  const noise = r.residuals.filter((x) => x.klass === "pos_only" && isSalesNoise(x));
  const noiseByMonth = new Map<string, bigint>();
  for (const n of noise) noiseByMonth.set(n.month, (noiseByMonth.get(n.month) ?? 0n) + n.delta_cents);
  out.push("", `### Ruido de sales receipts (pos_invoice + customer_payment sin AR en QB): ${noise.length} filas, Σ Δ por mes: ${[...noiseByMonth.entries()].map(([m, c]) => `${m} ${money(c)}`).join(" · ") || "—"}`);
  // Un sales receipt cancela invoice + cobro; lo que NO cancela (una sola pata, o montos
  // distintos) sí mueve el saldo y se lista como cualquier otro residuo.
  const noiseMoving = noise.filter((x) => x.delta_cents !== 0n).sort((a, b) => (a.delta_cents < 0n ? -a.delta_cents : a.delta_cents) < (b.delta_cents < 0n ? -b.delta_cents : b.delta_cents) ? 1 : -1);
  if (noiseMoving.length) {
    out.push("", `#### Sales receipts que NO cancelan (${noiseMoving.length}; Σ ${money(noiseMoving.reduce((s, x) => s + x.delta_cents, 0n))})`, "", "| mes | TxnID | POS (kind · doc · día · monto) | Δ |", "|---|---|---|---|");
    for (const x of noiseMoving.slice(0, 60)) out.push(`| ${x.month} | ${x.txn_id} | ${x.pos.map((p) => `${p.source_kind} ${p.document_number ?? p.source_id.slice(0, 18)} ${p.day} ${money(p.cents)}`).join(" + ")} | ${money(x.delta_cents)} |`);
  }
  out.push("", `### Residuos que mueven el saldo (${moving.length}; Σ Δ = ${money(moving.reduce((s, x) => s + x.delta_cents, 0n))})`, "", "| mes | clase | TxnID | QB (tipo · nº · nombre) | POS (kind · doc) | QB | POS | Δ |", "|---|---|---|---|---|---|---|---|");
  for (const x of moving) {
    const qb = x.qb ? `${x.qb.txn_type} · ${x.qb.ref_number ?? "-"} · ${(x.qb.name ?? "").slice(0, 28)}` : "—";
    const pos = x.pos.length ? x.pos.map((p) => `${p.source_kind} ${p.document_number ?? p.source_id.slice(0, 18)}`).join(" + ") : "—";
    out.push(`| ${x.month} | ${x.klass} | ${x.txn_id ?? "-"} | ${qb} | ${pos} | ${money(x.qb_cents)} | ${money(x.pos_cents)} | ${money(x.delta_cents)} |`);
  }
  const dated = r.residuals.filter((x) => x.klass === "date_differs");
  out.push("", `### Mismo monto, mes distinto (no mueve el acumulado): ${dated.length}`);
  for (const x of dated.slice(0, 40)) out.push(`- ${x.txn_id} ${x.qb?.txn_type} ${x.qb?.ref_number ?? ""} QB ${x.qb?.date} vs POS ${x.pos.map((p) => `${p.document_number ?? p.source_kind} ${p.day}`).join(", ")} · ${money(x.qb_cents)}`);
  return out;
}
