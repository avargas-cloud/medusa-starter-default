/**
 * adopt-qb-bank-documents — los cheques, gastos, cargos de tarjeta y traspasos de
 * QuickBooks que entraron al libro como `qb_import` pasan a documentos NATIVOS del
 * POS (`gl_check` check|expense|card_charge, `gl_transfer`) adoptando el TxnID de
 * QB — sin ADD/MOD a QuickBooks — y re-parentando el asiento existente (mismas
 * líneas, mismos matches, mismos extractos cerrados). Después renumera TODA la
 * serie CHK-/TR- en orden cronológico (plan adopt-qb-bank-documents-20260915).
 * Diseño: docs/QB_BANK_DOCUMENTS_ADOPTION.md.
 *
 *   DRY-RUN (default): censo por tipo/destino/cuenta/mes, no-mapeados, payees sin
 *   resolver, mapeo de renumeración; escribe el reporte en .qb-docs-cache/bank/.
 *
 *   ECOPOWERTECH_ENV=sandbox DATABASE_URL=postgresql://…:5499/medusa_chk \
 *     ./node_modules/.bin/tsx src/scripts/ledger/adopt-qb-bank-documents.ts \
 *       [--from 2026-01-01] [--to 2026-09-30] [--no-bridge] [--apply] [--actor email]
 *
 *   --apply   UNA transacción: adopta todos los documentos mapeables de la ventana
 *             + renumera la serie completa. Idempotente por TxnID (lo ya adoptado se
 *             saltea; una 2ª corrida no cambia nada). Producción exige además
 *             --target-production + CONFIRM_PRODUCTION_RUN=<run id> + el reporte del
 *             dry-run previo (target-guard).
 *   --revert  deshace la adopción de la ventana: asientos vuelven a qb_import,
 *             documentos adoptados → deleted_at, filas del pipeline → skipped,
 *             números anteriores restaurados desde el mapeo guardado en el reporte.
 *   --no-bridge  payee sólo por nombre del snapshot (sin CheckQuery a QuickBooks).
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolClient } from "pg";

import { getDbPool } from "../../api/utils/db-pool";
import { applyAdoption, revertAdoption, type AdoptionPlanItem } from "../../lib/ledger/adopt/apply";
import { buildCensus, money, renderCensus, type Classified } from "../../lib/ledger/adopt/census";
import { classifyImportedBankDocument } from "../../lib/ledger/adopt/classify-imported";
import { loadImportedBankEntries } from "../../lib/ledger/adopt/load-imported";
import { resolvePayees, type PayeeSource } from "../../lib/ledger/adopt/payee";
import { planRenumber } from "../../lib/ledger/adopt/renumber";
import {
  assertDryRunEvidence,
  formatWriteTargetError,
  latestFile,
  readJsonFile,
  resolveWriteTarget,
} from "../../lib/qb-backfill/target-guard";

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
};
const FROM = flag("--from") ?? "2026-01-01";
const TO = flag("--to") ?? "2026-12-31";
const APPLY = argv.includes("--apply");
const REVERT = argv.includes("--revert");
const NO_BRIDGE = argv.includes("--no-bridge");
const ACTOR = flag("--actor") ?? "a.vargas@ecopowertech.com";
const RUN_ID = `adopt_${FROM}_${TO}`;
const CACHE_DIR = join(process.cwd(), ".qb-docs-cache", "bank");
const REPORT_RE = new RegExp(`^${RUN_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_dry-run_.*\\.json$`);

const log = (line: string) => console.log(line);

type RenumberMap = Array<{ table: "gl_check" | "gl_transfer"; id: string; from: string; to: string }>;
function allApplyReports(dir: string, runId: string): Array<{ renumber: RenumberMap }> {
  if (!existsSync(dir)) return [];
  const prefix = `${runId}_apply_`;
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .sort()
    .map((f) => readJsonFile<{ renumber: RenumberMap }>(join(dir, f)))
    .filter((r): r is { renumber: RenumberMap } => !!r && Array.isArray(r.renumber));
}

async function main(): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(FROM) || !/^\d{4}-\d{2}-\d{2}$/.test(TO)) throw new Error("--from/--to YYYY-MM-DD");
  if (FROM < "2026-01-01") throw new Error("2025 está cerrado: la ventana empieza en 2026-01-01 como mínimo");
  if (APPLY && REVERT) throw new Error("--apply y --revert son excluyentes");
  const pool = getDbPool();
  const client: PoolClient = await pool.connect();
  try {
    const actor = (await client.query<{ id: string }>(`SELECT id FROM "user" WHERE lower(email)=lower($1) AND deleted_at IS NULL`, [ACTOR])).rows[0];
    if (!actor) throw new Error(`actor no encontrado: ${ACTOR}`);

    if (REVERT) {
      // Todos los reportes de --apply de este run, del más viejo al más nuevo: el número ORIGINAL
      // de un nativo es el `from` de la primera vez que se lo vio (una 2ª corrida encadena mapeos).
      const reports = allApplyReports(CACHE_DIR, RUN_ID);
      if (!reports.length) throw new Error("--revert necesita el reporte del --apply en .qb-docs-cache/bank/ (mapeo de renumeración)");
      const original = new Map<string, { table: "gl_check" | "gl_transfer"; id: string; from: string; to: string }>();
      for (const r of reports) for (const m of r.renumber) if (!original.has(`${m.table}:${m.id}`)) original.set(`${m.table}:${m.id}`, m);
      const target = resolveWriteTarget({ argv, env: process.env, databaseUrl: process.env.DATABASE_URL, runId: RUN_ID });
      log(`destino: ${target.target} (${target.dbTarget}) · revert con ${reports.length} reporte(s) de apply · ${original.size} números originales`);
      const r = await revertAdoption(client, { from: FROM, to: TO, renumber: [...original.values()], actorId: actor.id });
      log(`revert: ${r.reverted} documentos devueltos a qb_import · ${r.renumbered} números restaurados · ${r.skipped} ya revertidos`);
      return;
    }

    const loaded = await loadImportedBankEntries(client, { from: FROM, to: TO });
    const items: Classified[] = loaded.entries.map((entry) => ({ entry, decision: classifyImportedBankDocument(entry) }));
    const census = buildCensus(items);
    for (const line of renderCensus(census)) log(line);
    const already = items.filter((i) => loaded.already.has(i.entry.txn_id));
    log(`ya adoptados (se saltean): ${already.length}`);

    const pending = items.filter((i) => i.decision.target !== "unmapped" && !loaded.already.has(i.entry.txn_id));
    const source: PayeeSource = NO_BRIDGE ? "snapshot" : "bridge";
    const payees = await resolvePayees(client, pending.map((p) => p.entry), { source, cacheDir: CACHE_DIR, from: FROM, to: TO, log });
    const unresolved = pending.filter((p) => p.decision.target === "gl_check" && payees.get(p.entry.txn_id)?.payee_type === "other");
    log(`payees: vendor ${[...payees.values()].filter((p) => p.payee_type === "vendor").length} · customer ${[...payees.values()].filter((p) => p.payee_type === "customer").length} · other ${unresolved.length} (nombre libre)`);
    const otherNames = new Map<string, number>();
    for (const u of unresolved) otherNames.set(payees.get(u.entry.txn_id)!.payee_name, (otherNames.get(payees.get(u.entry.txn_id)!.payee_name) ?? 0) + 1);
    for (const [name, n] of [...otherNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) log(`  other · ${name.padEnd(40)} ${n}`);

    const plan: AdoptionPlanItem[] = pending.map((p) => ({ entry: p.entry, decision: p.decision, payee: payees.get(p.entry.txn_id) ?? null }));
    const renumber = await planRenumber(client, plan);
    log(`renumeración: ${renumber.checks.length} CHK (${renumber.checkChanges} cambian) · ${renumber.transfers.length} TR (${renumber.transferChanges} cambian)`);

    mkdirSync(CACHE_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const cardinality = {
      window: `${FROM}..${TO}`,
      adoptable: census.total,
      to_adopt: plan.length,
      gl_check: plan.filter((p) => p.decision.target === "gl_check").length,
      gl_transfer: plan.filter((p) => p.decision.target === "gl_transfer").length,
      unmapped: census.unmapped.length,
      already_adopted: already.length,
      renumber_changes: renumber.checkChanges + renumber.transferChanges,
      payee_other: unresolved.length,
    };
    if (!APPLY) {
      const path = join(CACHE_DIR, `${RUN_ID}_dry-run_${stamp}.json`);
      writeFileSync(path, JSON.stringify({ run_id: RUN_ID, cardinality, unmapped: census.unmapped, other_names: [...otherNames.entries()], renumber_preview: renumber.preview.slice(0, 50) }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
      log(`\nDRY-RUN: no se escribió nada. Reporte: ${path}\nUsá --apply (sandbox) o --apply --target-production + CONFIRM_PRODUCTION_RUN=${RUN_ID} (prod).`);
      return;
    }

    const target = resolveWriteTarget({ argv, env: process.env, databaseUrl: process.env.DATABASE_URL, runId: RUN_ID });
    const evidencePath = latestFile(CACHE_DIR, REPORT_RE);
    const evidence = evidencePath ? readJsonFile<{ cardinality: Record<string, number | string> }>(evidencePath) : null;
    assertDryRunEvidence(target.target, RUN_ID, evidence ? { path: evidencePath!, cardinality: evidence.cardinality } : null, log);
    log(`destino: ${target.target} (${target.dbTarget}) · aplicando ${plan.length} adopciones + renumeración en UNA transacción`);
    const result = await applyAdoption(client, { plan, renumber, actorId: actor.id });
    const path = join(CACHE_DIR, `${RUN_ID}_apply_${stamp}.json`);
    writeFileSync(path, JSON.stringify({ run_id: RUN_ID, cardinality, result: { adopted: result.adopted, renumbered: result.renumbered }, renumber: result.renumberMap }, null, 2));
    log(`aplicado: ${result.adopted.gl_check} gl_check · ${result.adopted.gl_transfer} gl_transfer · ${result.renumbered} renumerados · ${money(result.totalCents)} · reporte ${path}`);
  } finally {
    client.release();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error("adopt-qb-bank-documents:", formatWriteTargetError(e));
    process.exit(1);
  });
