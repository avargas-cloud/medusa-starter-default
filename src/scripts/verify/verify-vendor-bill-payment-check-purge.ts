/**
 * verify-vendor-bill-payment-check-purge
 *
 * Proves qb-vendor-bill-payment-check-purge.ts deletes ONLY terminal
 * (failed/skipped) vendor_bill_payment_check rows past retention, and never
 * touches live work (pending/processing/submitted/waiting) or other steps —
 * the two ways a purge job can go wrong: too narrow (leak persists) or too
 * wide (deletes something still in flight or out of scope).
 *
 * Calls the REAL exported job function against the sandbox DB (not a mirrored
 * copy), with a minimal fake container — isScheduledJobsDisabled() only
 * touches the container when DISABLE_SCHEDULED_JOBS=true, which this script
 * never sets.
 *
 * Fixtures are COMMITTED, not transaction-wrapped: the job runs its DELETE
 * through its own pool connection (getDbPool()), which cannot see rows from
 * an uncommitted transaction on a separate client. Cleanup is explicit
 * try/finally instead of ROLLBACK.
 *
 * Run:
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-vendor-bill-payment-check-purge.ts
 */
import { readFileSync } from "fs";
import { join } from "path";

import { Client } from "pg";

const FIXTURE_PREFIX = "purgeverify_";

let failures = 0;
const check = (ok: boolean, label: string, detail = ""): void => {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

function isSandboxTarget(connectionString: string): boolean {
  return (
    /:5499\b/.test(connectionString) ||
    /@(localhost|127\.0\.0\.1):5499/.test(connectionString)
  );
}

function checkSourceGuards(): void {
  console.log("\n── 1. Purge job source stays scoped ──");
  const jobSrc = readFileSync(
    join(__dirname, "../../jobs/qb-vendor-bill-payment-check-purge.ts"),
    "utf8"
  );
  check(
    /step\s*=\s*'vendor_bill_payment_check'/.test(jobSrc),
    "DELETE is scoped to the vendor_bill_payment_check step"
  );
  check(
    /status\s+IN\s*\(\s*'failed'\s*,\s*'skipped'\s*\)/.test(jobSrc),
    "DELETE only targets failed/skipped — never pending/processing/submitted/waiting"
  );
  check(
    /retentionHours\s*<\s*1\s*\|\|\s*retentionHours\s*>\s*720/.test(jobSrc) &&
      /return;/.test(jobSrc.split("pool.query")[0]),
    "an invalid retention returns before the DELETE runs — no silent default"
  );

  console.log("\n── 2. Stale-cleanup give-up threshold stays step-scoped ──");
  const cleanupSrc = readFileSync(
    join(
      __dirname,
      "../../lib/quickbooks/consolidator/stale-cleanup-pass.ts"
    ),
    "utf8"
  );
  check(
    /VENDOR_BILL_PAYMENT_CHECK_GIVEUP_MS\s*=\s*6\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(
      cleanupSrc
    ),
    "the extended give-up threshold is 6h, not a blanket change to TWO_HOURS_MS"
  );
  check(
    /submittedMs\s*<\s*giveupThresholdMs\(row\.step as string\)/.test(
      cleanupSrc
    ),
    "the extend-window comparison uses the per-step threshold, not the raw 2h constant"
  );
}

async function seedFixtures(client: Client): Promise<void> {
  const mk = async (
    suffix: string,
    step: string,
    status: string,
    ageHours: number
  ): Promise<void> => {
    await client.query(
      `INSERT INTO qb_order_pipeline
         (id, reference_id, reference_type, step, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'vendor_bill', $2, $3,
               NOW() - ($4 || ' hours')::interval, NOW())`,
      [`${FIXTURE_PREFIX}${suffix}`, step, status, String(ageHours)]
    );
  };

  await mk("old_failed", "vendor_bill_payment_check", "failed", 30);
  await mk("old_skipped", "vendor_bill_payment_check", "skipped", 48);
  await mk("young_failed", "vendor_bill_payment_check", "failed", 1);
  await mk("old_submitted", "vendor_bill_payment_check", "submitted", 40);
  await mk("old_waiting", "vendor_bill_payment_check", "waiting", 40);
  await mk("old_confirmed", "vendor_bill_payment_check", "confirmed", 40);
  await mk("other_step_old_failed", "apply_payment", "failed", 40);
}

async function fixtureStatus(
  client: Client
): Promise<Map<string, boolean>> {
  const { rows } = await client.query(
    `SELECT reference_id FROM qb_order_pipeline WHERE reference_id LIKE $1`,
    [`${FIXTURE_PREFIX}%`]
  );
  const present = new Set(rows.map((r: { reference_id: string }) => r.reference_id));
  return new Map(
    [
      "old_failed",
      "old_skipped",
      "young_failed",
      "old_submitted",
      "old_waiting",
      "old_confirmed",
      "other_step_old_failed",
    ].map((suffix) => [suffix, present.has(`${FIXTURE_PREFIX}${suffix}`)])
  );
}

async function cleanupFixtures(client: Client): Promise<void> {
  const { rowCount } = await client.query(
    `DELETE FROM qb_order_pipeline WHERE reference_id LIKE $1`,
    [`${FIXTURE_PREFIX}%`]
  );
  if (rowCount) {
    console.log(`  [cleanup] removed ${rowCount} fixture row(s)`);
  }
}

async function runJobDirectly(): Promise<void> {
  // Imported lazily so DATABASE_URL is already set on process.env before
  // getDbPool() lazily initializes its singleton pool.
  const { default: purgeJob } = await import(
    "../../jobs/qb-vendor-bill-payment-check-purge"
  );
  const fakeContainer = {
    resolve: () => ({
      info: (msg: string) => console.log(`  [job] ${msg}`),
      warn: (msg: string) => console.log(`  [job] ${msg}`),
      debug: () => {},
    }),
  };
  await purgeJob(fakeContainer as any);
}

async function checkBehavior(client: Client): Promise<void> {
  console.log("\n── 3. Real job run against a seeded sandbox ──");

  await cleanupFixtures(client); // in case a prior failed run left rows behind
  await seedFixtures(client);

  try {
    delete process.env.VENDOR_BILL_PAYMENT_CHECK_PURGE_RETENTION_HOURS; // exercise the 24h default
    await runJobDirectly();

    const after = await fixtureStatus(client);
    check(
      after.get("old_failed") === false,
      "a failed row past 24h retention IS purged"
    );
    check(
      after.get("old_skipped") === false,
      "a skipped row past 24h retention IS purged"
    );
    check(
      after.get("young_failed") === true,
      "a failed row inside the 24h window is NOT purged yet"
    );
    check(
      after.get("old_submitted") === true,
      "an old SUBMITTED row is never purged — live work is untouchable"
    );
    check(
      after.get("old_waiting") === true,
      "an old WAITING row is never purged — live work is untouchable"
    );
    check(
      after.get("old_confirmed") === true,
      "a confirmed row is left alone — scope is failed/skipped only"
    );
    check(
      after.get("other_step_old_failed") === true,
      "a failed row from a DIFFERENT step is not touched — no scope leak"
    );

    // Re-seed just the two purge-eligible cases to prove an invalid retention
    // aborts before deleting anything (no silent fallback to a default).
    await client.query(`DELETE FROM qb_order_pipeline WHERE reference_id = $1`, [
      `${FIXTURE_PREFIX}old_failed`,
    ]);
    await client.query(
      `INSERT INTO qb_order_pipeline
         (id, reference_id, reference_type, step, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'vendor_bill', 'vendor_bill_payment_check', 'failed',
               NOW() - INTERVAL '400 hours', NOW())`,
      [`${FIXTURE_PREFIX}old_failed`]
    );
    process.env.VENDOR_BILL_PAYMENT_CHECK_PURGE_RETENTION_HOURS = "0";
    await runJobDirectly();
    const afterInvalid = await fixtureStatus(client);
    check(
      afterInvalid.get("old_failed") === true,
      "retention=0 aborts without deleting anything (mutation test)"
    );
  } finally {
    delete process.env.VENDOR_BILL_PAYMENT_CHECK_PURGE_RETENTION_HOURS;
    await cleanupFixtures(client);
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  checkSourceGuards();

  if (!isSandboxTarget(connectionString)) {
    console.log("\n── 3. Real job run against a seeded sandbox ──");
    console.log(
      "⏭  SKIPPED — DATABASE_URL is not the sandbox (expected port 5499). " +
        "Checks 1-2 are read-only and ran. Re-run against the sandbox for check 3."
    );
    if (failures > 0) {
      console.error(`\n❌ FAIL — ${failures} check(s) failed.`);
      process.exitCode = 1;
      return;
    }
    console.log("\n✅ PASS (partial) — source guards verified.");
    return;
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await checkBehavior(client);
  } finally {
    await client.end();
  }

  console.log("");
  if (failures > 0) {
    console.error(`❌ FAIL — ${failures} check(s) failed.`);
    process.exitCode = 1;
    return;
  }
  console.log("✅ PASS — purge is scoped, retention-respecting, and mutation-tested.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
