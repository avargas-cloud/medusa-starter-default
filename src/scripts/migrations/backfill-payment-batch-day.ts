/**
 * backfill-payment-batch-day.ts — fill customer_payment.batch_day for
 * historical rows.
 *
 * DECISION (user, 2026-07-09): historical rows get the plain ET date of
 * received_at WITHOUT the 18:45 cutoff rule — evening payments keep their
 * ET day and can be edited per-payment afterwards (e.g. 3062/3063 → Jul 9).
 * New rows (post-deploy) DO apply the cutoff via the finance service, so
 * there is a discontinuity at the deploy boundary — the dry run reports
 * exactly how many rows would differ under the cutoff so it's explicit.
 *
 * Usage:
 *   yarn ts-node-script src/scripts/migrations/backfill-payment-batch-day.ts            # dry run
 *   yarn ts-node-script src/scripts/migrations/backfill-payment-batch-day.ts --apply    # write
 *   (against Railway prod: add --i-know-this-is-prod)
 *
 * Idempotent: only touches rows WHERE batch_day IS NULL.
 */
import { Client } from "pg";

const APPLY = process.argv.includes("--apply");
const PROD_OK = process.argv.includes("--i-know-this-is-prod");

const ET_DATE = `to_char(cp.received_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD')`;
// What the cutoff rule WOULD produce (18:45 ET) — reporting only.
const CUTOFF_DATE = `to_char((cp.received_at + interval '5 hours 15 minutes') AT TIME ZONE 'America/New_York', 'YYYY-MM-DD')`;
// NOTE: the +5h15m trick is NOT the real rule (it approximates "after 18:45
// rolls over" by shifting the clock so 18:45:00.000001 crosses midnight).
// It is used ONLY for the dry-run discontinuity report; the actual write is
// the plain ET date per the user's decision.

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");

  const isProd = /railway|rlwy\.net/i.test(dbUrl);
  if (APPLY && isProd && !PROD_OK) {
    console.error(
      "Refusing to --apply against a Railway/prod DATABASE_URL without --i-know-this-is-prod"
    );
    process.exit(1);
  }

  const client = new Client({
    connectionString: dbUrl,
    ssl: /railway|sslmode/i.test(dbUrl)
      ? { rejectUnauthorized: false }
      : undefined,
  });
  await client.connect();

  try {
    const { rows: stats } = await client.query(`
      SELECT
        COUNT(*)::int                                   AS total_null,
        COUNT(*) FILTER (WHERE ${ET_DATE} <> ${CUTOFF_DATE})::int AS would_differ_under_cutoff,
        MIN(cp.received_at)                             AS min_received,
        MAX(cp.received_at)                             AS max_received
      FROM customer_payment cp
      WHERE cp.deleted_at IS NULL AND cp.batch_day IS NULL
    `);
    const s = stats[0];
    console.log(`Rows with batch_day IS NULL: ${s.total_null}`);
    console.log(
      `Rows after ~18:45 ET (would differ if the cutoff rule were applied): ${s.would_differ_under_cutoff}`
    );
    console.log(`received_at range: ${s.min_received} → ${s.max_received}`);
    console.log(
      `Write semantics: plain ET date (NO cutoff) — per user decision; edit outliers per-payment.`
    );

    if (!APPLY) {
      const { rows: sample } = await client.query(`
        SELECT cp.display_id, cp.received_at, ${ET_DATE} AS batch_day_to_write
        FROM customer_payment cp
        WHERE cp.deleted_at IS NULL AND cp.batch_day IS NULL
        ORDER BY cp.received_at DESC
        LIMIT 10
      `);
      console.log("\nSample (latest 10):");
      for (const r of sample) {
        console.log(
          `  #${r.display_id} received=${r.received_at?.toISOString?.() ?? r.received_at} → batch_day=${r.batch_day_to_write}`
        );
      }
      console.log("\nDRY RUN — re-run with --apply to write.");
      return;
    }

    const { rowCount } = await client.query(`
      UPDATE customer_payment cp
         SET batch_day = ${ET_DATE},
             updated_at = NOW()
       WHERE cp.deleted_at IS NULL AND cp.batch_day IS NULL
    `);
    console.log(`✅ Backfilled ${rowCount} rows.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
