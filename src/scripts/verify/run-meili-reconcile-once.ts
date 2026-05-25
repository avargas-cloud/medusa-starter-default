/**
 * Run the MeiliSearch reconciliation cron once, ad-hoc, for verification.
 *
 *   yarn medusa exec ./src/scripts/verify/run-meili-reconcile-once.ts
 *
 * Useful for: smoke-testing the framework, manually clearing drift after a
 * big SQL backfill, debugging via DRY_RUN=true.
 */
import type { ExecArgs } from "@medusajs/framework/types";
import postgres from "postgres";
import { reconcileEntity } from "../../lib/meilisearch/drift-reconciler";
import { customerReconciler } from "../../lib/meilisearch/reconcilers/customer-reconciler";

export default async function runMeiliReconcileOnce({ container }: ExecArgs): Promise<void> {
  const logger = container.resolve("logger") as {
    info: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
  };

  const dryRun = process.env.DRY_RUN === "true";
  const windowMinutes = parseInt(process.env.WINDOW_MINUTES ?? "60", 10);
  const sinceIso = new Date(Date.now() - windowMinutes * 60_000).toISOString();

  console.log(`[reconcile-once] mode=${dryRun ? "DRY-RUN" : "APPLY"} window=${windowMinutes}min sinceIso=${sinceIso}`);
  const sql = postgres(process.env.DATABASE_URL!, { max: 2 });

  try {
    const stats = await reconcileEntity(customerReconciler, sql, container, {
      sinceIso,
      maxRows: 1000,
      dryRun,
      logger,
    });
    console.log(`[reconcile-once] customer: ${JSON.stringify(stats)}`);

    // Show the most recent drift_log rows so you can eyeball them
    const recent = await sql`
      SELECT entity_id, field_name, db_value, meili_value, fixed_at IS NOT NULL AS fixed
      FROM meilisearch_drift_log
      ORDER BY detected_at DESC
      LIMIT 10
    `;
    if (recent.length > 0) {
      console.log(`[reconcile-once] last ${recent.length} drift_log rows:`);
      for (const r of recent) {
        console.log(`  ${r.entity_id} ${r.field_name}: db=${r.db_value} meili=${r.meili_value} fixed=${r.fixed}`);
      }
    } else {
      console.log(`[reconcile-once] no drift_log rows yet`);
    }
  } finally {
    await sql.end();
  }
}
