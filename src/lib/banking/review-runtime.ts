/** Explicit sandbox setup. Never imported by application routes or workers. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { getDbPool } from "../../api/utils/db-pool";
import { configureBankSandbox } from "./sandbox-runtime";
import { requireBankingEnabled } from "./security";
import { Migration20260908223000 } from "../../modules/banking/migrations/Migration20260908223000";

const workspace = resolve(__dirname, "../../../..");
const financialTables = ["customer_payment", "payment_application", "pos_invoice", "pos_credit_memo",
  "vendor_bill", "qb_account", "treasury_distribution_log", "qb_order_pipeline"] as const;

async function setup(): Promise<void> {
  configureBankSandbox();
  requireBankingEnabled();
  const snapshot = resolve(workspace, "sandbox-artifacts/snapshots/pre-bank-review-20260908.dump");
  if (!existsSync(snapshot)) execFileSync("bash", [resolve(workspace, "scripts/sandbox/snapshot.sh"),
    "pre-bank-review-20260908", "Before banking daily review schema and fixtures"],
  { cwd: workspace, stdio: "inherit" });
  await new Promise<void>((done, reject) => {
    const verifier = spawn("sg", ["docker", "-c", "docker exec -i sb_postgres pg_restore --list"],
      { stdio: ["pipe", "ignore", "ignore"] });
    verifier.on("error", reject);
    verifier.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") reject(error); });
    verifier.on("exit", (code) => code === 0 ? done() : reject(new Error("SNAPSHOT_VERIFICATION_FAILED")));
    verifier.stdin.end(readFileSync(snapshot));
  });
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('banking-review', 7241))");
    const before: string[] = [];
    for (const table of financialTables) {
      const result = await client.query(`SELECT md5(coalesce(string_agg(md5(row_to_json(t)::text), '' ORDER BY id), '')) AS hash FROM ${table} t`);
      before.push(result.rows[0].hash as string);
    }
    const statements: string[] = [];
    const migration = Object.create(Migration20260908223000.prototype) as Migration20260908223000;
    migration.addSql = (statement: string) => { statements.push(statement); };
    await migration.up();
    for (const statement of statements) await client.query(statement);
    for (const [index, table] of financialTables.entries()) {
      const result = await client.query(`SELECT md5(coalesce(string_agg(md5(row_to_json(t)::text), '' ORDER BY id), '')) AS hash FROM ${table} t`);
      if (result.rows[0].hash !== before[index]) throw new Error("FINANCIAL_FINGERPRINT_CHANGED");
    }
    await client.query("COMMIT");
    console.log("PASS: verified snapshot; six review tables and source/setup columns migrated; eight financial fingerprints unchanged");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); await pool.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  void (async () => {
    if (process.argv.length !== 3 || process.argv[2] !== "--setup") throw new Error("INVALID_MODE");
    await setup();
  })().catch((error: unknown) => {
    const code = (error as { code?: unknown })?.code;
    console.error("BANK_REVIEW_SETUP_FAILED", typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "CHECK_FAILED");
    process.exit(1);
  });
}
