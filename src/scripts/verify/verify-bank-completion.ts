/** Approved V11-V13 entrypoint plus f834a6ed empty-schema bootstrap delta. Never replay over existing Banking. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getDbPool } from "../../api/utils/db-pool";
import { configureCompletionSandbox, completionDirectory, completionPreflight } from "../tests/bank-completion-fixtures";
import { bootstrapCompletionPrerequisites } from "../../lib/banking/bank-completion-bootstrap";
import { completionInfrastructureHealth, createCompletionAdmin } from "../../lib/banking/bank-completion-admin";
import { migrateCompletionSandbox } from "../../lib/banking/completion-sandbox-migrations";
import { runBankMovementsSandbox, type MovementBrowserHook } from "../tests/e2e-bank-movements-sandbox";
import { runBankSettlementsSandbox, type SettlementBrowserHook } from "../tests/e2e-bank-settlements-sandbox";
import { runBankStatementsSandbox, type StatementBrowserHook } from "../tests/e2e-bank-statements-sandbox";
import { createCompletionBankFixture } from "../tests/bank-completion-account-fixtures";
import { runCompletionRegressions } from "../../lib/banking/completion-sandbox-regressions";
import { recoverStatementFixtures, recoverStatementFixturesFromEvidence, statementConnection,
  type StatementRecovery } from "../tests/bank-statements-fixtures";

async function main() {
  assert.equal(process.argv.length, 2, "Run the approved entrypoint without flags");
  configureCompletionSandbox();
  assert(existsSync(resolve(completionDirectory, "pre-edit-hashes.json")), "Verified local WIP backup is required");
  const pool = getDbPool(), client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout='60s'");
    await client.query("SET LOCAL lock_timeout='5s'");
    let report = await completionPreflight(client);
    await client.query("ROLLBACK");
    mkdirSync(completionDirectory, { recursive: true, mode: 0o700 });
    let file = resolve(completionDirectory, `preflight-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
    const emptyBanking = Object.keys(report.data).every(table => !table.startsWith("bank_"));
    if (emptyBanking) {
      console.log("Applying approved empty-schema delta f834a6ed: verified snapshot, six original migrations, six tracking records.");
      await bootstrapCompletionPrerequisites(client);
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout='60s'");
      await client.query("SET LOCAL lock_timeout='5s'");
      report = await completionPreflight(client);
      await client.query("ROLLBACK");
      file = resolve(completionDirectory, `preflight-after-bootstrap-${Date.now()}.json`);
      writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
    }
    if (!report.sandbox_admin_exists) {
      console.log("Applying approved synthetic admin delta dfa6e93b: exactly three new identity rows.");
      await createCompletionAdmin(client, "sandbox123");
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      report = await completionPreflight(client);
      await client.query("ROLLBACK");
      file = resolve(completionDirectory, `preflight-after-admin-${Date.now()}.json`);
      writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
    }
    assert(report.missing_prerequisites.length === 0, `Missing V10 prerequisites: ${report.missing_prerequisites.join(", ")}; `
      + `existing Banking tables: ${Object.keys(report.data).filter(table => table.startsWith("bank_")).join(", ") || "none"}; evidence ${file}`);
    console.log(`PASS V11-V13 read-only preflight: ${Object.keys(report.data).length} table fingerprints, `
      + `${Object.keys(report.protected_data).length} protected sources, ${report.schema.triggers.length} triggers; ${file}`);
    console.log("PASS current prerequisite schema inspected before migration/test phase");
    console.log(`Existing sandbox test admin: ${report.sandbox_admin_exists ? "present" : "ABSENT; runtime startup requires separate resolution"}`);
    const infrastructure = await completionInfrastructureHealth();
    writeFileSync(resolve(completionDirectory, `infrastructure-${Date.now()}.json`), JSON.stringify(infrastructure, null, 2),
      { mode: 0o600, flag: "wx" });
    console.log("Read-only local service health:", infrastructure);
    const snapshot=await migrateCompletionSandbox(client);
    if ((await client.query("SELECT 1 FROM bank_connection WHERE id=$1",[statementConnection])).rowCount) {
      const recoveryFile=resolve(completionDirectory,"statements-recovery.json");
      if(existsSync(recoveryFile)) await recoverStatementFixtures(client,JSON.parse(readFileSync(recoveryFile,"utf8")) as StatementRecovery);
      else await recoverStatementFixturesFromEvidence(client,
        resolve(completionDirectory,"preflight-1788963814199.json"),resolve(completionDirectory,"e2e-result-1788963814360.json"));
      console.log("PASS exact owned statement recovery: prior Banking baseline restored; protected sources unchanged");
    }
    for(let attempt=0;attempt<60;attempt++) {
      try { if((await fetch("http://localhost:9099/health",{signal:AbortSignal.timeout(1000)})).ok)break; } catch { /* watcher restart */ }
      assert(attempt<59,"Sandbox backend must finish startup before any fixture");
      await new Promise(done=>setTimeout(done,1000));
    }
    const cleanupAccount=await createCompletionBankFixture(client);
    try {
      process.env.POS_URL="http://localhost:3099";
      process.env.MEDUSA_SANDBOX_URL="http://localhost:9099";
      const browser=await import(pathToFileURL(resolve(__dirname,"../../../../store-pos/scripts/e2e/bank-completion.mjs")).href) as {
        runBankCompletionBrowser:MovementBrowserHook & SettlementBrowserHook; runBankStatementsBrowser:StatementBrowserHook };
      const results:Record<string,unknown>={},resultFile=resolve(completionDirectory,`e2e-result-${Date.now()}.json`);
      const persist=()=>writeFileSync(resultFile,JSON.stringify(results,null,2),{mode:0o600});
      results.movements=await runBankMovementsSandbox(snapshot,browser.runBankCompletionBrowser);persist();
      results.settlements=await runBankSettlementsSandbox(snapshot,browser.runBankCompletionBrowser);persist();
      results.statements=await runBankStatementsSandbox(snapshot,browser.runBankStatementsBrowser);persist();
      console.log("PASS V11-V13 API and browser result",JSON.stringify(results));
      results.regressions=await runCompletionRegressions();persist();
    } finally { await cleanupAccount(); }
  } catch (error) {
    await client.query("ROLLBACK");
    try { console.error(execFileSync("tmux",["capture-pane","-t","sb-medusa","-p","-S","-10000"],{encoding:"utf8"})
      .split("\n").filter(line=>line.includes("[banking SQL]")).join("\n")); }catch{ /* primary error retained */ }
    throw error;
  } finally { client.release(); await pool.end(); }
}
void main().catch((error: unknown) => {
  console.error("BANK_COMPLETION_PREFLIGHT_FAILED", error instanceof Error ? error.message : "UNKNOWN_ERROR");
  process.exitCode = 1;
});
