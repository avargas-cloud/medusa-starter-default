/**
 * verify-qb-gl-import — afirma que los documentos `qb_import` del libro son
 * fieles a la caché del reporte General Ledger de QuickBooks y respetan la
 * regla de no doble conteo. Read-only. Diseño: docs/QB_GL_IMPORT.md §5.
 *
 *   DATABASE_URL=… ./node_modules/.bin/tsx src/scripts/verify/verify-qb-gl-import.ts \
 *     --from 2026-01-01 --to 2026-09-11 [--cache-dir .qb-gl-cache] [--cutoff 2026-04-13] [--window-days 7]
 *
 * Checks:
 *  (a) toda entrada activa qb_import balancea y tiene 2..200 líneas;
 *  (b) un solo documento activo por TxnID;
 *  (c) ningún tipo que el POS produce tiene día posterior al corte;
 *  (d) toda línea apunta a una cuenta que existe en qb_account;
 *  (e) por cada ventana cacheada: cada documento en alcance con cuentas
 *      resueltas tiene su entrada activa con el mismo importe, y la suma por
 *      cuenta de esas entradas es EXACTAMENTE la suma de las filas en alcance;
 *  (f) control de vacuidad: si el rango tiene caché, el check (e) evaluó ≥1 documento.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

/**
 * Ventanas cacheadas que se SOLAPAN con [from,to] — por nombre de archivo, no
 * por `reportWindows`: la caché se alinea desde el `--from` del import (01-01),
 * así que recalcular ventanas desde otro `--from` no encuentra ningún archivo y
 * el check sale vacuo. Los documentos se filtran después por fecha.
 */
function cachedWindows(dir: string, from: string, to: string): Array<{ from: string; to: string; path: string }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => /^gl_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.json$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ from: m[1] as string, to: m[2] as string, path: join(dir, m[0]) }))
    .filter((w) => w.to >= from && w.from <= to)
    .sort((a, b) => a.from.localeCompare(b.from));
}
import {
  assembleDocuments,
  classify,
  compareMonthlyNet,
  formatCents,
  loadPosKnownTxnIds,
  monthlyKey,
  parseGeneralLedgerReport,
  POS_CUTOFF_DAY,
  POS_OWNED_TYPES,
  qbMonthlyNet,
} from "../../lib/ledger/qb-import";
import type { RawReportRet } from "../../lib/ledger/qb-import";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : fallback;
}
const FROM = arg("from");
const TO = arg("to");
const CACHE_DIR = arg("cache-dir", ".qb-gl-cache") as string;
const CUTOFF = arg("cutoff", POS_CUTOFF_DAY) as string;
if (!FROM || !TO || !process.env.DATABASE_URL) {
  console.error("uso: DATABASE_URL=… --from YYYY-MM-DD --to YYYY-MM-DD [--cache-dir DIR] [--cutoff YYYY-MM-DD]");
  process.exit(2);
}

/** `--parity`: paridad mensual por cuenta (QB entero vs libro qb_import + POS). Informativa salvo `--parity-strict`. */
const PARITY = process.argv.includes("--parity") || process.argv.includes("--parity-strict");
const PARITY_STRICT = process.argv.includes("--parity-strict");
/** Kinds del libro que se comparan contra QB: lo importado + lo que el POS postea (nunca la apertura). */
const LEDGER_PARITY_KINDS = [
  "qb_import", "pos_invoice", "pos_credit_memo", "customer_payment", "rounding_adjustment",
  "po_receipt", "vendor_bill", "vendor_credit", "vendor_bill_payment",
];

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function parity(client: import("pg").PoolClient): Promise<void> {
  console.log(`\n(g) paridad mensual por cuenta ${FROM}..${TO} — QB (todo el reporte) vs libro (${LEDGER_PARITY_KINDS.join(", ")})`);
  const qbDocs = [];
  let windows = 0;
  for (const w of cachedWindows(CACHE_DIR, FROM as string, TO as string)) {
    windows += 1;
    const raw = JSON.parse(readFileSync(w.path, "utf8")) as RawReportRet;
    qbDocs.push(
      ...assembleDocuments(parseGeneralLedgerReport(raw, w).rows).documents.filter(
        (d) => d.date >= (FROM as string) && d.date <= (TO as string)
      )
    );
  }
  const qb = qbMonthlyNet(qbDocs);
  const rows = await client.query<{ full_name: string | null; month: string; net: string }>(
    `SELECT a.full_name, substr(e.day, 1, 7) AS month, sum(l.debit_cents - l.credit_cents)::text AS net
       FROM bank_journal_line l
       JOIN bank_journal_entry e ON e.id = l.entry_id
       LEFT JOIN qb_account a ON a.qb_list_id = l.account_list_id AND a.deleted_at IS NULL
      WHERE e.kind = 'document' AND e.deleted_at IS NULL AND l.deleted_at IS NULL
        AND e.source_kind = ANY($1::text[]) AND e.day >= $2 AND e.day <= $3
        AND e.reverses_entry_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id AND r.deleted_at IS NULL)
      GROUP BY a.full_name, substr(e.day, 1, 7)`,
    [LEDGER_PARITY_KINDS, FROM, TO]
  );
  const ledger = new Map<string, bigint>();
  for (const r of rows.rows) ledger.set(monthlyKey(r.full_name ?? "<sin espejo>", r.month), BigInt(r.net));
  const { diffs, compared, equal } = compareMonthlyNet(qb, ledger);
  console.log(`  ventanas ${windows} · documentos QB ${qbDocs.length} · pares (cuenta, mes) comparados ${compared} · iguales ${equal} · distintos ${diffs.length}`);
  const totalAbs = diffs.reduce((s, d) => s + (d.diff_cents < 0n ? -d.diff_cents : d.diff_cents), 0n);
  for (const d of diffs.slice(0, 40))
    console.log(`    ${d.month}  ${d.account.padEnd(48).slice(0, 48)}  QB ${formatCents(d.qb_net_cents).padStart(14)}  libro ${formatCents(d.ledger_net_cents).padStart(14)}  Δ ${formatCents(d.diff_cents).padStart(12)}`);
  if (diffs.length > 40) console.log(`    … ${diffs.length - 40} más`);
  console.log(`  |Δ| acumulado: ${formatCents(totalAbs)}`);
  if (PARITY_STRICT) check("paridad mensual por cuenta = 0 diferencias", diffs.length === 0, `${diffs.length} pares distintos`);
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const client = await pool.connect();
  try {
    console.log(`verify-qb-gl-import ${FROM}..${TO} · corte ${CUTOFF}`);

    const entries = await client.query<{ id: string; source_id: string; day: string; amount_cents: string; txn_type: string | null; lines: string; debit: string; credit: string }>(
      `SELECT e.id, e.source_id, e.day, e.amount_cents::text, e.source_snapshot->>'txn_type' AS txn_type,
              count(l.id)::text AS lines, coalesce(sum(l.debit_cents),0)::text AS debit, coalesce(sum(l.credit_cents),0)::text AS credit
         FROM bank_journal_entry e LEFT JOIN bank_journal_line l ON l.entry_id = e.id AND l.deleted_at IS NULL
        WHERE e.source_kind = 'qb_import' AND e.kind = 'document' AND e.deleted_at IS NULL AND e.reverses_entry_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id AND r.deleted_at IS NULL)
        GROUP BY e.id`
    );
    const active = entries.rows;
    console.log(`(a/b) ${active.length} documentos qb_import activos`);
    const unbalanced = active.filter((e) => e.debit !== e.credit || e.debit !== e.amount_cents || Number(e.lines) < 2 || Number(e.lines) > 200);
    check("toda entrada activa balancea y tiene 2..200 líneas", unbalanced.length === 0, unbalanced.slice(0, 5).map((e) => `${e.source_id} D${e.debit}/C${e.credit} amt${e.amount_cents} n${e.lines}`).join(", ") || undefined);
    const ids = new Map<string, number>();
    for (const e of active) ids.set(e.source_id, (ids.get(e.source_id) ?? 0) + 1);
    const dupes = [...ids.entries()].filter(([, n]) => n > 1);
    check("un solo documento activo por TxnID", dupes.length === 0, dupes.slice(0, 5).map(([id]) => id).join(", ") || undefined);

    // (c) no doble conteo: un documento que el POS sincronizó (TxnID enlazado) nunca entra desde QB
    //     después del corte — el POS ya lo postea. Antes del corte entra todo (el replay arranca 04-14).
    const known = await loadPosKnownTxnIds(client);
    const doubled = active.filter((e) => e.day > CUTOFF && known.has(e.source_id));
    check(`(c) ningún qb_import posterior al corte con TxnID que el POS conozca (${known.size} enlazados)`, doubled.length === 0, doubled.slice(0, 5).map((e) => `${e.txn_type} ${e.day} ${e.source_id}`).join(", ") || undefined);
    const posTypesAfter = active.filter((e) => e.txn_type && POS_OWNED_TYPES.has(e.txn_type) && e.day > CUTOFF).length;
    console.log(`      (${posTypesAfter} documentos de tipos del POS posteriores al corte entraron desde QB por no estar sincronizados)`);

    const orphanAccounts = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM bank_journal_line l JOIN bank_journal_entry e ON e.id = l.entry_id
        WHERE e.source_kind = 'qb_import' AND l.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM qb_account a WHERE a.qb_list_id = l.account_list_id AND a.deleted_at IS NULL)`
    );
    const orphanCount = orphanAccounts.rows[0]?.n ?? "?";
    check("(d) toda línea apunta a una cuenta del espejo", orphanCount === "0", `${orphanCount} huérfanas`);

    // (e) fidelidad contra la caché
    const byId = new Map(active.map((e) => [e.source_id, e]));
    const accountRows = await client.query<{ full_name: string; qb_list_id: string }>(
      `SELECT DISTINCT ON (full_name) full_name, qb_list_id FROM qb_account WHERE deleted_at IS NULL ORDER BY full_name, is_active DESC, last_synced_at DESC NULLS LAST`
    );
    const listIdByName = new Map(accountRows.rows.map((r) => [r.full_name, r.qb_list_id]));
    let evaluated = 0;
    let cachedWindowCount = 0;
    const missingEntries: string[] = [];
    const amountMismatch: string[] = [];
    const expectedByList = new Map<string, { debit: bigint; credit: bigint }>();
    const inScopeIds: string[] = [];
    for (const w of cachedWindows(CACHE_DIR, FROM as string, TO as string)) {
      cachedWindowCount += 1;
      const raw = JSON.parse(readFileSync(w.path, "utf8")) as RawReportRet;
      const report = parseGeneralLedgerReport(raw, w);
      const { documents } = assembleDocuments(report.rows);
      for (const doc of documents) {
        if (doc.date < (FROM as string) || doc.date > (TO as string)) continue;
        if (classify(doc.txn_type, doc.date, CUTOFF, known.has(doc.txn_id)).action !== "import") continue;
        if (!doc.rows.every((r) => listIdByName.has(r.account))) continue; // bloqueado por cuenta: no se espera entrada
        evaluated += 1;
        inScopeIds.push(doc.txn_id);
        let debit = 0n;
        for (const r of doc.rows) {
          debit += r.debit_cents;
          const list = listIdByName.get(r.account) as string;
          const s = expectedByList.get(list) ?? { debit: 0n, credit: 0n };
          s.debit += r.debit_cents;
          s.credit += r.credit_cents;
          expectedByList.set(list, s);
        }
        const entry = byId.get(doc.txn_id);
        if (!entry) missingEntries.push(doc.txn_id);
        else if (BigInt(entry.amount_cents) !== debit) amountMismatch.push(`${doc.txn_id} esperado ${debit} libro ${entry.amount_cents}`);
      }
    }
    console.log(`(e) ventanas cacheadas ${cachedWindowCount} · documentos en alcance evaluados ${evaluated}`);
    check("todo documento en alcance tiene entrada activa", missingEntries.length === 0, missingEntries.length ? `${missingEntries.length} faltan (${missingEntries.slice(0, 5).join(", ")})` : undefined);
    check("importe de cada entrada = Σ débitos del documento", amountMismatch.length === 0, amountMismatch.slice(0, 5).join("; ") || undefined);

    if (inScopeIds.length) {
      const sums = await client.query<{ account_list_id: string; debit: string; credit: string }>(
        `SELECT l.account_list_id, sum(l.debit_cents)::text AS debit, sum(l.credit_cents)::text AS credit
           FROM bank_journal_line l JOIN bank_journal_entry e ON e.id = l.entry_id
          WHERE e.source_kind = 'qb_import' AND e.kind='document' AND e.deleted_at IS NULL AND l.deleted_at IS NULL
            AND e.source_id = ANY($1::text[])
            AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id AND r.deleted_at IS NULL)
          GROUP BY l.account_list_id`,
        [inScopeIds]
      );
      const actual = new Map(sums.rows.map((r) => [r.account_list_id, { debit: BigInt(r.debit), credit: BigInt(r.credit) }]));
      const diffs: string[] = [];
      for (const [list, exp] of expectedByList) {
        const act = actual.get(list) ?? { debit: 0n, credit: 0n };
        if (act.debit !== exp.debit || act.credit !== exp.credit) diffs.push(`${list}: esperado D${exp.debit}/C${exp.credit} libro D${act.debit}/C${act.credit}`);
      }
      for (const list of actual.keys()) if (!expectedByList.has(list)) diffs.push(`${list}: en libro sin filas esperadas`);
      check("suma por cuenta del libro = suma de las filas en alcance", diffs.length === 0, diffs.slice(0, 5).join("; ") || undefined);
    }
    check("(f) el check de fidelidad no fue vacuo", cachedWindowCount === 0 || evaluated > 0, cachedWindowCount === 0 ? "sin caché en el rango (nada que comparar)" : `${evaluated} documentos`);

    if (PARITY) await parity(client);

    console.log(`\nverify-qb-gl-import: ${failures === 0 ? "VERDE" : `${failures} FALLA(S)`}`);
    process.exitCode = failures ? 1 : 0;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
