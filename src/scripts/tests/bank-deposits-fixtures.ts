/** Owned banking fixtures only. Financial documents remain read-only. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { transaction } from "../../lib/banking/store";
import { withReviewLock } from "../../lib/banking/review-common";

export const fixtureConnection = "bconn_e2e_deposits_http";
export const fixtureAccount = "bacc_e2e_deposits_http";
export const fixtureDay = "2026-09-08";
export const fixtureReference = "EPT-DEPOSIT-HTTP";
export const financeTables = ["customer_payment", "payment_application", "pos_invoice", "pos_credit_memo",
  "vendor_bill", "qb_account", "treasury_distribution_log", "qb_order_pipeline"] as const;
export async function financialFingerprint(client: PoolClient) {
  const result: Record<string, unknown> = {};
  for (const table of financeTables) result[table] = (await client.query(`SELECT count(*)::text AS count,
    md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY id),'')) AS hash FROM ${table} t`)).rows[0];
  return result;
}

export async function verifiedDepositSnapshot() {
  const file = resolve(__dirname, "../../../../sandbox-artifacts/snapshots/pre-bank-deposits-v7.dump");
  if (!existsSync(file)) {
    const bytes = execFileSync("sg", ["docker", "-c", "docker exec sb_postgres pg_dump -U postgres -d medusa -Fc"], { maxBuffer: 256 * 1024 * 1024 });
    assert(bytes.length > 1000, "Snapshot archive is not empty");
    writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
  }
  const toc = await new Promise<string>((done, reject) => {
    const child = spawn("sg", ["docker", "-c", "docker exec -i sb_postgres pg_restore --list"], { stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = []; child.stdout.on("data", chunk => chunks.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") reject(error); });
    child.on("close", code => code === 0 ? done(Buffer.concat(chunks).toString()) : reject(new Error("SNAPSHOT_TOC_FAILED")));
    child.stdin.end(readFileSync(file));
  });
  assert(toc.includes("bank_transaction") && toc.includes("customer_payment"), "Snapshot covers banking and financial source tables");
  console.log("PASS verified pre-bank-deposits-v7 snapshot archive");
}

export async function cleanDepositFixtures(client: PoolClient) {
  await transaction(client, async () => {
    await withReviewLock(client);
    const ownedDay = (await client.query("SELECT 1 FROM bank_day_close WHERE day=$1 AND (snapshot::text LIKE $2 OR history::text LIKE $2)", [fixtureDay, `%${fixtureAccount}%`])).rowCount;
    if (ownedDay) {
      await client.query("DELETE FROM bank_review_event WHERE entity_type IN ('day','command') AND entity_id=$1", [fixtureDay]);
      await client.query("DELETE FROM bank_day_close WHERE day=$1", [fixtureDay]);
    }
    await client.query(`DELETE FROM bank_review_event WHERE transaction_id IN(SELECT id FROM bank_transaction WHERE connection_id=$1)
      OR entity_id IN(SELECT id FROM bank_deposit WHERE account_id=$2) OR entity_id=$2
      OR result->'deposit'->>'account_id'=$2 OR entity_id='btx_e2e_deposits_http_match'`, [fixtureConnection, fixtureAccount]);
    for (const table of ["bank_review_attachment", "bank_transaction_review"]) await client.query(
      `DELETE FROM ${table} WHERE transaction_id IN(SELECT id FROM bank_transaction WHERE connection_id=$1)`, [fixtureConnection]);
    await client.query("DELETE FROM bank_deposit_line WHERE deposit_id IN(SELECT id FROM bank_deposit WHERE account_id=$1)", [fixtureAccount]);
    await client.query("DELETE FROM bank_deposit WHERE account_id=$1", [fixtureAccount]);
    await client.query("DELETE FROM bank_review_rule WHERE account_id=$1", [fixtureAccount]);
    for (const table of ["bank_webhook_event", "bank_sync_run", "bank_transaction", "bank_account"]) {
      await client.query(`DELETE FROM ${table} WHERE connection_id=$1`, [fixtureConnection]);
    }
    await client.query("DELETE FROM bank_connection WHERE id=$1", [fixtureConnection]);
  });
}

export type TemporarySetup = { id: string; review_start_date: string | null; setup_revision: number };
export async function deferCompanionFixture(client: PoolClient): Promise<TemporarySetup | undefined> {
  return transaction(client, async () => {
    await withReviewLock(client);
    const result = await client.query<TemporarySetup>("SELECT id,review_start_date,setup_revision FROM bank_account WHERE name='EPT Sandbox checking' AND deleted_at IS NULL FOR UPDATE");
    assert(result.rows.length <= 1, "Only the known companion sandbox account may be adjusted");
    const row = result.rows[0];
    if (row) await client.query("UPDATE bank_account SET review_start_date='2026-09-09',setup_revision=setup_revision+1 WHERE id=$1", [row.id]);
    return row;
  });
}
export async function restoreCompanionFixture(client: PoolClient, row: TemporarySetup) {
  await transaction(client, async () => {
    await withReviewLock(client);
    const restored = await client.query(`UPDATE bank_account SET review_start_date=$2,setup_revision=$3
      WHERE id=$1 AND setup_revision=$4 AND review_start_date='2026-09-09'`, [row.id, row.review_start_date, row.setup_revision, row.setup_revision + 1]);
    assert.equal(restored.rowCount, 1, "Restore only unchanged temporary companion setup");
  });
}

export async function seedDepositAccount(client: PoolClient) {
  await transaction(client, async () => {
    await withReviewLock(client);
    const caps = (await client.query(`SELECT (SELECT count(*) FROM bank_connection)::int AS connections,
      (SELECT count(*) FROM bank_account)::int AS accounts`)).rows[0];
    assert(caps.connections < 3 && caps.accounts < 10, "Bank fixtures respect existing caps");
    // No access token: the worker cannot sync this synthetic source even with active test status.
    await client.query(`INSERT INTO bank_connection(id,provider,environment,provider_item_id,status,initial_sync_complete,historical_sync_complete,last_successful_sync_at)
      VALUES($1,'plaid','sandbox',$1,'active',true,true,now())`, [fixtureConnection]);
    await client.query(`INSERT INTO bank_account(id,connection_id,provider_account_id,name,type,currency,is_selected,
      review_start_date,opening_bank_balance,opening_balance_date,opening_reference,setup_revision)
      VALUES($1,$2,$1,'EPT Deposit verification','depository','USD',true,'2026-08-01','0','2026-07-31','Synthetic opening only',1)`, [fixtureAccount, fixtureConnection]);
  });
}

export async function seedDepositMovement(client: PoolClient, id: string, majorAmount: string) {
  await transaction(client, async () => {
    await withReviewLock(client);
    assert((await client.query("SELECT count(*)::int AS n FROM bank_transaction")).rows[0].n < 2000, "Transaction cap");
    await client.query(`INSERT INTO bank_transaction(id,connection_id,account_id,provider_transaction_id,amount,currency,status,
      transaction_date,name,source_data,first_seen_at,last_seen_at) VALUES($1,$2,$3,$1,-$4::numeric,'USD','posted',$5,
      'EPT grouped bank deposit','{}'::jsonb,now(),now())`, [id, fixtureConnection, fixtureAccount, majorAmount, fixtureDay]);
  });
}
