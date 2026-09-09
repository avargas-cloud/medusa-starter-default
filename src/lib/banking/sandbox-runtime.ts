/** Explicit development entrypoint, never imported by application routes/jobs. */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { parse } from "dotenv";
import { getDbPool } from "../../api/utils/db-pool";
import { requireBankingSandbox, bankingErrorCode } from "./security";
import { Migration20260908193000 } from "../../modules/banking/migrations/Migration20260908193000";
import { syncPendingBanks } from "./sync";
import { drainBankWebhooks } from "./webhooks";

export const BANK_SANDBOX_DIR = "/tmp/ept-bank-feed-sandbox";
const backend = resolve(__dirname, "../../..");
const workspace = resolve(backend, "..");
const keyFile = `${BANK_SANDBOX_DIR}/token-key`;
const self = resolve(__filename);
const loader = resolve(backend, "node_modules/tsx/dist/loader.mjs");

export function configureBankSandbox() {
  const credentials = parse(readFileSync(resolve(backend, ".env")));
  Object.assign(process.env, {
    ECOPOWERTECH_ENV: "sandbox", DATABASE_URL: "postgresql://postgres:sandbox@localhost:5499/medusa",
    REDIS_URL: "redis://localhost:6399", MEILISEARCH_HOST: "http://localhost:7799",
    MEILISEARCH_API_KEY: "sandbox_master_key", DISABLE_SCHEDULED_JOBS: "true",
    QB_BRIDGE_DISABLED: "true", QB_BRIDGE_URL: "http://localhost:9999/disabled",
    SMTP_DISABLED: "true", RESEND_API_KEY: "", SENDGRID_API_KEY: "", BAMS_WEBHOOK_DISABLED: "true",
    PLAID_CLIENT_ID: credentials.PLAID_CLIENT_ID || "", PLAID_SANDBOX_SECRET: credentials.PLAID_SANDBOX_SECRET || "",
    PLAID_PRODUCTION_SECRET: "", PLAID_SECRET: "", PLAID_ENV: "sandbox", BANKING_SANDBOX_WEBHOOK_URL: "",
    MEDUSA_BACKEND_URL: "http://localhost:9099", PORT: "9099",
    ADMIN_CORS: "http://localhost:3099,http://localhost:3001",
    STORE_CORS: "http://localhost:3099,http://localhost:4399,http://localhost:3001",
    AUTH_CORS: "http://localhost:3099,http://localhost:4399,http://localhost:3001",
    XDG_CONFIG_HOME: `${BANK_SANDBOX_DIR}/config`, MEDUSA_TELEMETRY_DISABLED: "true",
  });
  requireBankingSandbox();
  const info = statSync(keyFile);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error("UNSAFE_KEY_FILE");
  const key = readFileSync(keyFile, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("INVALID_SANDBOX_KEY");
  process.env.BANKING_SANDBOX_TOKEN_KEY = key;
}

async function setup() {
  // Refuse a missing key when encrypted connections already exist; never silently rotate it.
  process.env.DATABASE_URL = "postgresql://postgres:sandbox@localhost:5499/medusa";
  process.env.ECOPOWERTECH_ENV = "sandbox";
  requireBankingSandbox();
  const pool = getDbPool();
  const existing = await pool.query("SELECT to_regclass('public.bank_connection') AS name");
  if (!existsSync(keyFile) && existing.rows[0]?.name) {
    const tokens = await pool.query("SELECT 1 FROM bank_connection WHERE access_token_encrypted IS NOT NULL LIMIT 1");
    if (tokens.rowCount) throw new Error("RECOVER_EXISTING_ENCRYPTION_KEY");
  }
  const snapshot = resolve(workspace, "sandbox-artifacts/snapshots/pre-bank-feed-20260908.dump");
  if (!existsSync(snapshot)) execFileSync("bash", [resolve(workspace, "scripts/sandbox/snapshot.sh"),
    "pre-bank-feed-20260908", "Before banking sandbox schema and fixtures"], { cwd: workspace, stdio: "inherit" });
  await new Promise<void>((done, reject) => {
    const verifier = spawn("sg", ["docker", "-c", "docker exec -i sb_postgres pg_restore --list"], { stdio: ["pipe", "ignore", "ignore"] });
    verifier.on("error", reject);
    verifier.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") reject(error); });
    verifier.on("exit", (code) => code === 0 ? done() : reject(new Error("SNAPSHOT_VERIFICATION_FAILED")));
    // Listing needs only the archive TOC, so pg_restore may finish before reading every data block.
    verifier.stdin.end(readFileSync(snapshot));
  });
  mkdirSync(BANK_SANDBOX_DIR, { recursive: true, mode: 0o700 });
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  configureBankSandbox();
  // Execute precisely this new module's migration, not pending migrations in unrelated modules.
  const statements: string[] = [];
  const migration = Object.create(Migration20260908193000.prototype) as Migration20260908193000;
  migration.addSql = (statement: string) => { statements.push(statement); };
  await migration.up();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const statement of statements) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); await pool.end(); }
  console.log("PASS: verified snapshot, private sandbox key, five banking tables migrated atomically");
}

async function start() {
  configureBankSandbox();
  const user = await getDbPool().query("SELECT 1 FROM public.user WHERE email=$1 AND deleted_at IS NULL", ["sandbox@test.com"]);
  await getDbPool().end();
  if (!user.rowCount) throw new Error("SANDBOX_TEST_ADMIN_REQUIRED");
  for (const [session, mode] of [["sb-medusa", "--backend"], ["sb-banking", "--worker"]] as const) {
    try { execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" }); } catch { /* absent is safe */ }
    execFileSync("tmux", ["new-session", "-d", "-s", session, "-c", backend,
      `node --import ${loader} ${self} ${mode}`], { stdio: "inherit" });
  }
  for (let attempt = 0; attempt < 90; attempt++) {
    try { if ((await fetch("http://localhost:9099/health", { signal: AbortSignal.timeout(2000) })).ok) break; }
    catch { /* startup */ }
    if (attempt === 89) throw new Error("SANDBOX_BACKEND_START_TIMEOUT");
    await new Promise((done) => setTimeout(done, 1000));
  }
  execFileSync("bash", [resolve(workspace, "pos-sb")], { cwd: workspace, stdio: "inherit" });
  console.log("PASS: sandbox backend :9099, POS :3099 and banking-only worker started");
}

async function worker() {
  configureBankSandbox();
  while (true) {
    try { await drainBankWebhooks(); await syncPendingBanks(); }
    catch (error) { console.log(`[banking-sandbox] ${bankingErrorCode(error)}`); }
    await new Promise((done) => setTimeout(done, 60_000));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === self) {
  const mode = process.argv[2];
  const main = async () => {
    if (process.argv.length !== 3) throw new Error("INVALID_MODE");
    if (mode === "--setup") return setup();
    if (mode === "--start") return start();
    if (mode === "--worker") return worker();
    if (mode === "--build") {
      configureBankSandbox();
      // Dev compilers must not write the same generated directories during the build.
      for (const session of ["sb-medusa", "sb-pos", "sb-banking"]) {
        try { execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" }); } catch { /* already stopped */ }
      }
      execFileSync("yarn", ["build"], { cwd: backend, env: process.env, stdio: "inherit" });
      for (const path of ["lib/banking/connections", "lib/banking/sync", "lib/banking/webhooks", "api/admin/banking/route", "modules/banking",
        "lib/banking/review-core", "lib/banking/review-rules", "lib/banking/review-daily", "lib/banking/review-attachments",
        "api/admin/banking/daily/confirm/route", "api/admin/banking/rules/route", "api/admin/banking/attachments/[id]/download/route",
        "lib/banking/deposit-core", "lib/banking/deposit-matching", "api/admin/banking/deposits/route",
        "api/admin/banking/deposits/[id]/ready/route", "api/admin/banking/deposits/[id]/void/route",
        "api/admin/banking/deposit-candidates/route", "api/admin/banking/transactions/[id]/deposit-candidates/route",
        "lib/accounting/banking-period-lock", "lib/banking/accounting-core", "lib/banking/accounting-read",
        "api/admin/banking/accounting/transactions/route", "api/admin/banking/accounting/transactions/[id]/route",
        "api/admin/banking/accounting/transactions/[id]/preview/route", "api/admin/banking/accounting/transactions/[id]/post/route",
        "api/admin/banking/accounting/transactions/[id]/reverse/route", "api/admin/reports/_lib/bank-expense-costs",
        "api/admin/accounting/month-close/route", "api/admin/accounting/month-close/reopen/route",
        "lib/banking/receipts-core", "lib/banking/receipts-read", "lib/banking/receipts-setup",
        "lib/banking/receipts-source", "lib/banking/receipts-transfer",
        ...["setup", ...["receipts", "deposits", "payment-matches"].flatMap(kind =>
          [kind, `${kind}/[id]`, `${kind}/[id]/preview`, `${kind}/[id]/post`, `${kind}/[id]/reverse`])]
          .map(path => `api/admin/banking/accounting/${path}/route`),
        "lib/banking/opening-core", "lib/banking/opening-read", "lib/banking/opening-funding",
        "lib/banking/movement-core", "lib/banking/movement-read", "lib/banking/completion-journal",
        "lib/banking/merchant-receipts", "lib/banking/settlement-core", "lib/banking/settlement-read",
        "lib/banking/statement-core", "lib/banking/statement-read",
        ...["20260909180000","20260909190000","20260909200000"].map(id=>`modules/banking/migrations/Migration${id}`),
        ...["movements","settlements","statements"].flatMap(kind=>["","/[id]","/[id]/preview"].map(p=>`api/admin/banking/${kind}${p}/route`)),
        ...["movements","settlements"].flatMap(kind=>["post","reverse"].map(action=>`api/admin/banking/${kind}/[id]/${action}/route`)),
        ...["receive","receive-preview"].map(action=>`api/admin/banking/movements/[id]/${action}/route`),
        ...["evidence","evidence/[id]","movements/accounts","movements/sources","settlements/sources"].map(p=>`api/admin/banking/${p}/route`),
        ...["close","reopen","matches","unmatch","export"].map(action=>`api/admin/banking/statements/[id]/${action}/route`),
        ...["preview","post","[id]","[id]/reverse"].map(p=>`api/admin/banking/merchant-receipts/${p}/route`),
        ...["", "/[id]", "/[id]/preview", "/[id]/adopt", "/[id]/revoke", "/evidence", "/evidence/[id]",
          "/items/[id]/clear", "/items/[id]/unclear", "/items/[id]/candidates"].map(path => `api/admin/banking/accounting/openings${path}/route`)]) {
        require(resolve(backend, ".medusa/server/src", path));
      }
      execFileSync("npm", ["run", "build"], { cwd: resolve(workspace, "store-pos"), env: process.env, stdio: "inherit" });
      console.log("PASS: backend emitted imports and POS production build");
      return;
    }
    if (mode === "--backend") {
      configureBankSandbox();
      const child = spawn(resolve(backend, "node_modules/.bin/medusa"), ["develop"], {
        cwd: backend, env: process.env, stdio: "inherit",
      });
      child.on("exit", (code) => { process.exitCode = code ?? 1; });
      return;
    }
    throw new Error("INVALID_MODE");
  };
  void main().catch((error: unknown) => {
    const code = (error as { code?: unknown })?.code;
    console.error("BANK_SANDBOX_RUNTIME_FAILED", typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "CHECK_FAILED");
    process.exit(1);
  });
}
