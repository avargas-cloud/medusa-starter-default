/**
 * relink-qb-backfill-bills — fix del plan `qb-docs-backfill-compras-20260911`:
 * `applyBills` resolvió el PO local de un bill contra el índice de POs *en
 * el momento en que corrió* (`resolveLocalPoByLinkedTxns`) — los POs de 2025
 * llegaron DESPUÉS por `follow-links.ts`, así que 34 bills quedaron con
 * `purchase_order_id IS NULL` y sus líneas de producto sin
 * `purchase_order_line_id`, aunque el `LinkedTxn` (PurchaseOrder) del bill
 * en QB apunta a un PO que hoy existe en `purchase_order`.
 *
 *   DATABASE_URL=… ECOPOWERTECH_ENV=sandbox \
 *   ./node_modules/.bin/tsx src/scripts/sync/relink-qb-backfill-bills.ts \
 *     --cache-dir .qb-docs-cache --run-id qbbf-relink-20260911 [--apply] [--rollback]
 *
 * DRY-RUN por default: imprime el plan (bill → PO) y cuenta por año.
 * `--apply` aplica (setea `purchase_order_id`/`purchase_order_line_id`, NUNCA
 * toca amounts/costs/status/stock/pipeline). `--rollback` revierte por el
 * marcador de `notes` de ese `--run-id`. `--apply` exige sandbox
 * (`ECOPOWERTECH_ENV=sandbox` + DATABASE_URL en :5499) o el camino explícito de
 * producción — `lib/qb-backfill/target-guard.ts`. El dry-run deja
 * `<cache-dir>/relink-plan_<run>.json` (cardinalidad del plan).
 *
 * PRODUCCIÓN (lo corre el OPERADOR desde su terminal, `! <cmd>`). Primero el
 * dry-run contra prod con el MISMO `--run-id` (sin él `--target-production` se
 * niega), después:
 *
 *   cd backend && nohup env DATABASE_URL="$(grep ^DATABASE_URL= .env|cut -d= -f2-)" \
 *     ECOPOWERTECH_ENV=production DISABLE_SCHEDULED_JOBS=true \
 *     CONFIRM_PRODUCTION_RUN=qbbf-relink-prod-20260911 \
 *     ./node_modules/.bin/tsx src/scripts/sync/relink-qb-backfill-bills.ts \
 *       --cache-dir .qb-docs-cache --run-id qbbf-relink-prod-20260911 --apply --target-production \
 *     > .qb-docs-cache/relink-prod_qbbf-relink-prod-20260911.log 2>&1 &
 *
 *   (nunca la URL literal; tarda más de 2 min → nohup … &)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

import { normalizeBills } from "../../lib/qb-backfill/normalize";
import { loadPoIndex } from "../../lib/qb-backfill/apply-purchases";
import {
  applyBillRelink,
  indexPoLinesById,
  loadPoNumberIndex,
  planBillRelinks,
  rollbackBillRelink,
  type BillRelinkRow,
} from "../../lib/qb-backfill/relink-bills";
import { assertDryRunEvidence, formatWriteTargetError, readJsonFile, resolveWriteTarget } from "../../lib/qb-backfill/target-guard";
import type { QbBill } from "../../lib/qb-backfill/types";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const CACHE_DIR = arg("cache-dir", ".qb-docs-cache") as string;
const RUN_ID = arg("run-id");
const APPLY = flag("apply");
const ROLLBACK = flag("rollback");

if (!RUN_ID) {
  console.error("uso: --run-id ID [--cache-dir DIR] [--apply] [--rollback]");
  process.exit(2);
}
if (APPLY && ROLLBACK) {
  console.error("--apply y --rollback son mutuamente excluyentes");
  process.exit(2);
}
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL es obligatoria");
  process.exit(2);
}
const PLAN_PATH = join(CACHE_DIR, `relink-plan_${RUN_ID}.json`);
if (APPLY) {
  try {
    const target = resolveWriteTarget({ argv: process.argv, env: process.env, databaseUrl: DATABASE_URL, runId: RUN_ID });
    console.log(`destino: ${target.target} (${target.reason})`);
    const plan = existsSync(PLAN_PATH) ? readJsonFile<{ plan_count?: number; by_year?: Record<string, number> }>(PLAN_PATH) : null;
    assertDryRunEvidence(
      target.target,
      RUN_ID,
      plan ? { path: PLAN_PATH, cardinality: { plan_count: plan.plan_count ?? null, by_year: JSON.stringify(plan.by_year ?? {}) } } : null,
      (l) => console.log(l)
    );
  } catch (err) {
    console.error(formatWriteTargetError(err));
    process.exit(2);
  }
}

/** Lee TODOS los bills cacheados (ventanas mensuales `bill_<from>_<to>.json` + lotes por TxnID `bill_bytxn_*.json`) y dedupea por TxnID — el mismo bill puede vivir en más de un archivo (ventana + follow-links). */
function loadCachedBills(cacheDir: string): QbBill[] {
  if (!existsSync(cacheDir)) return [];
  const files = readdirSync(cacheDir).filter((f) =>
    /^bill_(\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}|bytxn_[0-9a-f]+)\.json$/.test(f)
  );
  const byTxnId = new Map<string, QbBill>();
  for (const f of files) {
    const raw = JSON.parse(readFileSync(join(cacheDir, f), "utf8")) as Record<string, unknown> | null;
    for (const bill of normalizeBills(raw)) byTxnId.set(bill.txn_id, bill);
  }
  return [...byTxnId.values()];
}

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  const client = await pool.connect();
  try {
    if (ROLLBACK) {
      console.log(`relink-qb-backfill-bills · run ${RUN_ID} · ROLLBACK`);
      const result = await rollbackBillRelink(client, RUN_ID as string);
      console.log(`bills revertidos: ${result.bills_reverted} · líneas revertidas: ${result.lines_reverted}`);
      return;
    }

    console.log(`relink-qb-backfill-bills · run ${RUN_ID} · ${APPLY ? "APPLY" : "DRY-RUN"} · cache ${CACHE_DIR}`);
    const bills = loadCachedBills(CACHE_DIR);
    console.log(`bills en caché (dedup por TxnID): ${bills.length}`);

    const { rows: billRows } = await client.query(
      `SELECT id, qb_txn_id, purchase_order_id, number FROM vendor_bill
        WHERE deleted_at IS NULL AND qb_txn_id IS NOT NULL AND purchase_order_id IS NULL`
    );
    console.log(`vendor_bill con purchase_order_id NULL: ${billRows.length}`);

    const poIndex = await loadPoIndex(client);
    const poNumberById = await loadPoNumberIndex(client);
    const poLinesById = indexPoLinesById(poIndex);
    const billNumberById = new Map(
      (billRows as { id: string; number: string }[]).map((r) => [r.id, r.number])
    );

    const plan = planBillRelinks(
      bills,
      billRows as BillRelinkRow[],
      poIndex,
      poNumberById
    );

    console.log(`\n── Plan (${plan.length} bill(s) a relinkear) ──`);
    const byYear = new Map<string, number>();
    const billByTxnId = new Map(bills.map((b) => [b.txn_id, b]));
    for (const r of plan) {
      const billNumber = billNumberById.get(r.vendor_bill_id) ?? r.vendor_bill_id;
      console.log(`  ${billNumber} (${r.qb_txn_id}) → ${r.po_number}`);
      const year = billByTxnId.get(r.qb_txn_id)?.txn_date.slice(0, 4) ?? "?";
      byYear.set(year, (byYear.get(year) ?? 0) + 1);
    }
    console.log(`por año: ${JSON.stringify(Object.fromEntries([...byYear.entries()].sort()))}`);

    if (!APPLY) {
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(
        PLAN_PATH,
        JSON.stringify({ run_id: RUN_ID, apply: false, plan_count: plan.length, by_year: Object.fromEntries([...byYear.entries()].sort()), plan }, null, 1)
      );
      console.log(`plan: ${PLAN_PATH}`);
      console.log(`\nDRY-RUN — nada aplicado. Correr con --apply para relinkear.`);
      return;
    }

    let applied = 0;
    let linesMatched = 0;
    const blocked: { qb_txn_id: string; reason: string }[] = [];
    for (const r of plan) {
      const poLines = poLinesById.get(r.po_id) ?? [];
      try {
        const result = await applyBillRelink(client, r, poLines, RUN_ID as string);
        applied++;
        linesMatched += result.lines_matched;
      } catch (err) {
        blocked.push({ qb_txn_id: r.qb_txn_id, reason: (err as Error).message });
      }
    }
    console.log(`\naplicados: ${applied}/${plan.length} · líneas matcheadas: ${linesMatched} · bloqueados: ${blocked.length}`);
    for (const b of blocked) console.log(`  bloqueado ${b.qb_txn_id}: ${b.reason}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
