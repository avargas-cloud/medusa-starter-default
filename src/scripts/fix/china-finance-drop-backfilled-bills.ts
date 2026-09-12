/**
 * Borra las filas de `china_finance_bill` que `syncVeetchBills`
 * (`src/api/admin/china-finance/bills/route.ts`) auto-registró para
 * `vendor_bill` creados por el backfill QB→POS de compras
 * (`lib/qb-backfill/create-bill.ts`, marcador `notes LIKE '[qb_backfill run=%'`).
 *
 * China Finance es un control interno del saldo con VEETECH: esos bills ya
 * estaban PAGADOS y CONCILIADOS en QuickBooks — nunca debieron entrar como
 * pendientes. Medido en prod 2026-09-12: 34 filas, $73.280,53, ninguna con
 * `split_group_id` ni aplicación a wire.
 *
 * DELETE FÍSICO (la tabla no tiene `deleted_at`), y SÓLO si la fila:
 *   - no tiene ninguna `china_wire_transfer_application` (no se aplicó a un
 *     wire — ni draft ni confirmado);
 *   - no tiene `split_group_id` (no es parte de un split) NI es el root de
 *     un split de otra fila (nadie la referencia como `split_group_id`).
 * Lo que no cumpla se reporta como RECHAZADO, nunca se toca.
 *
 * El código que las volvía a crear (`syncVeetchBills`) ya está arreglado en
 * este mismo branch (`lib/china-finance/backfill-exclusion.ts`) — este script
 * es la limpieza de lo que el bug viejo ya escribió; sin el fix de código, un
 * refresh de la página las recrearía.
 *
 * Correr (dry-run por default, sandbox):
 *   env DATABASE_URL="postgresql://postgres:sandbox@localhost:5499/medusa_bankgl" \
 *     ECOPOWERTECH_ENV=sandbox DISABLE_SCHEDULED_JOBS=true \
 *     ./node_modules/.bin/medusa exec ./src/scripts/fix/china-finance-drop-backfilled-bills.ts
 *
 * Aplicar (sandbox):
 *   env DATABASE_URL="postgresql://postgres:sandbox@localhost:5499/medusa_bankgl" \
 *     ECOPOWERTECH_ENV=sandbox DISABLE_SCHEDULED_JOBS=true APPLY=true \
 *     ./node_modules/.bin/medusa exec ./src/scripts/fix/china-finance-drop-backfilled-bills.ts
 *
 * Otro run: RUN_ID=<id> (default china-finance-drop-20260912).
 * Reporte del dry-run: `.qb-docs-cache/<TAG>_<RUN_ID>-dryrun.json`.
 *
 * PRODUCCIÓN (el OPERADOR, desde su terminal, después del dry-run):
 *
 *   cd backend && DATABASE_URL="$(grep ^DATABASE_URL= .env|cut -d= -f2-)" && \
 *   nohup env DATABASE_URL="$DATABASE_URL" ECOPOWERTECH_ENV=production \
 *     DISABLE_SCHEDULED_JOBS=true APPLY=true TARGET_PRODUCTION=1 \
 *     RUN_ID=qbbf-prod-20260912 CONFIRM_PRODUCTION_RUN=qbbf-prod-20260912 \
 *     ./node_modules/.bin/medusa exec ./src/scripts/fix/china-finance-drop-backfilled-bills.ts \
 *     > /home/alejo/webapps/handoff-bankgl-20260911/prod-logs/china-finance-drop-apply.log 2>&1 &
 *
 *   (nunca la URL literal en el comando visible; tarda más de 2 min → nohup … &)
 */
import { existsSync, mkdirSync, writeFileSync } from "fs";

import type { ExecArgs, Logger } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { getDbPool } from "../../api/utils/db-pool";
import { vendorBillIsBackfilledSql } from "../../lib/china-finance/backfill-exclusion";
import { assertDryRunEvidence, readJsonFile, resolveWriteTarget } from "../../lib/qb-backfill/target-guard";

const APPLY = process.env.APPLY === "true";
const RUN_ID = process.env.RUN_ID ?? "china-finance-drop-20260912";
const TAG = "china-finance-drop-backfilled-bills";
const DRY_RUN_REPORT = `.qb-docs-cache/${TAG}_${RUN_ID}-dryrun.json`;

type Row = {
  id: string;
  vendor_bill_id: string;
  vendor_bill_number: string | null;
  amount_cents: number;
  split_group_id: string | null;
  applications: number;
  is_split_root: boolean;
};

const CANDIDATES_SQL = `
  SELECT
    cfb.id,
    cfb.vendor_bill_id,
    vb.number AS vendor_bill_number,
    cfb.amount_cents,
    cfb.split_group_id,
    (SELECT COUNT(*)::int FROM china_wire_transfer_application a WHERE a.bill_id = cfb.id) AS applications,
    EXISTS (SELECT 1 FROM china_finance_bill child WHERE child.split_group_id = cfb.id AND child.id <> cfb.id) AS is_split_root
  FROM china_finance_bill cfb
  JOIN vendor_bill vb ON vb.id = cfb.vendor_bill_id
  WHERE cfb.type = 'vendor_bill'
    AND cfb.vendor_bill_id IS NOT NULL
    AND ${vendorBillIsBackfilledSql("vb")}
  ORDER BY cfb.sort_order ASC
`;

function cents(n: number): string {
  return `$${(n / 100).toFixed(2)}`;
}

export default async function dropBackfilledChinaFinanceBills({ container }: ExecArgs) {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);

  if (APPLY) {
    const target = resolveWriteTarget({
      argv: process.argv,
      env: process.env,
      databaseUrl: process.env.DATABASE_URL,
      runId: RUN_ID,
    });
    logger.info(`[${TAG}] destino: ${target.target} (${target.reason})`);
    const dry = existsSync(DRY_RUN_REPORT) ? readJsonFile<Record<string, number>>(DRY_RUN_REPORT) : null;
    assertDryRunEvidence(
      target.target,
      RUN_ID,
      dry
        ? {
            path: DRY_RUN_REPORT,
            cardinality: { candidates: dry.candidates, would_delete: dry.would_delete, rejected: dry.rejected },
          }
        : null,
      (l) => logger.info(l)
    );
  }

  const pool = getDbPool();
  const before = (await pool.query<Row>(CANDIDATES_SQL)).rows;

  const deletable = before.filter((r) => r.applications === 0 && !r.split_group_id && !r.is_split_root);
  const rejected = before.filter((r) => !(r.applications === 0 && !r.split_group_id && !r.is_split_root));

  const totalBefore = before.reduce((s, r) => s + Number(r.amount_cents), 0);
  const totalDeletable = deletable.reduce((s, r) => s + Number(r.amount_cents), 0);

  logger.info(
    `${"═".repeat(72)}\n[${TAG}] ${APPLY ? "APPLY" : "DRY-RUN (nada se escribe)"} · run ${RUN_ID}\n` +
      `  candidatos (backfill, tipo vendor_bill): ${before.length} · ${cents(totalBefore)}\n` +
      `  a borrar (sin wire, sin split): ${deletable.length} · ${cents(totalDeletable)}\n` +
      `  rechazados (tienen wire y/o split): ${rejected.length}\n${"═".repeat(72)}`
  );

  if (rejected.length > 0) {
    for (const r of rejected) {
      logger.info(
        `  RECHAZADO ${r.id} (vendor_bill ${r.vendor_bill_number ?? r.vendor_bill_id}, ${cents(r.amount_cents)}): ` +
          `applications=${r.applications} split_group_id=${r.split_group_id ?? "—"} is_split_root=${r.is_split_root}`
      );
    }
  }

  let deletedCount = 0;
  if (APPLY && deletable.length > 0) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const ids = deletable.map((r) => r.id);
      const del = await client.query(`DELETE FROM china_finance_bill WHERE id = ANY($1) RETURNING id`, [ids]);
      deletedCount = del.rowCount ?? 0;
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  const after = (await pool.query<Row>(CANDIDATES_SQL)).rows;
  const totalAfter = after.reduce((s, r) => s + Number(r.amount_cents), 0);

  // Balance summary (mismo query que /admin/china-finance/bills) antes/después.
  const balanceSql = `
    SELECT
      COALESCE(SUM(cfb.amount_cents), 0)::bigint AS total_expenses_cents,
      COALESCE((SELECT SUM(cwta.applied_cents) FROM china_wire_transfer_application cwta), 0)::bigint AS total_covered_cents,
      COALESCE((SELECT SUM(cwt.received_amount_cents) FROM china_wire_transfer cwt WHERE cwt.status = 'confirmed'), 0)::bigint AS total_received_cents
    FROM china_finance_bill cfb
  `;
  const balanceRows = (await pool.query<{ total_expenses_cents: string; total_received_cents: string }>(balanceSql)).rows;
  const balance = balanceRows[0] ?? { total_expenses_cents: "0", total_received_cents: "0" };
  const balanceCents = Number(balance.total_received_cents) - Number(balance.total_expenses_cents);

  if (!APPLY) {
    mkdirSync(".qb-docs-cache", { recursive: true });
    writeFileSync(
      DRY_RUN_REPORT,
      JSON.stringify(
        {
          run_id: RUN_ID,
          apply: false,
          candidates: before.length,
          would_delete: deletable.length,
          rejected: rejected.length,
          total_candidates_cents: totalBefore,
          total_would_delete_cents: totalDeletable,
        },
        null,
        2
      )
    );
  }

  logger.info(
    `${"─".repeat(72)}\n${APPLY ? "APLICADO" : "DRY-RUN"} · ${APPLY ? deletedCount : deletable.length} fila(s) ${APPLY ? "borradas" : "a borrar"} · ${rejected.length} rechazada(s)\n` +
      `  china_finance_bill del backfill restantes: ${after.length} · ${cents(totalAfter)}\n` +
      `  balance actual del libro (received − expenses): ${cents(balanceCents)}\n` +
      (APPLY ? "" : `  reporte: ${DRY_RUN_REPORT}\n  Para aplicar: APPLY=true\n`) +
      `${"─".repeat(72)}`
  );

  await pool.end();
}
