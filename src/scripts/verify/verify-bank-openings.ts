/** Approved sandbox-only v10 entrypoint; never replays older migration definitions. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { configureBankSandbox } from "../../lib/banking/sandbox-runtime";
import { getDbPool } from "../../api/utils/db-pool";
import { transaction } from "../../lib/banking/store";
import { withReviewLock } from "../../lib/banking/review-common";
import { openingPreflight, openingSnapshot, fingerprints, openingTables } from "../tests/bank-openings-fixtures";
import { seedLegacyJournal, cleanReceiptFixtures } from "../tests/bank-receipts-fixtures";
import { journalNegativeControls } from "../tests/bank-accounting-fixtures";
import { Migration20260909060000 } from "../../modules/banking/migrations/Migration20260909060000";

async function columnsBefore(client: PoolClient) {
  const rows = (await client.query<{ table_name: string; column_name: string }>(`SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema='public' AND starts_with(table_name,'bank_') ORDER BY table_name,ordinal_position`)).rows;
  const result: Record<string, string[]> = {};
  for (const row of rows) {
    assert(/^[a-z_][a-z0-9_]*$/.test(row.table_name) && /^[a-z_][a-z0-9_]*$/.test(row.column_name));
    (result[row.table_name] ??= []).push(row.column_name);
  }
  return result;
}
async function oldShape(client: PoolClient, columns: Record<string, string[]>) {
  const result: Record<string, unknown> = {};
  for (const [table, names] of Object.entries(columns)) {
    result[table] = (await client.query(`SELECT count(*)::text count,
      md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY to_jsonb(t)::text),'')) hash
      FROM (SELECT ${names.join(",")} FROM ${table}) t`)).rows[0];
  }
  return result;
}
async function main() {
  assert.equal(process.argv.length, 2, "Run the exact approved entrypoint without flags");
  configureBankSandbox();
  const pool = getDbPool(), client = await pool.connect();
  try {
    await openingPreflight(client);
    await openingSnapshot(client);
    const protectedBefore = await fingerprints(client);
    const ready = Boolean((await client.query("SELECT to_regclass('public.bank_opening_balance') name")).rows[0].name);
    if (!ready) {
      let owns = false;
      try {
        assert(!(await client.query("SELECT 1 FROM bank_connection WHERE id='bank_e2e_receipts_v9_connection'")).rowCount,
          "No unresolved own fixture before migration preservation test");
        assert(!(await client.query("SELECT 1 FROM bank_accounting_setup UNION ALL SELECT 1 FROM bank_review_event WHERE entity_id='local-usd'")).rowCount,
          "Legacy probe cleanup must never remove an operator accounting setup");
        owns = true;
        const entry = await seedLegacyJournal(client);
        const columns = await columnsBefore(client), before = await oldShape(client, columns);
        const migration = Object.create(Migration20260909060000.prototype) as Migration20260909060000;
        const sql: string[] = []; migration.addSql = (statement: string) => { sql.push(statement); };
        await migration.up();
        assert(sql.length > 0, "Migration must actually emit SQL");
        await transaction(client, async () => {
          await withReviewLock(client);
          for (const [index, statement] of sql.entries()) {
            try { await client.query(statement); }
            catch (error) {
              const detail = error as { message?: string; where?: string; position?: string };
              throw new Error(`V10 migration statement ${index + 1}: ${detail.message}; position=${detail.position ?? "none"}; ${detail.where ?? ""}`);
            }
          }
        });
        assert.deepEqual(await oldShape(client, columns), before, "Every old banking column/snapshot survives v10 migration exactly");
        for (const table of openingTables) assert.equal((await client.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
        console.log(`PASS v10 atomic migration, all legacy rows preserved; ${await journalNegativeControls(client, entry)} v8 SQL negative controls`);
      } finally { if (owns) await cleanReceiptFixtures(client); }
    }
    assert.deepEqual(await fingerprints(client), protectedBefore, "V10 migration preserves all protected financial sources");
    await openingPreflight(client);
  } finally { client.release(); await pool.end(); }
  const backend = resolve(__dirname, "../../.."), loader = resolve(backend, "node_modules/tsx/dist/loader.mjs");
  const run = (script: string) => execFileSync(process.execPath, ["--import", loader, resolve(backend, script)],
    { cwd: backend, env: process.env, stdio: "inherit", timeout: 600000 });
  execFileSync(process.execPath, ["--import", loader, resolve(backend, "src/lib/banking/sandbox-runtime.ts"), "--start"],
    { cwd: backend, env: process.env, stdio: "inherit", timeout: 180000 });
  run("src/scripts/tests/e2e-bank-openings-sandbox.ts");
  run("src/scripts/tests/e2e-bank-openings-sandbox.ts");
  // Use E2E directly: the old v9 verifier replaces SQL functions and cannot run after v10.
  run("src/scripts/tests/e2e-bank-receipts-sandbox.ts");
  run("src/scripts/tests/e2e-bank-accounting-sandbox.ts");
  run("src/scripts/verify/verify-bank-deposits.ts");
  run("src/scripts/tests/e2e-bank-matches-sandbox.ts");
  console.log("PASS v10 verifier: two clean opening E2E runs and v7-v9 regressions; no older DDL replay");
}
void main().catch((error: unknown) => {
  console.error("BANK_OPENINGS_VERIFICATION_FAILED", error instanceof Error ? error.message : "UNKNOWN_ERROR");
  process.exitCode = 1;
});
