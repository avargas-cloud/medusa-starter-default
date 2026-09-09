/** Approved V11-V13 sandbox migration runner. No implicit execution. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { PoolClient } from "pg";

import { Migration20260909180000 } from "../../modules/banking/migrations/Migration20260909180000";
import { Migration20260909190000 } from "../../modules/banking/migrations/Migration20260909190000";
import { Migration20260909200000 } from "../../modules/banking/migrations/Migration20260909200000";
import { fingerprints } from "../../scripts/tests/bank-accounting-fixtures";
import {
  completionDirectory,
  completionPreflight,
  completionTableFingerprints,
} from "../../scripts/tests/bank-completion-fixtures";

import { applyCompletionGuardCorrection } from "./completion-sandbox-guards";
import { withReviewLock } from "./review-common";
import { requireBankingSandbox } from "./security";
const hash = (b: Buffer | string): string =>
  createHash("sha256").update(b).digest("hex");
const cleanEnv = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
export async function migrateCompletionSandbox(
  client: PoolClient
): Promise<{ file: string; sha256: string }> {
  requireBankingSandbox();
  const sql: Array<{ name: string; statements: string[] }> = [];
  for (const C of [
    Migration20260909180000,
    Migration20260909190000,
    Migration20260909200000,
  ]) {
    const migration = Object.create(C.prototype) as InstanceType<typeof C>,
      statements: string[] = [];
    migration.addSql = (s) => {
      assert.equal(typeof s, "string");
      statements.push(s as string);
    };
    await migration.up();
    sql.push({ name: C.name, statements });
  }
  const manifest = sql.map((m) => ({
    name: m.name,
    sha256: hash(m.statements.join("\n")),
  }));
  const receiptFile = `${completionDirectory}/migrations-applied.json`;
  const applied = (
    await client.query(
      "SELECT name FROM mikro_orm_migrations WHERE name=ANY($1::text[]) ORDER BY name",
      [manifest.map((m) => m.name)]
    )
  ).rows;
  if (applied.length) {
    assert.equal(applied.length, 3, "Partial migration state needs inspection");
    assert(
      existsSync(receiptFile),
      "Existing migrations need their verified execution receipt"
    );
    const receipt = JSON.parse(readFileSync(receiptFile, "utf8")) as {
      manifest: unknown;
      snapshot: { file: string; sha256: string };
    };
    assert.equal(
      hash(readFileSync(receipt.snapshot.file)),
      receipt.snapshot.sha256
    );
    if (JSON.stringify(receipt.manifest) !== JSON.stringify(manifest))
      await applyCompletionGuardCorrection(client, manifest);
    return receipt.snapshot;
  }
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const baseline = await completionPreflight(client);
  await client.query("ROLLBACK");
  assert(
    baseline.absent_allowed_tables.includes("bank_movement") &&
      baseline.absent_allowed_tables.includes("bank_statement")
  );
  const system = String(
    (
      await client.query(
        "SELECT system_identifier::text AS id FROM pg_control_system()"
      )
    ).rows[0].id
  );
  const container = execFileSync(
    "sg",
    [
      "docker",
      "-c",
      "docker exec sb_postgres psql -U postgres -d medusa -At -c 'SELECT system_identifier FROM pg_control_system()'",
    ],
    { env: cleanEnv, encoding: "utf8" }
  ).trim();
  assert.equal(system, container);
  const bytes = execFileSync(
    "sg",
    [
      "docker",
      "-c",
      "docker exec sb_postgres pg_dump -U postgres -d medusa -Fc --no-owner --no-acl",
    ],
    { env: cleanEnv, maxBuffer: 256 * 1024 * 1024, timeout: 120000 }
  );
  assert(bytes.length > 1000 && bytes.subarray(0, 5).toString() === "PGDMP");
  const file = `${completionDirectory}/pre-new-migrations-${Date.now()}.dump`;
  writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
  const toc = await new Promise<string>((done, reject) => {
    const child = spawn(
      "sg",
      ["docker", "-c", "docker exec -i sb_postgres pg_restore --list"],
      { env: cleanEnv, stdio: ["pipe", "pipe", "ignore"] }
    );
    const parts: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => parts.push(b));
    child.on("error", reject);
    child.stdin.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code !== "EPIPE") reject(e);
    });
    child.on("close", (code) =>
      code === 0
        ? done(Buffer.concat(parts).toString())
        : reject(new Error("SNAPSHOT_TOC_FAILED"))
    );
    child.stdin.end(bytes);
  });
  for (const table of [
    ...Object.keys(baseline.data),
    ...Object.keys(baseline.protected_data),
    "mikro_orm_migrations",
  ])
    assert(toc.includes(` ${table} `));
  writeFileSync(file + ".toc", toc, { mode: 0o600, flag: "wx" });
  const snapshot = { file, sha256: hash(bytes) };
  writeFileSync(
    file + ".json",
    JSON.stringify({ snapshot, system, baseline }, null, 2),
    { mode: 0o600, flag: "wx" }
  );
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='60s'");
    await withReviewLock(client);
    await client.query(
      "LOCK TABLE mikro_orm_migrations IN SHARE ROW EXCLUSIVE MODE"
    );
    assert.deepEqual(
      await completionTableFingerprints(
        client,
        baseline.migration_tracking.columns
      ),
      baseline.migration_tracking.fingerprints
    );
    assert.deepEqual(
      await completionTableFingerprints(client, baseline.schema.columns),
      baseline.data
    );
    assert.deepEqual(await fingerprints(client), baseline.protected_data);
    for (const m of sql) {
      for (const statement of m.statements) await client.query(statement);
      await client.query("INSERT INTO mikro_orm_migrations(name) VALUES($1)", [
        m.name,
      ]);
    }
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    assert.deepEqual(
      await completionTableFingerprints(client, baseline.schema.columns),
      baseline.data
    );
    assert.deepEqual(await fingerprints(client), baseline.protected_data);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
  writeFileSync(
    receiptFile,
    JSON.stringify(
      { manifest, snapshot, executed_at: new Date().toISOString() },
      null,
      2
    ),
    { mode: 0o600, flag: "wx" }
  );
  // eslint-disable-next-line no-console -- resultado PASS del harness de migraciones sandbox, diagnóstico deliberado para quien corre el runner
  console.log(
    "PASS V11-V13 migrations: three tracking records, existing row fingerprints unchanged, snapshot TOC verified"
  );
  return snapshot;
}
