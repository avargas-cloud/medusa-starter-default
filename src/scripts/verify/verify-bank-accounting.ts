/** Approved sandbox v8 entrypoint: snapshot, own migration, real HTTP/DB/browser twice. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { getDbPool } from "../../api/utils/db-pool";
import { configureBankSandbox } from "../../lib/banking/sandbox-runtime";
import { transaction } from "../../lib/banking/store";
import { withReviewLock } from "../../lib/banking/review-common";
import { bankAccountingCurrency } from "../../lib/banking/accounting-types";
import { Migration20260909022000 } from "../../modules/banking/migrations/Migration20260909022000";
import { fingerprints, verifiedSnapshot } from "../tests/bank-accounting-fixtures";

async function main() {
  assert.equal(process.argv.length, 2, "Use this exact sandbox entrypoint without flags");
  configureBankSandbox();
  const backend = resolve(__dirname, "../../..");
  const loader = resolve(backend, "node_modules/tsx/dist/loader.mjs");
  const pool = getDbPool(); const client = await pool.connect();
  try {
    const currencies = (await client.query(`SELECT account_type,currency,count(*)::int AS count FROM qb_account
      WHERE is_active AND deleted_at IS NULL AND account_type IN ('Bank','Expense','OtherExpense') GROUP BY account_type,currency ORDER BY account_type,currency`)).rows;
    console.log("V8 read-only currency preflight", JSON.stringify(currencies));
    assert(currencies.some(row => row.account_type === "Bank" && bankAccountingCurrency(row.account_type, row.currency) === "USD"), "Existing explicit USD Bank mapping required; no QB cache writes authorized");
    assert(currencies.some(row => row.account_type === "Expense" && bankAccountingCurrency(row.account_type, row.currency) === "USD"), "Existing functional USD Expense account required; no QB cache writes authorized");
    await verifiedSnapshot(client);
    const before = await fingerprints(client);
    const present = await client.query("SELECT to_regclass('public.bank_journal_entry') AS name");
    if (!present.rows[0].name) {
      const migration = Object.create(Migration20260909022000.prototype) as Migration20260909022000;
      const statements: string[] = []; migration.addSql = (statement: string) => { statements.push(statement); };
      await migration.up();
      await transaction(client, async () => { await withReviewLock(client); for (const sql of statements) await client.query(sql); });
    }
    for (const name of ["bank_direct_expense", "bank_journal_entry", "bank_journal_line"]) {
      assert((await client.query("SELECT to_regclass($1::text) AS name", [`public.${name}`])).rows[0].name, `Own table ${name} present`);
    }
    const guard = (await client.query(`SELECT tgname,tgenabled FROM pg_trigger
      WHERE tgname IN ('bank_journal_entry_immutable','bank_journal_line_immutable','bank_journal_source_claim',
        'bank_journal_entry_balance','bank_journal_line_balance')`)).rows;
    assert(guard.length === 5 && guard.every(row => row.tgenabled === "O"), "Five journal constraints/triggers enabled");
    assert.deepEqual(await fingerprints(client), before, "Own additive migration preserves all protected sources");
    console.log("PASS targeted v8 migration and extended-protocol schema binding; protected sources unchanged");
  } finally { client.release(); await pool.end(); }
  execFileSync(process.execPath, ["--import", loader, resolve(backend, "src/lib/banking/sandbox-runtime.ts"), "--start"],
    { cwd: backend, env: process.env, stdio: "inherit" });
  for (let run = 1; run <= 2; run++) {
    console.log(`START v8 HTTP/DB/browser run ${run}/2`);
    execFileSync(process.execPath, ["--import", loader, resolve(backend, "src/scripts/tests/e2e-bank-accounting-sandbox.ts")],
      { cwd: backend, env: process.env, stdio: "inherit" });
  }
  for (const script of ["verify/verify-bank-deposits.ts", "tests/e2e-bank-matches-sandbox.ts"]) {
    console.log(`START preserved v5-v7 banking regression ${script}`);
    execFileSync(process.execPath, ["--import", loader, resolve(backend, "src/scripts", script)],
      { cwd: backend, env: process.env, stdio: "inherit" });
  }
  console.log("PASS bank accounting v8: two real integration runs; own residue=0; protected sources unchanged");
}
void main().catch((error: unknown) => {
  console.error("BANK_ACCOUNTING_VERIFICATION_FAILED", error instanceof Error ? error.message : "UNKNOWN_ERROR");
  process.exitCode = 1;
});
