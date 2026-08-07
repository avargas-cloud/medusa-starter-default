/**
 * Repara los estimates históricos mal posteados en QuickBooks (auditoría
 * 2026-08-06 del plan qb-customer-propagation): el documento QB quedó bajo un
 * cliente genérico mientras el cliente vivo de Medusa es el real.
 *
 * NO escribe a QuickBooks directo: encola el EstimateMod por el pipeline
 * deployado (handleDraftOrderUpdated), que re-asserta CustomerRef con el
 * cliente VIVO — el mismo camino validado en producción con la orden 2542.
 *
 * Dry-run por default (imprime el plan, no toca nada).
 * Aplicar: APPLY=true — la corrida la ejecuta el operador.
 *
 *   env DATABASE_URL=... npx medusa exec ./src/scripts/fix/resync-historical-estimate-customers.ts
 */

import { getDbPool } from "../../api/utils/db-pool";
import { handleDraftOrderUpdated } from "../../lib/quickbooks/handlers/handle-draft-order-updated";

// Overridable: TARGETS=1845,1802 acota la corrida (re-runs parciales tras un corte).
const TARGET_DISPLAY_IDS = (process.env.TARGETS ?? "2435,1845,1802,1751")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);

interface PlanRow {
  display_id: number;
  id: string;
  txn_id: string | null;
  qb_ref: string | null;
  cached: string | null;
  live: string | null;
  customer_name: string;
  active_invoices: number;
}

export default async function resyncHistoricalEstimateCustomers({
  container,
}: {
  container: { resolve: (key: string) => unknown };
}) {
  const logger = container.resolve("logger") as {
    info: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
  };
  const apply = process.env.APPLY === "true";
  const pool = getDbPool();

  // ── buildPlan: lee, nunca escribe (el apply usa EXACTAMENTE estas filas) ──
  const { rows } = await pool.query(
    `SELECT o.display_id, o.id,
            o.metadata->'qb_estimate'->>'txn_id'     AS txn_id,
            o.metadata->'qb_estimate'->>'ref_number' AS qb_ref,
            o.metadata->>'qb_list_id'                AS cached,
            c.metadata->>'qb_list_id'                AS live,
            COALESCE(c.company_name, c.first_name||' '||c.last_name) AS customer_name,
            (SELECT COUNT(*)::int FROM pos_invoice i
              WHERE i.order_id = o.id AND i.status <> 'voided'
                AND i.voided_at IS NULL)             AS active_invoices
       FROM "order" o
       JOIN customer c ON c.id = o.customer_id
      WHERE o.display_id = ANY($1)
      ORDER BY o.display_id DESC`,
    [TARGET_DISPLAY_IDS]
  );
  const plan = rows as PlanRow[];

  const runnable: PlanRow[] = [];
  logger.info(`── Plan (${plan.length} de ${TARGET_DISPLAY_IDS.length} órdenes) ──`);
  for (const r of plan) {
    const problems: string[] = [];
    if (!r.txn_id) problems.push("sin qb_estimate.txn_id");
    if (!r.live) problems.push("cliente vivo sin qb_list_id");
    const status = problems.length ? `SKIP (${problems.join(", ")})` : "OK";
    logger.info(
      `  #${r.display_id} ${r.qb_ref ?? "?"} txn=${r.txn_id ?? "-"} → cliente vivo "${r.customer_name}" (${r.live ?? "-"}) | cache=${r.cached ?? "-"} | invoices activas=${r.active_invoices} | ${status}`
    );
    if (!problems.length) runnable.push(r);
  }

  if (plan.length !== TARGET_DISPLAY_IDS.length) {
    logger.warn(
      `⚠️ Se esperaban ${TARGET_DISPLAY_IDS.length} órdenes y la query devolvió ${plan.length} — revisar antes de aplicar.`
    );
  }

  if (!apply) {
    logger.info(
      `DRY-RUN — nada encolado. Para aplicar: APPLY=true (${runnable.length} MODs saldrían).`
    );
    return { dryRun: true, planned: runnable.length };
  }

  // ── apply: el mismo plan que se imprimió, por el pipeline deployado ───────
  const results: Record<string, string> = {};
  for (const r of runnable) {
    logger.info(`→ #${r.display_id}: encolando EstimateMod (re-assert de ${r.live})`);
    try {
      const outcome = await handleDraftOrderUpdated(r.id, container, logger, {
        awaitSerialized: true,
      });
      results[String(r.display_id)] = outcome;
      logger.info(`  #${r.display_id}: ${outcome}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results[String(r.display_id)] = `error: ${msg}`;
      logger.error(`  #${r.display_id}: ❌ ${msg}`);
    }
  }
  logger.info(`APPLY terminado: ${JSON.stringify(results)}`);
  return { dryRun: false, results };
}
