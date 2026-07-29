/**
 * Proves that `meilisearch_drift_log` actually accepts the rows the
 * reconciliation framework writes to it.
 *
 * This gate exists because the insert was broken from the table's creation in
 * May 2026 until 2026-07-29 and nothing noticed: it threw inside the driver, the
 * caller degraded it to a warning so drift would still get FIXED, and the audit
 * log stayed empty in sandbox and production alike. A type-check cannot see it —
 * the statement is a template literal handed to postgres.js — and no unit test
 * can either, because the failure only happens against a real driver.
 *
 * So this calls insertDriftLogRows, the same function the reconciler calls, and
 * reads the row back. A copy of the statement here would prove nothing.
 *
 * Writes NOTHING: everything happens inside a transaction that is always rolled
 * back, including on success.
 *
 * Usage (sandbox):
 *   env DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa' \
 *     ./node_modules/.bin/medusa exec ./src/scripts/verify/verify-drift-log-insert.ts
 *
 * Exit codes: 0 the insert works · 1 it does not · 2 could not run.
 */
import type { ExecArgs } from "@medusajs/framework/types";
import postgres from "postgres";

import {
  insertDriftLogRows,
  type DriftLogRow,
} from "../../lib/meilisearch/drift-reconciler";

/** Thrown to roll the probe back. Never an actual failure. */
class Rollback extends Error {}

export default async function run(_args: ExecArgs): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(2);
  }

  // Values chosen to cover what actually broke and what could: a plain string, a
  // JSON-stringified number (money arrives as one), an empty string, and nulls.
  const rows: DriftLogRow[] = [
    {
      id: "msdl_probe_1",
      entity_type: "zz_probe",
      entity_id: "probe_entity_1",
      field_name: "effective_payment",
      db_value: "voided",
      meili_value: "fully_paid",
    },
    {
      id: "msdl_probe_2",
      entity_type: "zz_probe",
      entity_id: "probe_entity_1",
      field_name: "total_cents",
      db_value: "16424",
      meili_value: "999999",
    },
    {
      id: "msdl_probe_3",
      entity_type: "zz_probe",
      entity_id: "probe_entity_2",
      field_name: "sales_rep_initials",
      db_value: "",
      meili_value: null,
    },
  ];

  const sql = postgres(url, { max: 1 });
  let ok = false;
  let detail = "";

  try {
    await sql.begin(async (tx) => {
      await insertDriftLogRows(tx as unknown as postgres.Sql, rows);

      const back = await tx<
        Array<{
          id: string;
          entity_id: string;
          field_name: string;
          db_value: string | null;
          meili_value: string | null;
          detected_at: Date;
          fixed_at: Date | null;
        }>
      >`
        SELECT id, entity_id, field_name, db_value, meili_value, detected_at, fixed_at
        FROM meilisearch_drift_log
        WHERE entity_type = 'zz_probe'
        ORDER BY id
      `;

      const problems: string[] = [];
      if (back.length !== rows.length) {
        problems.push(`expected ${rows.length} rows back, got ${back.length}`);
      }
      for (const expected of rows) {
        const actual = back.find((r) => r.id === expected.id);
        if (!actual) {
          problems.push(`${expected.id} did not come back`);
          continue;
        }
        if (actual.db_value !== expected.db_value) {
          problems.push(
            `${expected.id}.db_value: wrote ${JSON.stringify(expected.db_value)}, read ${JSON.stringify(actual.db_value)}`
          );
        }
        if (actual.meili_value !== expected.meili_value) {
          problems.push(
            `${expected.id}.meili_value: wrote ${JSON.stringify(expected.meili_value)}, read ${JSON.stringify(actual.meili_value)}`
          );
        }
        // The digest orders findings by first detection and treats fixed_at as
        // "the sweep repaired it", so the defaults have to hold.
        if (!actual.detected_at) problems.push(`${expected.id}.detected_at did not default`);
        if (actual.fixed_at !== null) problems.push(`${expected.id}.fixed_at should start null`);
      }

      ok = problems.length === 0;
      detail = problems.join("\n  ");
      throw new Rollback();
    });
  } catch (err: unknown) {
    if (!(err instanceof Rollback)) {
      console.error(`\nDRIFT LOG INSERT FAILED: ${(err as Error).message}\n`);
      await sql.end();
      process.exit(1);
    }
  }

  // Belt and suspenders: prove the rollback took, so a future edit that drops
  // the transaction cannot leave probe rows behind in a real database.
  const leftover = await sql`
    SELECT count(*)::int AS n FROM meilisearch_drift_log WHERE entity_type = 'zz_probe'
  `;
  const leaked = Number(leftover[0]?.n ?? 0);
  await sql.end();

  console.log(`\nmeilisearch_drift_log insert probe`);
  console.log(`  rows written and read back : ${ok ? `${rows.length}/${rows.length}` : "MISMATCH"}`);
  console.log(`  rows left behind           : ${leaked} (must be 0)\n`);

  if (!ok) {
    console.error(`FAILED:\n  ${detail}\n`);
    process.exit(1);
  }
  if (leaked !== 0) {
    console.error(`FAILED: the probe leaked ${leaked} rows — the rollback did not take.\n`);
    process.exit(1);
  }
  console.log("OK — the reconciler's audit log accepts what the reconciler writes.\n");
  process.exit(0);
}
