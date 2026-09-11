/**
 * import-qb-general-ledger — trae el reporte General Ledger de QuickBooks al
 * libro del POS como documentos `qb_import` (uno por TxnID). Diseño y reglas:
 * docs/QB_GL_IMPORT.md.
 *
 *   DATABASE_URL=… QB_BRIDGE_URL=… QB_API_KEY=… ECOPOWERTECH_ENV=sandbox \
 *   ./node_modules/.bin/tsx src/scripts/sync/import-qb-general-ledger.ts \
 *     --from 2026-01-01 --to 2026-09-11 [--apply] [--window-days 7] \
 *     [--cache-dir .qb-gl-cache] [--cutoff 2026-04-13] [--pause-ms 10000]
 *
 * - DRY-RUN por default: descarga (o lee de caché), parsea, clasifica, arma y
 *   cuenta. NO escribe en la DB. `--apply` postea.
 * - `--apply` exige `ECOPOWERTECH_ENV=sandbox`; contra producción hace falta
 *   además `--target-production` (checkpoint R3 del plan, con la cardinalidad
 *   medida acá).
 * - Idempotente: re-correr con `--apply` cuenta `already_posted`, nunca duplica.
 * - La fidelidad del parseo se afirma por ventana contra los subtotales por
 *   cuenta del propio reporte; una ventana que no cuadra ABORTA la corrida.
 * - Sólo lectura contra QuickBooks (GeneralDetailReportQueryRq).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { reverseDocumentJournal } from "../../lib/ledger/post";
import {
  assembleDocuments,
  classify,
  fetchGeneralLedgerWindow,
  loadPosKnownTxnIds,
  loadQbAccountIndex,
  missingAccounts,
  parseGeneralLedgerReport,
  postQbDocument,
  POS_CUTOFF_DAY,
  reportWindows,
  verifyParsedTotals,
} from "../../lib/ledger/qb-import";
import type { BlockedDocument, ImportPolicy, QbGlDocument } from "../../lib/ledger/qb-import";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const FROM = arg("from");
const TO = arg("to");
const APPLY = flag("apply");
const WINDOW_DAYS = Number(arg("window-days", "7"));
const CACHE_DIR = arg("cache-dir", ".qb-gl-cache") as string;
const CUTOFF = arg("cutoff", POS_CUTOFF_DAY) as string;
const PAUSE_MS = Number(arg("pause-ms", "10000"));

if (!FROM || !TO) {
  console.error("uso: --from YYYY-MM-DD --to YYYY-MM-DD [--apply] [--window-days N] [--cache-dir DIR] [--cutoff YYYY-MM-DD]");
  process.exit(2);
}
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL es obligatoria");
  process.exit(2);
}
if (APPLY && process.env.ECOPOWERTECH_ENV !== "sandbox" && !flag("target-production")) {
  console.error("--apply fuera de sandbox exige --target-production (checkpoint R3)");
  process.exit(2);
}

const dbTarget = (() => {
  try {
    const u = new URL(DATABASE_URL);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "<url ilegible>";
  }
})();

type TypeCounter = Record<string, { import: number; import_qb_only: number; skip_after_cutoff: number; blocked: number }>;
const bump = (c: TypeCounter, t: string, k: keyof TypeCounter[string]) => {
  c[t] = c[t] ?? { import: 0, import_qb_only: 0, skip_after_cutoff: 0, blocked: 0 };
  c[t][k] += 1;
};

async function main() {
  console.log(`import-qb-general-ledger ${FROM}..${TO} · ventanas de ${WINDOW_DAYS} días · corte POS ${CUTOFF} · ${APPLY ? "APPLY" : "DRY-RUN"} · db ${dbTarget}`);
  mkdirSync(CACHE_DIR, { recursive: true });
  const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  const client = await pool.connect();
  const started = Date.now();
  // Propiedad por IDENTIDAD (docs/QB_GL_IMPORT.md §2): un tipo del POS después del corte se
  // omite sólo si el POS sincronizó ese TxnID; lo hecho directo en QB entra desde QB.
  const known = await loadPosKnownTxnIds(client);
  console.log(`TxnIDs enlazados a documentos del POS: ${known.size}`);
  const byType: TypeCounter = {};
  const blocked: BlockedDocument[] = [];
  const toImport: Array<{ doc: QbGlDocument; policy: ImportPolicy; window: string }> = [];
  const perAccount = new Map<string, { debit: bigint; credit: bigint }>();
  let windows = 0;
  let fetched = 0;
  let zeroRows = 0;
  let zeroDocs = 0;

  try {
    for (const w of reportWindows(FROM as string, TO as string, WINDOW_DAYS)) {
      windows += 1;
      const label = `${w.from}..${w.to}`;
      const { report: raw, cached } = await fetchGeneralLedgerWindow(w.from, w.to, {
        cacheDir: CACHE_DIR,
        log: (l) => console.log(l),
      });
      if (!cached) fetched += 1;
      const report = parseGeneralLedgerReport(raw, w);
      const mismatches = verifyParsedTotals(report);
      if (mismatches.length) {
        console.error(`✗ ventana ${label}: ${mismatches.length} cuenta(s) no cuadran contra los subtotales de QB — se aborta`);
        for (const m of mismatches.slice(0, 10))
          console.error(`    ${m.account}: esperado D${m.expected_debit}/C${m.expected_credit} · leído D${m.actual_debit}/C${m.actual_credit}`);
        process.exitCode = 1;
        return;
      }
      const assembled = assembleDocuments(report.rows);
      zeroRows += assembled.dropped_zero_rows;
      zeroDocs += assembled.skipped_zero_documents;
      // Un documento que igual se omitiría (tipo del POS después del corte) no cuenta como
      // bloqueado: p. ej. un Credit Memo del POS y su copia voideada del 2026-04-21.
      for (const b of assembled.blocked) {
        // un bloqueado por clave (sin TxnID propio) sólo se puede omitir si el POS conoce su TxnID
        const decision = classify(b.txn_type, b.date, CUTOFF, known.has(b.key));
        if (decision.action === "skip_pos_owned_after_cutoff") bump(byType, b.txn_type, "skip_after_cutoff");
        else blocked.push(b);
      }
      for (const doc of assembled.documents) {
        const decision = classify(doc.txn_type, doc.date, CUTOFF, known.has(doc.txn_id));
        if (decision.action === "blocked_unknown_type") {
          bump(byType, doc.txn_type, "blocked");
          blocked.push({ key: doc.txn_id, txn_type: doc.txn_type, date: doc.date, reason: "unknown_type", rows: doc.rows.length });
          continue;
        }
        if (decision.action === "skip_pos_owned_after_cutoff") {
          bump(byType, doc.txn_type, "skip_after_cutoff");
          continue;
        }
        bump(byType, doc.txn_type, decision.qb_only ? "import_qb_only" : "import");
        toImport.push({ doc, policy: decision.policy, window: label });
        for (const r of doc.rows) {
          const s = perAccount.get(r.account) ?? { debit: 0n, credit: 0n };
          s.debit += r.debit_cents;
          s.credit += r.credit_cents;
          perAccount.set(r.account, s);
        }
      }
      console.log(`✓ ${label}${cached ? " (caché)" : ""}: ${report.rows.length} filas · ${assembled.documents.length} docs · bloqueados ${assembled.blocked.length}`);
      if (!cached && PAUSE_MS > 0) await new Promise((r) => setTimeout(r, PAUSE_MS));
    }

    const accounts = await loadQbAccountIndex(client);
    const names = new Set<string>();
    for (const { doc } of toImport) for (const r of doc.rows) names.add(r.account);
    const missing = missingAccounts(accounts, names);
    const ready = toImport.filter(({ doc }) => doc.rows.every((r) => accounts.has(r.account)));
    for (const { doc } of toImport) {
      if (ready.some((x) => x.doc === doc)) continue;
      const bad = doc.rows.filter((r) => !accounts.has(r.account)).map((r) => r.account);
      blocked.push({ key: doc.txn_id, txn_type: doc.txn_type, date: doc.date, reason: "unknown_account", detail: [...new Set(bad)].join(" | "), rows: doc.rows.length });
    }

    // No doble conteo, hacia atrás: un qb_import posterior al corte cuyo TxnID el POS conoce
    // (p. ej. un recibo que el POS sincronizó después, o uno importado con una regla anterior)
    // se REVERSA — append-only, mismo mecanismo que cualquier documento del GL.
    const doubled = await client.query<{ source_id: string; day: string }>(
      `SELECT e.source_id, e.day FROM bank_journal_entry e
        WHERE e.source_kind = 'qb_import' AND e.kind = 'document' AND e.deleted_at IS NULL
          AND e.reverses_entry_id IS NULL AND e.day > $1
          AND e.source_id = ANY($2::text[])
          AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id AND r.deleted_at IS NULL)`,
      [CUTOFF, [...known]]
    );
    const reconcile = { candidates: doubled.rowCount ?? 0, reversed: 0, failed: 0 };
    if (APPLY) {
      for (const row of doubled.rows) {
        try {
          const r = await reverseDocumentJournal(client, {
            source_kind: "qb_import",
            source_id: row.source_id,
            day: row.day,
            reason: "qb-gl-import: el POS sincronizó este documento (TxnID enlazado); lo postea el replay del GL",
            actor_id: "qb-gl-import",
          });
          if (r.status === "reversed") reconcile.reversed += 1;
        } catch {
          reconcile.failed += 1;
        }
      }
    }

    const result = { posted: 0, already_posted: 0, failed: 0, failures: [] as Array<{ txn_id: string; error: string }> };
    if (APPLY) {
      for (const { doc, policy } of ready) {
        try {
          const r = await postQbDocument(client, doc, policy, accounts);
          if (r.status === "posted") result.posted += 1;
          else if (r.status === "already_posted") result.already_posted += 1;
          else result.failed += 1;
        } catch (err) {
          result.failed += 1;
          const message = err instanceof Error ? `${err.message} ${JSON.stringify((err as { details?: unknown }).details ?? "")}` : String(err);
          result.failures.push({ txn_id: doc.txn_id, error: message.slice(0, 300) });
        }
      }
    }

    const summary = {
      range: { from: FROM, to: TO, cutoff: CUTOFF, window_days: WINDOW_DAYS },
      mode: APPLY ? "apply" : "dry-run",
      db: dbTarget,
      windows,
      fetched_from_bridge: fetched,
      zero_rows_dropped: zeroRows,
      zero_documents_skipped: zeroDocs,
      by_type: byType,
      documents_to_import: toImport.length,
      documents_ready: ready.length,
      missing_accounts: missing,
      blocked_count: blocked.length,
      blocked: blocked.slice(0, 500),
      per_account_in_scope: [...perAccount.entries()].map(([account, s]) => ({ account, debit_cents: s.debit.toString(), credit_cents: s.credit.toString() })),
      apply: APPLY ? result : null,
      reconcile_known_after_cutoff: reconcile,
      elapsed_s: Math.round((Date.now() - started) / 1000),
    };
    const out = join(CACHE_DIR, `import-report_${FROM}_${TO}_${APPLY ? "apply" : "dry"}_${Date.now()}.json`);
    writeFileSync(out, JSON.stringify(summary, null, 2));

    console.log("\n════ resumen ════");
    console.log(`ventanas ${windows} (bridge ${fetched}) · filas cero ${zeroRows} · docs voideados ${zeroDocs}`);
    console.log("por tipo (import / import sólo-QB post-corte / omitidos = el POS los sincronizó / bloqueados):");
    for (const [t, c] of Object.entries(byType).sort()) console.log(`  ${t.padEnd(22)} ${String(c.import).padStart(5)} ${String(c.import_qb_only).padStart(6)} ${String(c.skip_after_cutoff).padStart(6)} ${String(c.blocked).padStart(5)}`);
    console.log(`a importar ${toImport.length} · listos ${ready.length} · bloqueados ${blocked.length}`);
    if (missing.length) console.log(`cuentas sin espejo (${missing.length}): ${missing.join(" | ")}`);
    const reasons = blocked.reduce<Record<string, number>>((acc, b) => ((acc[b.reason] = (acc[b.reason] ?? 0) + 1), acc), {});
    if (blocked.length) console.log(`bloqueados por motivo: ${JSON.stringify(reasons)}`);
    console.log(`doble conteo hacia atrás (qb_import post-corte con TxnID del POS): candidatos ${reconcile.candidates}${APPLY ? ` · reversados ${reconcile.reversed} · fallaron ${reconcile.failed}` : " (dry-run: no se reversa)"}`);
    if (APPLY) {
      console.log(`APPLY: posteados ${result.posted} · ya estaban ${result.already_posted} · fallaron ${result.failed}`);
      for (const f of result.failures.slice(0, 20)) console.log(`  ✗ ${f.txn_id}: ${f.error}`);
    }
    console.log(`reporte: ${out}`);
    if (blocked.length || (APPLY && result.failed)) process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("import-qb-general-ledger: error fatal", err);
  process.exit(1);
});
