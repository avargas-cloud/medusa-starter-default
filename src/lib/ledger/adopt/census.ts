/**
 * adopt-qb-bank-documents — censo PURO de las decisiones del clasificador:
 * cuántos documentos van a cada destino, por tipo de QB, cuenta y mes; los que
 * no mapean con su motivo; y las marcas que el operador quiere ver
 * (traspasos netos, splits entre cuentas propias, números largos).
 */
import type { AdoptionDecision, ImportedBankEntry } from "./classify-imported";

export interface Classified {
  entry: ImportedBankEntry;
  decision: AdoptionDecision;
}

export interface CensusRow {
  txn_type: string;
  target: string;
  n: number;
  cents: bigint;
}

export interface Census {
  total: number;
  byTypeTarget: CensusRow[];
  byAccountMonth: Array<{ account: string; month: string; target: string; n: number; cents: bigint }>;
  unmapped: Array<{ txn_id: string; txn_type: string; day: string; ref: string | null; name: string | null; reason: string; detail: string; cents: bigint }>;
  netTransfers: number;
  ownAccountSplits: Array<{ txn_id: string; day: string; ref: string | null; cents: bigint }>;
  longRefNumbers: number;
}

function amountOf(d: AdoptionDecision, e: ImportedBankEntry): bigint {
  if (d.target === "gl_check") return d.total_cents;
  if (d.target === "gl_transfer") return d.amount_cents;
  return e.lines.reduce((s, l) => s + l.debit_cents, 0n);
}

function targetLabel(d: AdoptionDecision): string {
  if (d.target === "gl_check") return `gl_check:${d.kind}`;
  if (d.target === "gl_transfer") return d.net ? "gl_transfer:net" : "gl_transfer";
  return `unmapped:${d.reason}`;
}

function bankOf(d: AdoptionDecision, e: ImportedBankEntry): string {
  if (d.target === "gl_check") return d.bank_account.name;
  if (d.target === "gl_transfer") return `${d.from.name} → ${d.to.name}`;
  return e.lines.find((l) => l.credit_cents > 0n)?.account.name ?? "?";
}

export function buildCensus(items: Classified[]): Census {
  const byTT = new Map<string, CensusRow>();
  const byAM = new Map<string, { account: string; month: string; target: string; n: number; cents: bigint }>();
  const census: Census = { total: items.length, byTypeTarget: [], byAccountMonth: [], unmapped: [], netTransfers: 0, ownAccountSplits: [], longRefNumbers: 0 };
  for (const { entry, decision } of items) {
    const target = targetLabel(decision);
    const cents = amountOf(decision, entry);
    const k1 = `${entry.txn_type}|${target}`;
    const r1 = byTT.get(k1) ?? { txn_type: entry.txn_type, target, n: 0, cents: 0n };
    r1.n += 1;
    r1.cents += cents;
    byTT.set(k1, r1);
    const month = entry.day.slice(0, 7);
    const account = bankOf(decision, entry);
    const k2 = `${account}|${month}|${decision.target}`;
    const r2 = byAM.get(k2) ?? { account, month, target: decision.target, n: 0, cents: 0n };
    r2.n += 1;
    r2.cents += cents;
    byAM.set(k2, r2);
    if (decision.target === "unmapped")
      census.unmapped.push({ txn_id: entry.txn_id, txn_type: entry.txn_type, day: entry.day, ref: entry.ref_number, name: entry.name, reason: decision.reason, detail: decision.detail, cents });
    if (decision.target === "gl_transfer" && decision.net) census.netTransfers += 1;
    if (decision.target === "gl_check") {
      if (decision.flags.includes("own_accounts_split")) census.ownAccountSplits.push({ txn_id: entry.txn_id, day: entry.day, ref: entry.ref_number, cents });
      if (decision.flags.includes("long_ref_number")) census.longRefNumbers += 1;
    }
  }
  census.byTypeTarget = [...byTT.values()].sort((a, b) => a.txn_type.localeCompare(b.txn_type) || b.n - a.n);
  census.byAccountMonth = [...byAM.values()].sort((a, b) => a.account.localeCompare(b.account) || a.month.localeCompare(b.month) || a.target.localeCompare(b.target));
  return census;
}

export const money = (cents: bigint): string =>
  (Number(cents) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

export function renderCensus(c: Census): string[] {
  const out: string[] = [`documentos qb_import adoptables en la ventana: ${c.total}`];
  out.push("por tipo QB → destino:");
  for (const r of c.byTypeTarget) out.push(`  ${r.txn_type.padEnd(20)} ${r.target.padEnd(26)} ${String(r.n).padStart(5)}  ${money(r.cents).padStart(14)}`);
  out.push(`traspasos netos (Daily Split, líneas intactas): ${c.netTransfers} · cheques con líneas a cuentas propias (split ≥3 cuentas): ${c.ownAccountSplits.length} · números de referencia >8 chars (ACH/wire): ${c.longRefNumbers}`);
  if (c.unmapped.length) {
    out.push(`NO MAPEAN (quedan qb_import): ${c.unmapped.length}`);
    for (const u of c.unmapped) out.push(`  ${u.day} ${u.txn_type.padEnd(19)} ${(u.ref ?? "-").padEnd(12)} ${(u.name ?? "-").slice(0, 28).padEnd(28)} ${money(u.cents).padStart(12)}  ${u.reason}: ${u.detail}  [${u.txn_id}]`);
  }
  return out;
}
