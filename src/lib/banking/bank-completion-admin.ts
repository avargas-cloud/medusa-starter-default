/** Sandbox-only prerequisite inspection and explicitly called three-row fixture; no top-level execution. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { createConnection } from "node:net";
import { logger } from "@medusajs/framework/logger";
import { EmailPassAuthService } from "@medusajs/auth-emailpass/dist/services/emailpass";
import { requireBankingSandbox } from "./security";

const tables = ["user", "auth_identity", "provider_identity", "pos_user"];
export const completionAdminIds = { user: "user_e2e_bank_completion_admin", auth_identity: "authid_e2e_bank_completion_admin",
  provider_identity: "provid_e2e_bank_completion_admin" } as const;
class CompletionEmailPass extends EmailPassAuthService {
  async passwordHash(password: string): Promise<string> { return this.hashPassword(password); }
}
export async function auditCompletionAdmin(client: PoolClient) {
  requireBankingSandbox();
  const columns = (await client.query(`SELECT table_name,column_name,data_type,is_nullable,column_default,ordinal_position
    FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[])
    ORDER BY table_name,ordinal_position`, [tables])).rows;
  const triggers = (await client.query(`SELECT c.relname AS table_name,t.tgname AS trigger_name,t.tgenabled AS enabled,
    pg_get_triggerdef(t.oid,true) AS trigger_definition,pg_get_functiondef(p.oid) AS function_definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_proc p ON p.oid=t.tgfoid WHERE n.nspname='public' AND c.relname=ANY($1::text[])
    AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`, [tables])).rows;
  const constraints = (await client.query(`SELECT c.relname AS table_name,con.conname AS name,
    pg_get_constraintdef(con.oid,true) AS definition FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[])
    ORDER BY c.relname,con.conname`, [tables])).rows;
  const indexes = (await client.query(`SELECT tablename,indexname,indexdef FROM pg_indexes
    WHERE schemaname='public' AND tablename=ANY($1::text[]) ORDER BY tablename,indexname`, [tables])).rows;
  const foreignKeys = (await client.query(`SELECT source.relname AS source_table,target.relname AS target_table,
    con.conname AS name,pg_get_constraintdef(con.oid,true) AS definition FROM pg_constraint con
    JOIN pg_class source ON source.oid=con.conrelid JOIN pg_class target ON target.oid=con.confrelid
    WHERE con.contype='f' AND (source.relname=ANY($1::text[]) OR target.relname=ANY($1::text[]))
    ORDER BY source.relname,target.relname,con.conname`, [tables])).rows;
  const counts: Record<string, { count: string; hash: string }> = {};
  for (const table of tables) {
    counts[table] = (await client.query<{ count: string; hash: string }>(`SELECT count(*)::text AS count,
      md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY to_jsonb(t)::text),'')) AS hash FROM public."${table}" t`)).rows[0]!;
  }
  const conflicts = (await client.query(`SELECT
    (SELECT count(*)::int FROM public."user" WHERE lower(email)=$1) AS users,
    (SELECT count(*)::int FROM provider_identity WHERE lower(entity_id)=$1) AS providers,
    (SELECT count(*)::int FROM pos_user WHERE lower(email)=$1) AS staff`, ["sandbox@test.com"])).rows[0];
  return { columns, triggers, constraints, indexes, foreignKeys, counts, conflicts };
}

async function foreignAdminHashes(client: PoolClient) {
  const result: Record<string, { count: string; hash: string }> = {};
  for (const table of tables) {
    const id = table === "pos_user" ? null : completionAdminIds[table as keyof typeof completionAdminIds];
    result[table] = (await client.query<{ count: string; hash: string }>(`SELECT count(*)::text AS count,
      md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY to_jsonb(t)::text),'')) AS hash
      FROM public."${table}" t WHERE $1::text IS NULL OR t.id<>$1::text`, [id])).rows[0]!;
  }
  return result;
}

/** Requires the separate +1 user/+1 auth_identity/+1 provider_identity delta; never called by preflight. */
export async function createCompletionAdmin(client: PoolClient, password: string) {
  requireBankingSandbox();
  assert(typeof password === "string" && password.length >= 8, "Explicit sandbox test credential required");
  const dump = resolve(__dirname, "../../../../sandbox-artifacts/snapshots/pre-bank-completion-v11-v13.dump");
  const tocPath = dump.replace(/dump$/, "toc"), metadataPath = dump.replace(/dump$/, "json");
  assert(existsSync(dump) && existsSync(tocPath) && existsSync(metadataPath), "Verified pre-bootstrap snapshot required");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { sha256: string };
  assert.equal(createHash("sha256").update(readFileSync(dump)).digest("hex"), metadata.sha256);
  const toc = readFileSync(tocPath, "utf8");
  for (const table of tables) assert(toc.includes(` ${table} `), `Snapshot lacks auth prerequisite ${table}`);
  const passwordHash = await new CompletionEmailPass({ logger }, {}).passwordHash(password);
  assert(typeof passwordHash === "string" && passwordHash.length > 0);
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('banking-completion-test-admin',7241))");
    await client.query('LOCK TABLE public."user",auth_identity,provider_identity IN SHARE ROW EXCLUSIVE MODE');
    await client.query("LOCK TABLE pos_user IN SHARE MODE");
    const audit = await auditCompletionAdmin(client);
    assert.deepEqual(audit.conflicts, { users: 0, providers: 0, staff: 0 }, "Existing identity is never updated, relinked or reused");
    assert.equal(audit.counts.user!.count, "13");
    assert.equal(audit.counts.auth_identity!.count, "140");
    assert.equal(audit.counts.provider_identity!.count, "50");
    assert.equal(audit.counts.pos_user!.count, "9");
    assert.deepEqual(audit.triggers.map(row => [row.table_name, row.trigger_name, row.enabled]),
      [["pos_user", "pos_user_email_lowercase", "O"], ["user", "user_email_lowercase", "O"]]);
    assert(audit.triggers.every(row => createHash("sha256").update(String(row.function_definition)).digest("hex")
      === "476069d64a831662466dde2e2df309eb1157cc99cf6deabf05523dea19d18469"), "Audited lowercase-only trigger function changed");
    assert.equal(audit.foreignKeys.length, 1, "Authentication FK closure changed");
    assert.equal(audit.foreignKeys[0]!.source_table, "provider_identity");
    assert.equal(audit.foreignKeys[0]!.target_table, "auth_identity");
    for (const [table, id] of Object.entries(completionAdminIds)) {
      assert.equal((await client.query(`SELECT 1 FROM public."${table}" WHERE id=$1`, [id])).rowCount, 0, "Owned admin ID collision");
    }
    const before = await foreignAdminHashes(client);
    await client.query(`INSERT INTO public."user"(id,email,first_name,last_name,metadata)
      VALUES($1,$2,'Sandbox','Banking Verification','{"fixture":"e2e_bank_completion_admin"}'::jsonb)`,
    [completionAdminIds.user, "sandbox@test.com"]);
    await client.query("INSERT INTO auth_identity(id,app_metadata) VALUES($1,jsonb_build_object('user_id',$2::text))",
      [completionAdminIds.auth_identity, completionAdminIds.user]);
    await client.query(`INSERT INTO provider_identity(id,entity_id,provider,auth_identity_id,provider_metadata)
      VALUES($1,$2,'emailpass',$3,jsonb_build_object('password',$4::text))`,
    [completionAdminIds.provider_identity, "sandbox@test.com", completionAdminIds.auth_identity, passwordHash]);
    assert.deepEqual(await foreignAdminHashes(client), before, "All existing auth/user/POS staff rows remain byte-identical");
    const after = await auditCompletionAdmin(client);
    for (const table of ["user", "auth_identity", "provider_identity"]) {
      assert.equal(Number(after.counts[table]!.count), Number(audit.counts[table]!.count) + 1);
    }
    assert.deepEqual(after.counts.pos_user, audit.counts.pos_user);
    assert.deepEqual(after.triggers, audit.triggers);
    assert.deepEqual(after.constraints, audit.constraints);
    assert.deepEqual(after.indexes, audit.indexes);
    const linkage = (await client.query(`SELECT u.id FROM public."user" u JOIN auth_identity a ON a.app_metadata->>'user_id'=u.id
      JOIN provider_identity p ON p.auth_identity_id=a.id WHERE u.id=$1 AND a.id=$2 AND p.id=$3
      AND u.email=$4 AND p.entity_id=$4 AND p.provider='emailpass' AND p.provider_metadata->>'password'=$5`,
    [completionAdminIds.user, completionAdminIds.auth_identity, completionAdminIds.provider_identity, "sandbox@test.com", passwordHash])).rows;
    assert.equal(linkage.length, 1);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  return { created: true, ids: completionAdminIds, existing_rows_preserved: true, pos_user_writes: 0 };
}

export async function completionInfrastructureHealth() {
  requireBankingSandbox();
  const redis = await new Promise<string>(done => {
    const socket = createConnection({ host: "127.0.0.1", port: 6399 });
    let reply = "";
    const finish = (result: string) => { socket.destroy(); done(result); };
    socket.setTimeout(3000, () => finish("unreachable"));
    socket.on("error", () => finish("unreachable"));
    socket.on("connect", () => socket.write("*1\r\n$4\r\nPING\r\n"));
    socket.on("data", bytes => {
      reply += bytes.toString();
      if (reply.includes("\r\n")) finish(reply.startsWith("+PONG\r\n") ? "healthy" : "unexpected_reply");
    });
  });
  const checks: Record<string, string> = { redis };
  for (const [name, url] of [["meili", "http://localhost:7799/health"],
    ["backend", "http://localhost:9099/health"], ["pos", "http://localhost:3099/login"]] as const) {
    try {
      const response = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(3000) });
      checks[name] = response.status === 200 ? "healthy" : `http_${response.status}`;
    } catch { checks[name] = "unreachable"; }
  }
  return checks;
}
