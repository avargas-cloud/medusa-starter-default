/** Explicit development helper; no top-level execution. Its caller needs the separate bootstrap delta. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { requireBankingSandbox } from "./security";
import { withReviewLock } from "./review-common";
import { completionColumns, completionDirectory, completionLegacyMigrations, completionPreflight,
  completionTableFingerprints } from "../../scripts/tests/bank-completion-fixtures";
import { fingerprints } from "../../scripts/tests/bank-accounting-fixtures";
import { Migration20260908193000 } from "../../modules/banking/migrations/Migration20260908193000";
import { Migration20260908223000 } from "../../modules/banking/migrations/Migration20260908223000";
import { Migration20260909005000 } from "../../modules/banking/migrations/Migration20260909005000";
import { Migration20260909022000 } from "../../modules/banking/migrations/Migration20260909022000";
import { Migration20260909040000 } from "../../modules/banking/migrations/Migration20260909040000";
import { Migration20260909060000 } from "../../modules/banking/migrations/Migration20260909060000";

const workspace = resolve(__dirname, "../../../..");
const snapshot = resolve(workspace, "sandbox-artifacts/snapshots/pre-bank-completion-v11-v13.dump");
const cleanProcessEnv = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
const migrationClasses = [Migration20260908193000, Migration20260908223000, Migration20260909005000,
  Migration20260909022000, Migration20260909040000, Migration20260909060000];
const expectedHashes = [
  "967445f96a349f52a40941d396f77db4eb6796dd28682f184189e766d60b29da",
  "358ef29ccb79e1c1406ee4ddd1941611ec1e93eee12e5f1cd0fd400d2c585cc6",
  "1e4123de2c93b9a4efc9ec878f87e1015371fe017da9d939287f902b542f55b0",
  "78d64eb3de18494e6e88527e00cff47f6168050dd49b8019ed0a73e069ede284",
  "d9236e47a8d461ea56130e2b3753e8094c7c458052c35f9caed12d5548bcbece",
  "e043c483a2378f351cc02b3576be55f9776f3e2aa2b0977e30732fef626f8de5",
];
const expectedTables = ["bank_connection", "bank_account", "bank_transaction", "bank_sync_run", "bank_webhook_event",
  "bank_review_rule", "bank_transaction_review", "bank_review_event", "bank_day_close", "bank_review_attachment",
  "bank_review_permission", "bank_deposit", "bank_deposit_line", "bank_direct_expense", "bank_journal_entry",
  "bank_journal_line", "bank_accounting_setup", "bank_receipt_accounting", "bank_receipt_consumption",
  "bank_opening_evidence", "bank_opening_balance", "bank_opening_item", "bank_opening_clear"].sort();
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

export async function completionBootstrapManifest() {
  const archived = JSON.parse(readFileSync(resolve(completionDirectory, "pre-edit-hashes.json"), "utf8")) as Record<string, string>;
  const migrations = [];
  for (const [index, MigrationClass] of migrationClasses.entries()) {
    const name = completionLegacyMigrations[index]!;
    const path = `backend/src/modules/banking/migrations/${name}.ts`;
    const hash = sha256(readFileSync(resolve(workspace, path)));
    assert.equal(hash, archived[path], `Original WIP migration changed: ${name}`);
    assert.equal(hash, expectedHashes[index], `Audited migration content changed: ${name}`);
    const instance = Object.create(MigrationClass.prototype) as InstanceType<typeof MigrationClass>;
    const sql: string[] = [];
    instance.addSql = statement => { assert.equal(typeof statement, "string"); sql.push(statement as string); };
    await instance.up();
    assert(sql.length > 0);
    migrations.push({ name, path, sha256: hash, sql });
  }
  assert.equal(migrations.reduce((total, migration) => total + migration.sql.length, 0), 50);
  return migrations;
}

async function assertEmptyBanking(client: PoolClient): Promise<void> {
  const objects = (await client.query(`SELECT 'relation' AS kind,c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND starts_with(c.relname,'bank_')
    UNION ALL SELECT 'function',p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND starts_with(p.proname,'bank_')
    UNION ALL SELECT 'type',t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' AND starts_with(t.typname,'bank_')`)).rows;
  assert.equal(objects.length, 0, "Bootstrap requires an entirely absent Banking schema; partial/installed schema is never replayed");
  assert.equal((await client.query("SELECT 1 FROM mikro_orm_migrations WHERE name=ANY($1::text[])",
    [completionLegacyMigrations])).rowCount, 0, "Bootstrap migration tracking already exists; inspect instead of replaying");
}

async function snapshotToc(bytes: Buffer): Promise<string> {
  return new Promise((done, reject) => {
    const child = spawn("sg", ["docker", "-c", "docker exec -i sb_postgres pg_restore --list"],
      { env: cleanProcessEnv, stdio: ["pipe", "pipe", "ignore"] });
    const parts: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => parts.push(chunk));
    child.on("error", reject);
    child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") reject(error); });
    child.on("close", code => code === 0 ? done(Buffer.concat(parts).toString()) : reject(new Error("COMPLETION_SNAPSHOT_TOC_FAILED")));
    child.stdin.end(bytes);
  });
}

async function verifiedBootstrapSnapshot(client: PoolClient, baseline: Awaited<ReturnType<typeof completionPreflight>>) {
  const containerSystem = execFileSync("sg", ["docker", "-c",
    "docker exec sb_postgres psql -U postgres -d medusa -At -c 'SELECT system_identifier FROM pg_control_system()'"],
  { env: cleanProcessEnv, encoding: "utf8", timeout: 15000 }).trim();
  const hostSystem = String((await client.query("SELECT system_identifier::text AS id FROM pg_control_system()")).rows[0].id);
  assert.equal(containerSystem, hostSystem, "Docker snapshot must target the exact inspected PostgreSQL cluster");
  const metadataPath = snapshot.replace(/dump$/, "json");
  let bytes: Buffer;
  if (existsSync(snapshot)) {
    assert(existsSync(metadataPath), "Existing snapshot lacks verification metadata; inspect before retry");
    bytes = readFileSync(snapshot);
    const prior = JSON.parse(readFileSync(metadataPath, "utf8")) as { sha256: string; system_identifier: string;
      data: unknown; protected_data: unknown; migration_tracking: unknown };
    assert.equal(prior.sha256, sha256(bytes));
    assert.equal(prior.system_identifier, hostSystem);
    assert.deepEqual(prior.data, baseline.data, "Snapshot source rows changed; never reuse a stale snapshot");
    assert.deepEqual(prior.protected_data, baseline.protected_data);
    assert.deepEqual(prior.migration_tracking, baseline.migration_tracking);
  } else {
    bytes = execFileSync("sg", ["docker", "-c", "docker exec sb_postgres pg_dump -U postgres -d medusa -Fc --no-owner --no-acl"],
      { env: cleanProcessEnv, maxBuffer: 256 * 1024 * 1024, timeout: 120000 });
    assert(bytes.length > 1000, "Snapshot archive has no usable data");
    mkdirSync(resolve(snapshot, ".."), { recursive: true });
    writeFileSync(snapshot, bytes, { mode: 0o600, flag: "wx" });
  }
  const toc = await snapshotToc(bytes);
  for (const table of [...Object.keys(baseline.data), ...Object.keys(baseline.protected_data), "mikro_orm_migrations"]) {
    assert(toc.includes(` ${table} `), `Snapshot TOC is missing ${table}`);
  }
  assert.deepEqual(await completionTableFingerprints(client, baseline.schema.columns), baseline.data);
  assert.deepEqual(await fingerprints(client), baseline.protected_data, "Source rows changed while snapshot was taken");
  writeFileSync(snapshot.replace(/dump$/, "toc"), toc, { mode: 0o600 });
  if (!existsSync(metadataPath)) writeFileSync(metadataPath, JSON.stringify({ sha256: sha256(bytes), system_identifier: hostSystem,
    data: baseline.data, protected_data: baseline.protected_data, migration_tracking: baseline.migration_tracking,
    created_at: new Date().toISOString(), purpose: "Empty Banking schema bootstrap before V11-V13" }, null, 2), { mode: 0o600, flag: "wx" });
  return { path: snapshot, sha256: sha256(bytes), toc_sha256: sha256(toc) };
}

/** Not connected to the default verifier. Execute only after the narrow empty-schema delta is approved. */
export async function bootstrapCompletionPrerequisites(client: PoolClient) {
  requireBankingSandbox();
  const migrations = await completionBootstrapManifest();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  let baseline: Awaited<ReturnType<typeof completionPreflight>>;
  try {
    await assertEmptyBanking(client);
    baseline = await completionPreflight(client);
    await client.query("ROLLBACK");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  const archive = await verifiedBootstrapSnapshot(client, baseline);
  const existingNames = (await client.query("SELECT id,name,executed_at FROM mikro_orm_migrations ORDER BY id")).rows;
  assert.equal(existingNames.length, 296, "Approved bootstrap baseline is exactly 296 existing migration records");
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='60s'");
    await withReviewLock(client);
    await client.query("LOCK TABLE mikro_orm_migrations IN SHARE ROW EXCLUSIVE MODE");
    await assertEmptyBanking(client);
    assert.deepEqual(await completionTableFingerprints(client, baseline.migration_tracking.columns),
      baseline.migration_tracking.fingerprints, "Migration tracking changed after the verified snapshot");
    const sourceTables = [...new Set([...Object.keys(baseline.data), ...Object.keys(baseline.protected_data)])].sort();
    assert(sourceTables.every(table => /^[a-z_][a-z0-9_]*$/.test(table)));
    await client.query(`LOCK TABLE ${sourceTables.map(table => `public."${table}"`).join(",")} IN SHARE MODE`);
    assert.deepEqual(await completionTableFingerprints(client, baseline.schema.columns), baseline.data);
    assert.deepEqual(await fingerprints(client), baseline.protected_data);
    assert.deepEqual((await client.query("SELECT id,name,executed_at FROM mikro_orm_migrations ORDER BY id")).rows, existingNames);
    for (const migration of migrations) {
      for (const sql of migration.sql) await client.query(sql);
      await client.query("INSERT INTO mikro_orm_migrations(name) VALUES($1)", [migration.name]);
    }
    const tables = (await client.query<{ tablename: string }>(`SELECT tablename FROM pg_tables
      WHERE schemaname='public' AND starts_with(tablename,'bank_') ORDER BY tablename`)).rows.map(row => row.tablename);
    assert.deepEqual(tables, expectedTables, "Bootstrap creates exactly 23 approved Banking tables");
    const bankingData = await completionTableFingerprints(client, await completionColumns(client, tables));
    assert(Object.values(bankingData).every(table => table.count === "0"), "Bootstrap must never seed banking rows");
    const triggers = (await client.query(`SELECT tgname,tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[])
      AND NOT t.tgisinternal ORDER BY tgname`, [tables])).rows;
    assert.equal(triggers.length, 20);
    assert(triggers.every(trigger => trigger.tgenabled === "O"));
    const functions = (await client.query(`SELECT p.proname,pg_get_functiondef(p.oid) AS definition FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND starts_with(p.proname,'bank_') ORDER BY p.proname`)).rows;
    assert.equal(functions.length, 12);
    assert(functions.find(row => row.proname === "bank_receipt_check_consumption")?.definition.includes("NEW.opening_item_id IS NOT NULL"),
      "Final receipt consumption must retain V10 opening branch");
    assert.deepEqual(await completionTableFingerprints(client, baseline.schema.columns), baseline.data);
    assert.deepEqual(await fingerprints(client), baseline.protected_data);
    const records = (await client.query("SELECT id,name,executed_at FROM mikro_orm_migrations ORDER BY id")).rows;
    assert.deepEqual(records.filter(row => !completionLegacyMigrations.includes(row.name as string)), existingNames);
    assert.deepEqual(records.filter(row => completionLegacyMigrations.includes(row.name as string)).map(row => row.name).sort(),
      [...completionLegacyMigrations].sort());
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  const record = { scope: "empty-schema-bootstrap-delta", executed_at: new Date().toISOString(), archive,
    migrations: migrations.map(({ name, path, sha256: hash, sql }) => ({ name, path, sha256: hash, statement_count: sql.length })),
    table_count: 23, function_count: 12, trigger_count: 20, banking_rows: 0, tracking_added: 6 };
  writeFileSync(resolve(completionDirectory, `bootstrap-${Date.now()}.json`), JSON.stringify(record, null, 2), { mode: 0o600, flag: "wx" });
  return record;
}
