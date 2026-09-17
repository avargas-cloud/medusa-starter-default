/**
 * verify-sales-tax — gate del Sales Tax Center (plan sales-tax-center-20260917).
 *
 *   DATABASE_URL=… ./node_modules/.bin/tsx src/scripts/verify/verify-sales-tax.ts [--from 2025-12] [--to 2026-12]
 *
 * §1 estructura: los dos kinds están registrados en el pipeline, el TxnVoid conoce
 *    SalesTaxPaymentCheck, el importador conoce las dos tablas, el CHECK de
 *    `source_kind` del journal las admite, y los counters existen.
 * §2 identidad del payable: la suma por período del motor == el saldo directo de la
 *    cuenta (dos cálculos distintos del mismo número).
 * §3 por período con pago vivo — las 5 vías: facturas (tax cobrado) · libro (deuda
 *    creada) · STP (tax ± ajustes aplicados = total, y total = crédito al banco del
 *    asiento) · QuickBooks (TxnID presente, adoptado o confirmado) · banco (match de
 *    extracto, informativo). La variance facturas↔libro se REPORTA; falla sólo si
 *    supera la tolerancia de Settings en un período con declaración `filed`.
 * §4 negativo: ningún STP/STA vivo sin asiento; ningún STA aplicado a un pago anulado.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { PoolClient } from "pg";

import { getDbPool } from "../../api/utils/db-pool";
import { listPeriods, loadGlFigures } from "../../lib/sales-tax/period-engine";
import { loadSalesTaxSettings } from "../../lib/sales-tax/settings";

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
};
const FROM = flag("--from") ?? "2025-12";
const TO = flag("--to") ?? new Date().toISOString().slice(0, 7);
const failures: string[] = [];
const notes: string[] = [];
const SRC = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const money = (c: bigint) => `$${(Number(c) / 100).toFixed(2)}`;

function structural(): void {
  const kinds = read("lib/quickbooks/gl-documents/types.ts");
  for (const k of ["gl_sales_tax_payment", "gl_sales_tax_adjustment"]) {
    if (!kinds.includes(`"${k}"`)) failures.push(`§1 GL_DOCUMENT_KINDS no incluye ${k}`);
  }
  if (!/"SalesTaxPaymentCheck"/.test(read("lib/quickbooks/txn-void-add.ts"))) failures.push("§1 VoidableTxnType no incluye SalesTaxPaymentCheck");
  const links = read("lib/ledger/qb-import/pos-links.ts");
  if (!links.includes("FROM gl_sales_tax_payment") || !links.includes("FROM gl_sales_tax_adjustment"))
    failures.push("§1 pos-links.ts no lista las dos tablas: el importador duplicaría cada pago/ajuste del POS");
  const facts = read("lib/quickbooks/gl-documents/facts.ts");
  if (!/case "gl_sales_tax_payment":/.test(facts) || !/case "gl_sales_tax_adjustment":/.test(facts))
    failures.push("§1 loadGlDocumentAddFacts no despacha los dos kinds");
  if (!failures.length) notes.push("§1 ✓ kinds, TxnVoid, importador y facts registrados");
}

async function dbStructure(client: PoolClient): Promise<void> {
  const def = (await client.query<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'bank_journal_entry_source_kind_check'`)).rows[0]?.def ?? "";
  for (const k of ["sales_tax_payment", "sales_tax_adjustment"]) if (!def.includes(`'${k}'`)) failures.push(`§1 bank_journal_entry_source_kind_check no admite ${k}`);
  const counters = (await client.query<{ name: string }>(`SELECT name FROM document_number_counter WHERE name IN ('gl_sales_tax_payment','gl_sales_tax_adjustment')`)).rows.length;
  if (counters !== 2) failures.push(`§1 faltan counters (${counters}/2) — correr la migración SalesTaxCenter`);
  const fn = (await client.query<{ n: string }>(`SELECT proname AS n FROM pg_proc WHERE proname = 'bank_journal_native_table'`)).rows.length;
  if (fn !== 1) failures.push("§1 bank_journal_native_table() no existe — el guard de re-parent no conoce las tablas nuevas");
}

async function main(): Promise<void> {
  structural();
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await dbStructure(client);
    const settings = await loadSalesTaxSettings(client);
    notes.push(`settings: ${settings.ready ? "listos" : `INCOMPLETOS (${settings.missing.join(", ")})`} · payable ${settings.accounts.payable_list_id}`);

    // §2 identidad del payable
    const gl = await loadGlFigures(client, settings.accounts.payable_list_id, FROM, TO);
    const last = [...gl.entries()].sort(([a], [b]) => a.localeCompare(b)).pop();
    const direct = (
      await client.query<{ b: string }>(
        `SELECT COALESCE(SUM(l.credit_cents - l.debit_cents), 0)::text AS b FROM bank_journal_line l JOIN bank_journal_entry e ON e.id = l.entry_id
          WHERE l.deleted_at IS NULL AND e.deleted_at IS NULL AND e.reverses_entry_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id AND r.deleted_at IS NULL)
            AND l.account_list_id = $1 AND substr(e.day::text, 1, 7) <= $2`,
        [settings.accounts.payable_list_id, TO]
      )
    ).rows[0]!.b;
    if (last && last[1].closing_balance_cents !== BigInt(direct))
      failures.push(`§2 saldo del payable: motor ${money(last[1].closing_balance_cents)} ≠ directo ${money(BigInt(direct))}`);
    else notes.push(`§2 ✓ saldo del payable al ${TO}: ${money(BigInt(direct))} por las dos vías`);

    // §3 cinco vías por período con pago vivo
    const periods = await listPeriods(client, settings, FROM, TO);
    const tolerance = BigInt(settings.variance_tolerance_cents);
    for (const p of periods) {
      const live = p.payments.filter((x) => x.status === "posted");
      if (live.length === 0) continue;
      const pay = live[0]!;
      const doc = (
        await client.query<{ tax: string; adj: string; total: string; entry_id: string | null; bank_credit: string | null; qb_txn_id: string | null; qb_source: string | null; lines_sum: string }>(
          `SELECT d.tax_cents::text AS tax, d.adjustments_cents::text AS adj, d.total_cents::text AS total, d.entry_id, d.qb_txn_id, d.qb_source,
                  (SELECT SUM(amount_cents)::text FROM gl_sales_tax_payment_line WHERE payment_id = d.id) AS lines_sum,
                  (SELECT SUM(l.credit_cents)::text FROM bank_journal_line l WHERE l.entry_id = d.entry_id AND l.account_list_id = d.bank_account_list_id AND l.deleted_at IS NULL) AS bank_credit
             FROM gl_sales_tax_payment d WHERE d.id = $1`,
          [pay.id]
        )
      ).rows[0]!;
      const tax = BigInt(doc.tax), adj = BigInt(doc.adj), total = BigInt(doc.total);
      if (tax + adj !== total) failures.push(`§3 ${p.period} ${pay.doc_number}: tax ${money(tax)} + adj ${money(adj)} ≠ total ${money(total)}`);
      if (BigInt(doc.lines_sum) !== total) failures.push(`§3 ${p.period} ${pay.doc_number}: Σ líneas ${money(BigInt(doc.lines_sum))} ≠ total ${money(total)}`);
      if (!doc.entry_id) failures.push(`§3 ${p.period} ${pay.doc_number}: pago posted sin asiento`);
      else if (doc.bank_credit === null || BigInt(doc.bank_credit) !== total)
        failures.push(`§3 ${p.period} ${pay.doc_number}: crédito al banco ${doc.bank_credit ?? "null"} ≠ total ${money(total)}`);
      const qb = doc.qb_txn_id ? `QB ${doc.qb_txn_id}${doc.qb_source === "adopted" ? " (adopted)" : ""}` : "QB PENDIENTE";
      const bank = (
        await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM bank_statement_match m JOIN bank_journal_line l ON l.id = m.book_id AND m.book_kind = 'journal_line'
            WHERE l.entry_id = $1 AND m.deleted_at IS NULL`,
          [doc.entry_id]
        )
      ).rows[0]!.n;
      const variance = BigInt(p.variance_cents);
      const absVar = variance < 0n ? -variance : variance;
      if (p.return_status === "filed" && absVar > tolerance)
        failures.push(`§3 ${p.period}: declaración filed con variance facturas↔libro ${money(variance)} > tolerancia ${money(tolerance)}`);
      notes.push(
        `§3 ${p.period} ${pay.doc_number}: facturas ${money(BigInt(p.sales.tax_collected_cents as string))} · libro ${money(BigInt(p.gl.liability_cents))} (var ${money(variance)}) · STP ${money(total)} · ${qb} · banco ${bank} match`
      );
    }

    // §4 negativos
    const orphans = (
      await client.query<{ n: string }>(
        `SELECT (SELECT COUNT(*) FROM gl_sales_tax_payment WHERE deleted_at IS NULL AND status = 'posted' AND entry_id IS NULL)
              + (SELECT COUNT(*) FROM gl_sales_tax_adjustment WHERE deleted_at IS NULL AND status = 'posted' AND entry_id IS NULL) AS n`
      )
    ).rows[0]!.n;
    if (orphans !== "0") failures.push(`§4 ${orphans} documento(s) posted sin asiento`);
    const badLinks = (
      await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM gl_sales_tax_adjustment a JOIN gl_sales_tax_payment p ON p.id = a.applied_payment_id
          WHERE a.deleted_at IS NULL AND (p.status = 'voided' OR p.deleted_at IS NOT NULL)`
      )
    ).rows[0]!.n;
    if (badLinks !== "0") failures.push(`§4 ${badLinks} ajuste(s) siguen aplicados a un pago anulado`);
    if (orphans === "0" && badLinks === "0") notes.push("§4 ✓ sin huérfanos ni enlaces a pagos anulados");
  } finally {
    client.release();
    await pool.end();
  }
  for (const n of notes) process.stdout.write(`  ${n}\n`);
  if (failures.length) {
    process.stdout.write(`\n❌ ${failures.length} problema(s):\n`);
    for (const f of failures) process.stdout.write(`  • ${f}\n`);
    process.exit(1);
  }
  process.stdout.write(`\n✅ verify-sales-tax OK (${FROM}..${TO})\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
