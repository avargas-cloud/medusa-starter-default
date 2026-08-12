/**
 * verify-status-automation
 *
 * Read-only gate for the `order_status` consolidation
 * (`src/scripts/fix/migrate-order-status-sent-by-email.ts`) and for the
 * `pos_activity` native Activity Log rows it shares a table with
 * (`order_change`, see `src/lib/pos/order-activity.ts`).
 *
 * Checks:
 *   1. legacy_status_gone       — 0 rows still carry legacy order_status values.
 *      Before the migration runs this is EXPECTED to FAIL — it is the POST gate,
 *      not a pre-check. Set PRE_MIGRATION=true to make it informational instead
 *      of a failure, so this script can also run before migrating.
 *   2. pos_activity_wellformed  — every `order_change` row with
 *      change_type='pos_activity' has internal_note prefixed with
 *      '__pos_activity__', a JSON body (parsed in JS, never SQL) with an
 *      `event` key, and status='confirmed'.
 *   3. pos_activity_survives_prune — smoke check: for every order that has
 *      pos_activity rows AND more than one order_change row total, the
 *      pos_activity rows are still present. Not a substitute for the real
 *      E2E, which exercises this against sandbox.
 *   4. no_estimate_status_legacy — 0 rows carry legacy values under the
 *      SEPARATE metadata.estimate_status key (never touched by the migration).
 *
 * Run:
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-status-automation.ts
 *
 * Before migrating (check 1 becomes informational):
 *   env DATABASE_URL=... PRE_MIGRATION=true \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-status-automation.ts
 */
import { Client } from "pg";

const PRE_MIGRATION = process.env.PRE_MIGRATION === "true";
const POS_ACTIVITY_PREFIX = "__pos_activity__";

let failures = 0;
function report(ok: boolean, num: number, label: string, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${num}. ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

interface PosActivityRow {
  id: string;
  order_id: string;
  internal_note: string | null;
  status: string;
}

async function checkLegacyStatusGone(client: Client): Promise<void> {
  const { rows } = await client.query<{ id: string; display_id: string | null }>(
    `SELECT id, display_id FROM "order"
      WHERE deleted_at IS NULL AND metadata->>'order_status' IN ('Sent','Email Sent')`
  );
  if (PRE_MIGRATION) {
    console.log(
      `INFO 1. legacy_status_gone — ${rows.length} legacy row(s) remain (PRE_MIGRATION=true, not a failure)`
    );
    return;
  }
  report(
    rows.length === 0,
    1,
    "legacy_status_gone",
    rows.length > 0
      ? `${rows.length} row(s) still carry legacy values: ${rows
          .slice(0, 10)
          .map((r) => r.display_id ?? r.id)
          .join(", ")}`
      : ""
  );
}

function isPosActivityWellformed(row: PosActivityRow): boolean {
  if (!row.internal_note || !row.internal_note.startsWith(POS_ACTIVITY_PREFIX)) {
    return false;
  }
  if (row.status !== "confirmed") return false;
  const jsonPart = row.internal_note.slice(POS_ACTIVITY_PREFIX.length);
  try {
    const parsed = JSON.parse(jsonPart) as Record<string, unknown>;
    return typeof parsed === "object" && parsed !== null && "event" in parsed;
  } catch {
    return false;
  }
}

async function checkPosActivityWellformed(client: Client): Promise<void> {
  const { rows } = await client.query<PosActivityRow>(
    `SELECT id, order_id, internal_note, status FROM order_change
      WHERE change_type = 'pos_activity' AND deleted_at IS NULL`
  );
  if (rows.length === 0) {
    report(true, 2, "pos_activity_wellformed", "0 rows — sin actividad nativa aún");
    return;
  }
  const malformed = rows.filter((r) => !isPosActivityWellformed(r));
  report(
    malformed.length === 0,
    2,
    "pos_activity_wellformed",
    `${rows.length} total, ${malformed.length} malformed${
      malformed.length > 0
        ? `: ${malformed
            .slice(0, 10)
            .map((r) => r.id)
            .join(", ")}`
        : ""
    }`
  );
}

async function checkPosActivitySurvivesPrune(client: Client): Promise<void> {
  const { rows } = await client.query<{
    order_id: string;
    total: string;
    pos_count: string;
  }>(
    `SELECT order_id, count(*) AS total,
            count(*) FILTER (WHERE change_type = 'pos_activity') AS pos_count
       FROM order_change
      WHERE deleted_at IS NULL
      GROUP BY order_id
     HAVING count(*) FILTER (WHERE change_type = 'pos_activity') > 0
        AND count(*) > 1`
  );
  if (rows.length === 0) {
    report(true, 3, "pos_activity_survives_prune", "sin casos");
    return;
  }
  const missing = rows.filter((r) => Number(r.pos_count) === 0);
  report(
    missing.length === 0,
    3,
    "pos_activity_survives_prune",
    `${rows.length} order(s) checked, ${missing.length} lost their pos_activity rows`
  );
}

async function checkNoEstimateStatusLegacy(client: Client): Promise<void> {
  const { rows } = await client.query<{ id: string; display_id: string | null }>(
    `SELECT id, display_id FROM "order"
      WHERE deleted_at IS NULL AND metadata->>'estimate_status' IN ('Sent','Email Sent')`
  );
  report(
    rows.length === 0,
    4,
    "no_estimate_status_legacy",
    rows.length > 0
      ? `${rows.length} row(s): ${rows
          .slice(0, 10)
          .map((r) => r.display_id ?? r.id)
          .join(", ")}`
      : ""
  );
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const client = new Client({ connectionString });
  await client.connect();
  try {
    console.log(`\nverify-status-automation${PRE_MIGRATION ? " (PRE_MIGRATION)" : ""}\n`);
    await checkLegacyStatusGone(client);
    await checkPosActivityWellformed(client);
    await checkPosActivitySurvivesPrune(client);
    await checkNoEstimateStatusLegacy(client);
  } finally {
    await client.end();
  }

  console.log("");
  if (failures > 0) {
    console.error(`FAIL — ${failures} check(s) failed.`);
    process.exitCode = 1;
    return;
  }
  console.log("PASS — all checks green.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
