/**
 * Drive the REAL qb-vendor-sync-runner through a full `mode='payment_terms'`
 * run, tick by tick, without waiting on cron. Intended for the SANDBOX
 * (`postgres://postgres:sandbox@localhost:5499/medusa`): the QuickBooks side is
 * read-only (VendorQuery + TermsQuery), every write lands in whatever
 * DATABASE_URL you pass.
 *
 * The runner's own `DISABLE_SCHEDULED_JOBS` guard is env-driven, so leaving that
 * var unset here exercises the shipped code path unmodified.
 *
 * Usage (sandbox — QB creds come from the real .env because the query is a read):
 *   cd backend
 *   env DATABASE_URL='postgres://postgres:sandbox@localhost:5499/medusa' \
 *       REDIS_URL='redis://localhost:6399' \
 *       QB_BRIDGE_URL=$(grep ^QB_BRIDGE_URL= .env|cut -d= -f2-) \
 *       QB_API_KEY=$(grep ^QB_API_KEY= .env|cut -d= -f2-) \
 *     npx medusa exec ./src/scripts/tests/test-vendor-terms-sync.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import qbVendorSyncRunner from "../../jobs/qb-vendor-sync-runner";
import { QUICKBOOKS_CATALOG_MODULE } from "../../modules/quickbooks-catalog";

const MAX_TICKS = 40;
const TICK_DELAY_MS = 3_000;

export default async function testVendorTermsSync({
  container,
}: ExecArgs): Promise<void> {
  const catalog = container.resolve(QUICKBOOKS_CATALOG_MODULE) as any;
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const run = await catalog.createQbVendorSyncRuns({
    status: "queued",
    mode: "payment_terms",
    triggered_by_user_id: null,
  });
  console.log(`Created run ${run.id} (mode=payment_terms)\n`);

  for (let tick = 1; tick <= MAX_TICKS; tick++) {
    await qbVendorSyncRunner(container);

    const { data } = await query.graph({
      entity: "qb_vendor_sync_run",
      fields: [
        "id",
        "status",
        "mode",
        "total_count",
        "processed_count",
        "created_count",
        "updated_count",
        "terms_written_count",
        "terms_skipped_count",
        "error_count",
        "last_error",
      ],
      filters: { id: run.id } as any,
      pagination: { skip: 0, take: 1 },
    });
    const r = (data as Record<string, any>[])[0];

    console.log(
      `tick ${String(tick).padStart(2)} · ${r.status.padEnd(10)} ` +
        `processed=${r.processed_count}/${r.total_count} ` +
        `updated=${r.updated_count} terms=${r.terms_written_count} ` +
        `skipped=${r.terms_skipped_count} err=${r.error_count}`
    );

    if (r.status === "completed") {
      console.log("\nRun completed.");
      break;
    }
    if (r.status === "failed") {
      console.log(`\nRun FAILED: ${r.last_error}`);
      return;
    }
    await new Promise((res) => setTimeout(res, TICK_DELAY_MS));
  }

  const pg = container.resolve("__pg_connection__") as unknown as {
    raw: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;
  };

  const { rows: summary } = await pg.raw(`
    SELECT terms_ref_name,
           metadata->>'default_payment_terms_days' AS days,
           count(*) AS vendors
      FROM qb_vendor
     WHERE deleted_at IS NULL
       AND terms_ref_name IS NOT NULL
     GROUP BY 1, 2
     ORDER BY count(*) DESC
     LIMIT 20`);

  console.log("\nterm → stored days (top 20):");
  for (const row of summary) {
    console.log(
      `  ${String(row.vendors).padStart(4)}  ${String(row.terms_ref_name).padEnd(34)} → ${row.days ?? "null"}`
    );
  }

  const { rows: gaps } = await pg.raw(`
    SELECT count(*) AS n
      FROM qb_vendor
     WHERE deleted_at IS NULL
       AND terms_ref_name IS NOT NULL
       AND metadata->>'default_payment_terms_days' IS NULL
       AND metadata->>'default_payment_terms_day_of_month' IS NULL`);
  console.log(
    `\nVendors with a QB term but no resolved days or day-of-month: ${gaps[0]?.n}`
  );
}
