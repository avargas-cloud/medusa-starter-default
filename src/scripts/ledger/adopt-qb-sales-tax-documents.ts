/**
 * adopt-qb-sales-tax-documents — los "Sales Tax Payment" y los "General Journal"
 * de ajuste de sales tax que el importador del General Ledger trajo como
 * `qb_import` pasan a documentos NATIVOS del POS (`gl_sales_tax_payment` STP-####,
 * `gl_sales_tax_adjustment` STA-####) adoptando el TxnID — sin ADD/MOD a
 * QuickBooks — y re-parentando el asiento existente (plan sales-tax-center-20260917).
 *
 *   DRY-RUN (default): lista cada documento con su destino, período y montos;
 *   escribe el reporte en .qb-docs-cache/sales-tax/.
 *
 *   ECOPOWERTECH_ENV=sandbox DATABASE_URL=postgresql://…:5499/medusa_chk \
 *     ./node_modules/.bin/tsx src/scripts/ledger/adopt-qb-sales-tax-documents.ts \
 *       [--from 2026-01-01] [--to 2026-12-31] [--apply | --revert] [--actor email]
 *
 *   --apply   UNA transacción. Idempotente por TxnID (lo ya adoptado se saltea).
 *             Producción exige además --target-production + CONFIRM_PRODUCTION_RUN=<run id>
 *             + el reporte del dry-run previo (target-guard).
 *   --revert  deshace la adopción de la ventana (documentos → deleted_at, asientos →
 *             qb_import, filas del pipeline → skipped).
 *
 * Requiere Settings de Sales Tax configurados (tax item + vendor): el vendor es lo
 * que distingue un JE de ajuste de sales tax de cualquier otro General Journal.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { PoolClient } from "pg";

import { getDbPool } from "../../api/utils/db-pool";
import { money } from "../../lib/ledger/adopt/census";
import {
  assertDryRunEvidence,
  latestFile,
  readJsonFile,
  resolveWriteTarget,
} from "../../lib/qb-backfill/target-guard";
import {
  applySalesTaxAdoption,
  classifyImportedSalesTax,
  loadImportedSalesTaxEntries,
  revertSalesTaxAdoption,
  type SalesTaxAdoptionItem,
} from "../../lib/sales-tax/adopt";
import { loadSalesTaxSettings } from "../../lib/sales-tax/settings";

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
};
const FROM = flag("--from") ?? "2026-01-01";
const TO = flag("--to") ?? "2026-12-31";
const APPLY = argv.includes("--apply");
const REVERT = argv.includes("--revert");
const ACTOR = flag("--actor") ?? "a.vargas@ecopowertech.com";
const RUN_ID = `adopt_sales_tax_${FROM}_${TO}`;
const CACHE_DIR = join(process.cwd(), ".qb-docs-cache", "sales-tax");
const REPORT_RE = new RegExp(`^${RUN_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_dry-run_.*\\.json$`);
const log = (line: string): void => process.stdout.write(`${line}\n`);

async function main(): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(FROM) || !/^\d{4}-\d{2}-\d{2}$/.test(TO)) throw new Error("--from/--to YYYY-MM-DD");
  if (FROM < "2026-01-01") throw new Error("2025 está cerrado: la ventana empieza en 2026-01-01 como mínimo");
  if (APPLY && REVERT) throw new Error("--apply y --revert son excluyentes");
  const pool = getDbPool();
  const client: PoolClient = await pool.connect();
  try {
    const actor = (await client.query<{ id: string }>(`SELECT id FROM "user" WHERE lower(email)=lower($1) AND deleted_at IS NULL`, [ACTOR])).rows[0];
    if (!actor) throw new Error(`actor no encontrado: ${ACTOR}`);
    const settings = await loadSalesTaxSettings(client);
    if (!settings.ready) throw new Error(`Sales Tax settings incompletos: faltan ${settings.missing.join(", ")} (configurar en Accounting → Sales Tax → Settings)`);

    if (REVERT) {
      const target = resolveWriteTarget({ argv, env: process.env, databaseUrl: process.env.DATABASE_URL, runId: RUN_ID });
      log(`destino: ${target.target} (${target.dbTarget}) · revert ${FROM}..${TO}`);
      const r = await revertSalesTaxAdoption(client, { from: FROM, to: TO });
      log(`revert: ${r.reverted} documentos devueltos a qb_import`);
      return;
    }

    const loaded = await loadImportedSalesTaxEntries(client, settings, { from: FROM, to: TO });
    const items: SalesTaxAdoptionItem[] = loaded.entries.map((entry) => ({ entry, decision: classifyImportedSalesTax(entry, settings) }));
    const already = items.filter((i) => loaded.already.has(i.entry.txn_id));
    const pending = items.filter((i) => i.decision.target !== "unmapped" && !loaded.already.has(i.entry.txn_id));
    const unmapped = items.filter((i) => i.decision.target === "unmapped");
    log(`importados en ventana: ${items.length} · adoptables: ${pending.length} · ya adoptados: ${already.length} · no mapeados: ${unmapped.length}`);
    for (const i of items) {
      const d = i.decision;
      const tag = loaded.already.has(i.entry.txn_id) ? "already" : d.target;
      const detail =
        d.target === "gl_sales_tax_payment"
          ? `period ${d.period} · tax ${money(d.tax_cents)} · adj ${money(d.adjustments_cents)} · bank ${money(d.total_cents)}`
          : d.target === "gl_sales_tax_adjustment"
            ? `period ${d.period} · ${d.type} ${d.direction} ${money(d.amount_cents)}`
            : d.reason;
      log(`  ${i.entry.day} ${i.entry.txn_type.padEnd(18)} ${i.entry.txn_id.padEnd(18)} ${tag.padEnd(24)} ${detail}`);
    }
    const totalCents = pending.reduce((acc, p) => acc + (p.decision.target === "gl_sales_tax_payment" ? p.decision.total_cents : 0n), 0n);
    const cardinality = {
      window: `${FROM}..${TO}`,
      to_adopt: pending.length,
      payments: pending.filter((p) => p.decision.target === "gl_sales_tax_payment").length,
      adjustments: pending.filter((p) => p.decision.target === "gl_sales_tax_adjustment").length,
      unmapped: unmapped.length,
      already_adopted: already.length,
      payments_total: money(totalCents),
    };
    mkdirSync(CACHE_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    if (!APPLY) {
      const path = join(CACHE_DIR, `${RUN_ID}_dry-run_${stamp}.json`);
      writeFileSync(
        path,
        JSON.stringify({ run_id: RUN_ID, cardinality, items: items.map((i) => ({ txn_id: i.entry.txn_id, day: i.entry.day, decision: i.decision })) }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)
      );
      log(`\nDRY-RUN: no se escribió nada. Reporte: ${path}\nUsá --apply (sandbox) o --apply --target-production + CONFIRM_PRODUCTION_RUN=${RUN_ID} (prod).`);
      return;
    }
    const target = resolveWriteTarget({ argv, env: process.env, databaseUrl: process.env.DATABASE_URL, runId: RUN_ID });
    const evidencePath = latestFile(CACHE_DIR, REPORT_RE);
    const evidence = evidencePath ? readJsonFile<{ cardinality: Record<string, number | string> }>(evidencePath) : null;
    assertDryRunEvidence(target.target, RUN_ID, evidence ? { path: evidencePath!, cardinality: evidence.cardinality } : null, log);
    log(`destino: ${target.target} (${target.dbTarget}) · aplicando ${pending.length} adopciones en UNA transacción`);
    const result = await applySalesTaxAdoption(client, { plan: pending, settings, actorId: actor.id });
    const path = join(CACHE_DIR, `${RUN_ID}_apply_${stamp}.json`);
    writeFileSync(path, JSON.stringify({ run_id: RUN_ID, cardinality, result: { ...result, totalCents: result.totalCents.toString() } }, null, 2));
    log(`aplicado: ${result.payments} STP · ${result.adjustments} STA · ${result.applied_links} enlaces pago↔ajuste · ${money(result.totalCents)} · reporte ${path}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
