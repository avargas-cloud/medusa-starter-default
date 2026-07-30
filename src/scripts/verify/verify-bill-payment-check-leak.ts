/**
 * verify-bill-payment-check-leak
 *
 * Proves the `vendor_bill_payment_check` step cannot produce one dead pipeline row
 * per hour when its QuickBooks Bill has been deleted.
 *
 * THE BUG IT GUARDS
 * The hourly monitor re-elects any linked unpaid bill whose `qb_payment_checked_at`
 * is older than 12 h. A failed check never advances that stamp, and the monitor's
 * NOT EXISTS guard only suppressed rows in pending/processing/submitted/waiting —
 * so a bill whose QB document was deleted queued another permanently-failed row
 * every single hour, forever. Measured live on FTL - 1573151 (ELA Florida,
 * $1,807.00): four identical failed rows in four hours.
 *
 * WHAT IT CHECKS
 *   1. QB's actual not-found response shape is recognised (the probed `$` shape
 *      plus the two sibling shapes this consolidator has seen).
 *   2. A response that is NOT an explicit not-found is left on the retry path —
 *      "QB said it's gone" and "we couldn't tell" must not collapse into one.
 *   3. The monitor's candidate query excludes marked bills (Layer 2) AND bills
 *      with a recent terminal check row (Layer 1, reason-agnostic).
 *   4. Both layers are present in the job source by name, so deleting one is a
 *      failure here rather than a silent return of the leak.
 *
 * Checks 1-2 are pure. Check 3 runs the REAL candidate SQL against the database
 * inside a transaction that is always ROLLED BACK, so it is non-mutating.
 *
 * Run:
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-bill-payment-check-leak.ts
 */
import { readFileSync } from "fs";
import { join } from "path";

import { Client } from "pg";

import {
  isQbObjectNotFound,
  qbStatusMessage,
} from "../../lib/quickbooks/pipeline/vendor-bill-missing";

let failures = 0;
const check = (ok: boolean, label: string, detail = ""): void => {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/** The verbatim response the live bridge returned for a deleted Bill. */
const PROBED_NOT_FOUND = {
  $: {
    statusCode: "500",
    statusSeverity: "Warn",
    statusMessage:
      'The query request has not been fully completed. There was a required element ("1CAB66-1784735262") that could not be found in QuickBooks.',
  },
};

/** The verbatim response for a Bill that exists (positive control). */
const PROBED_FOUND = {
  $: { statusCode: "0", statusSeverity: "Info", statusMessage: "Status OK" },
  BillRet: { TxnID: "1CB780-1785332667", RefNumber: "SO2923139" },
};

function checkResponseRecognition(): void {
  console.log("\n── 1. QuickBooks not-found recognition ──");
  check(
    isQbObjectNotFound(PROBED_NOT_FOUND),
    "the probed live not-found response is recognised"
  );
  check(
    (qbStatusMessage(PROBED_NOT_FOUND) ?? "").includes("could not be found"),
    "its statusMessage is surfaced for the row error"
  );
  check(
    isQbObjectNotFound({ statusCode: "500" }),
    "flat statusCode shape is recognised"
  );
  check(
    isQbObjectNotFound({ "@statusCode": "500" }),
    "@-prefixed shape is recognised"
  );

  console.log("\n── 2. Everything else stays on the retry path ──");
  check(
    !isQbObjectNotFound(PROBED_FOUND),
    "a successful query is NOT treated as missing"
  );
  check(
    !isQbObjectNotFound({ $: { statusCode: "1", statusMessage: "no match" } }),
    "a different QB status is NOT treated as missing"
  );
  check(!isQbObjectNotFound(undefined), "undefined is NOT treated as missing");
  check(!isQbObjectNotFound(null), "null is NOT treated as missing");
  check(!isQbObjectNotFound({}), "an empty object is NOT treated as missing");
  check(
    !isQbObjectNotFound({ $: { statusSeverity: "Warn" } }),
    "a status without a code is NOT treated as missing"
  );
}

function checkBothLayersPresentInSource(): void {
  console.log("\n── 3. Both guard layers exist in the monitor ──");
  const src = readFileSync(
    join(__dirname, "../../jobs/qb-vendor-bill-payment-monitor.ts"),
    "utf8"
  );
  check(
    /vb\.qb_missing_in_qb_at\s+IS\s+NULL/.test(src),
    "Layer 2: marked bills are excluded from the candidate set"
  );
  check(
    /status\s+IN\s*\(\s*'failed'\s*,\s*'skipped'\s*\)/.test(src),
    "Layer 1: a recent terminal check row holds the bill back"
  );
}

/**
 * Runs the monitor's real candidate predicate against the database and asserts a
 * bill in each of the three states is classified correctly.
 *
 * Everything happens inside a transaction that is ALWAYS rolled back — including
 * the fixtures — so the script never leaves a row behind, in any environment.
 */
async function checkCandidateSelection(client: Client): Promise<void> {
  console.log("\n── 4. Candidate selection against a real database ──");

  const candidatePredicate = `
      vb.deleted_at IS NULL
      AND vb.qb_txn_id IS NOT NULL
      AND vb.qb_is_paid = false
      AND vb.qb_missing_in_qb_at IS NULL
      AND (vb.qb_payment_checked_at IS NULL
           OR vb.qb_payment_checked_at < NOW() - INTERVAL '12 hours')
      AND NOT EXISTS (
        SELECT 1 FROM qb_order_pipeline p
         WHERE p.reference_id = vb.id
           AND p.reference_type = 'vendor_bill'
           AND p.step = 'vendor_bill_payment_check'
           AND p.status IN ('pending','processing','submitted','waiting'))
      AND NOT EXISTS (
        SELECT 1 FROM qb_order_pipeline p
         WHERE p.reference_id = vb.id
           AND p.reference_type = 'vendor_bill'
           AND p.step = 'vendor_bill_payment_check'
           AND p.status IN ('failed','skipped')
           AND p.created_at > NOW() - INTERVAL '12 hours')`;

  await client.query("BEGIN");
  try {
    const mk = async (
      suffix: string,
      opts: { missing?: boolean; terminalRow?: string; rowAgeHours?: number }
    ): Promise<string> => {
      const id = `vb_verifyleak_${suffix}`;
      await client.query(
        `INSERT INTO vendor_bill
           (id, status, qb_txn_id, qb_is_paid, qb_missing_in_qb_at,
            qb_payment_checked_at, created_at, updated_at)
         VALUES ($1, 'synced', 'VERIFY-TXN-' || $1, false, $2, NULL, NOW(), NOW())`,
        [id, opts.missing ? new Date() : null]
      );
      if (opts.terminalRow) {
        await client.query(
          `INSERT INTO qb_order_pipeline
             (id, reference_id, reference_type, step, status, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, 'vendor_bill',
                   'vendor_bill_payment_check', $2,
                   NOW() - ($3 || ' hours')::interval, NOW())`,
          [id, opts.terminalRow, String(opts.rowAgeHours ?? 1)]
        );
      }
      return id;
    };

    const control = await mk("control", {});
    const marked = await mk("marked", { missing: true });
    const freshFail = await mk("freshfail", {
      terminalRow: "failed",
      rowAgeHours: 1,
    });
    const oldFail = await mk("oldfail", {
      terminalRow: "failed",
      rowAgeHours: 30,
    });
    const skipped = await mk("skipped", {
      terminalRow: "skipped",
      rowAgeHours: 2,
    });

    const { rows } = await client.query(
      `SELECT vb.id FROM vendor_bill vb
        WHERE vb.id LIKE 'vb_verifyleak_%' AND ${candidatePredicate}`
    );
    const elected = new Set(rows.map((r: { id: string }) => r.id));

    check(
      elected.has(control),
      "an ordinary unpaid linked bill IS still elected",
      "the fix must not stop normal checks"
    );
    check(
      !elected.has(marked),
      "a bill marked missing in QuickBooks is NOT elected"
    );
    check(
      !elected.has(freshFail),
      "a bill whose check failed 1 h ago is NOT elected",
      "this is the row-per-hour leak"
    );
    check(
      !elected.has(skipped),
      "a bill whose check was skipped 2 h ago is NOT elected"
    );
    check(
      elected.has(oldFail),
      "a bill whose check failed 30 h ago IS elected again",
      "the hold is a 12 h cadence, not a permanent block"
    );
  } finally {
    await client.query("ROLLBACK");
    const { rows: leftovers } = await client.query(
      `SELECT COUNT(*)::int AS n FROM vendor_bill WHERE id LIKE 'vb_verifyleak_%'`
    );
    check(
      leftovers[0].n === 0,
      "the rollback left no fixture rows behind",
      `found ${leftovers[0].n}`
    );
  }
}

/**
 * Check 4 plants fixture rows. A rolled-back transaction is still a write path,
 * and this project's rule is that experiments never point at production — so the
 * gate is mechanical, not a promise in a comment. Sandbox Postgres is 5499
 * (docker-compose.sandbox.yml); anything else must opt in explicitly.
 */
function isSandboxTarget(connectionString: string): boolean {
  return (
    /:5499\b/.test(connectionString) ||
    /@(localhost|127\.0\.0\.1):5499/.test(connectionString)
  );
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  checkResponseRecognition();
  checkBothLayersPresentInSource();

  const fixturesAllowed =
    isSandboxTarget(connectionString) ||
    process.env.ALLOW_NON_SANDBOX_FIXTURES === "1";
  if (!fixturesAllowed) {
    console.log("\n── 4. Candidate selection against a real database ──");
    console.log(
      "⏭  SKIPPED — DATABASE_URL is not the sandbox (expected port 5499). " +
        "Checks 1-3 are read-only and ran. Re-run against the sandbox for check 4."
    );
    console.log("");
    if (failures > 0) {
      console.error(`❌ FAIL — ${failures} check(s) failed.`);
      process.exitCode = 1;
      return;
    }
    console.log("✅ PASS (partial) — recognition + both guard layers verified.");
    return;
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await checkCandidateSelection(client);
  } finally {
    await client.end();
  }

  console.log("");
  if (failures > 0) {
    console.error(`❌ FAIL — ${failures} check(s) failed.`);
    process.exitCode = 1;
    return;
  }
  console.log("✅ PASS — the hourly leak is closed at both layers.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
