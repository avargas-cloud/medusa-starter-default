/** Prepared integration harness. Run only after the banking sandbox snapshot/schema setup. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { PoolClient } from "pg";
import { getDbPool } from "../../api/utils/db-pool";
import { configureBankSandbox } from "../../lib/banking/sandbox-runtime";
import { encryptBankToken, sandboxTokenKey } from "../../lib/banking/security";
import { applyFeedBatch, type FeedBatch, type FeedTransaction } from "../../lib/banking/sync-store";
import { saveAccounts } from "../../lib/banking/accounts";
import { disconnectBank, mapBankAccount, refreshBank, selectBankAccounts } from "../../lib/banking/actions";
import { bankingOverview, bankingTransactions } from "../../lib/banking/views";
import { drainBankWebhooks } from "../../lib/banking/webhooks";
import { syncBank } from "../../lib/banking/sync";
import { transaction } from "../../lib/banking/store";

const connections = ["bconn_e2e_bank_feed_one", "bconn_e2e_bank_feed_two"] as const;
const items = ["item_e2e_bank_feed_one", "item_e2e_bank_feed_two"];
const financialTables = ["customer_payment", "payment_application", "pos_invoice", "pos_credit_memo", "vendor_bill", "qb_account", "treasury_distribution_log"];
let assertions = 0;
function equal(actual: unknown, expected: unknown, label: string) { assert.deepEqual(actual, expected, label); assertions++; }
function truth(value: unknown, label: string) { assert.ok(value, label); assertions++; }
async function rejects(action: () => Promise<unknown>, code: string) {
  await assert.rejects(action, (error: unknown) => error instanceof Error && "code" in error && error.code === code);
  assertions++;
}
function account(id: string, persistent: string, currency = "USD") {
  return { account_id: id, persistent_account_id: persistent, name: `E2E ${id}`, type: "depository", subtype: "checking",
    mask: "0000", balances: { current: "1234567890.123456789", available: "10.00", iso_currency_code: currency } };
}
function tx(id: string, accountId: string, amount: string, pending = false, predecessor: string | null = null): FeedTransaction {
  return { transaction_id: id, account_id: accountId, amount, pending, pending_transaction_id: predecessor,
    currency: accountId === "eur" ? "EUR" : "USD", unofficial_currency: null, date: "2026-09-08",
    authorized_date: null, name: `Fixture ${id}`, merchant_name: null,
    source: { transaction_id: id, account_id: accountId, amount, pending, pending_transaction_id: predecessor } };
}
const batch = (overrides: Partial<FeedBatch> = {}): FeedBatch => ({ added: [], modified: [], removed: [],
  cursor: "fixture-complete", initialComplete: true, historicalComplete: true, ...overrides });

async function fingerprints(client: PoolClient) {
  const result: Record<string, unknown> = {};
  for (const table of financialTables) {
    // Table names are a fixed local allowlist; only fingerprints leave Postgres.
    result[table] = (await client.query(`SELECT count(*)::text AS count,
      md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY id), '')) AS digest FROM ${table} t`)).rows[0];
  }
  return result;
}
async function cleanup(client: PoolClient) {
  await transaction(client, async () => {
    await client.query("DELETE FROM bank_webhook_event WHERE connection_id=ANY($1::text[]) OR payload->>'item_id'=ANY($2::text[])", [connections, items]);
    for (const table of ["bank_sync_run", "bank_transaction", "bank_account"]) {
      await client.query(`DELETE FROM ${table} WHERE connection_id=ANY($1::text[])`, [connections]);
    }
    await client.query("DELETE FROM bank_connection WHERE id=ANY($1::text[])", [connections]);
  });
}

async function main() {
  configureBankSandbox();
  try { execFileSync("tmux", ["kill-session", "-t", "sb-banking"], { stdio: "ignore" }); } catch { /* absent worker is safe */ }
  const pool = getDbPool();
  const client = await pool.connect();
  const originalFetch = globalThis.fetch;
  let ownedLock = false;
  let before: Record<string, unknown> | undefined;
  let providerAccounts = [account("usd", "persistent-usd"), account("eur", "persistent-eur", "EUR")];
  const calls: string[] = [];
  try {
    const locked = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtextextended('e2e-bank-feed-fixtures',7241)) AS locked");
    ownedLock = locked.rows[0]?.locked === true;
    truth(ownedLock, "Another fixture run must not be disturbed");
    before = await fingerprints(client);
    await cleanup(client); // Recover ONLY this harness's fixtures after an interrupted run.
    const foreignInbox = await client.query("SELECT id FROM bank_webhook_event WHERE status IN ('pending','failed') LIMIT 1");
    truth(!foreignInbox.rowCount, "Refuse to drain another session's pending webhook inbox");
    const sizes = await client.query<{ accounts: string; transactions: string; runs: string }>(`SELECT
      (SELECT count(*) FROM bank_account)::text AS accounts, (SELECT count(*) FROM bank_transaction)::text AS transactions,
      (SELECT count(*) FROM bank_sync_run)::text AS runs`);
    const size = sizes.rows[0]!;
    truth(Number(size.accounts) <= 7 && Number(size.transactions) <= 1900 && Number(size.runs) <= 90, "Leave room within existing sandbox caps");
    const key = sandboxTokenKey();
    for (const [index, id] of connections.entries()) {
      await client.query(`INSERT INTO bank_connection(id,provider,environment,provider_item_id,access_token_encrypted,status)
        VALUES($1,'plaid','sandbox',$2,$3,'awaiting_selection')`, [id, items[index], encryptBankToken(`fixture-token-${index}`, id, key)]);
    }
    await transaction(client, () => saveAccounts(client, connections[0], providerAccounts));
    await transaction(client, () => saveAccounts(client, connections[1], [account("other", "persistent-other")]));
    const rows = (await client.query<{ id: string; provider_account_id: string }>(
      "SELECT id,provider_account_id FROM bank_account WHERE connection_id=ANY($1::text[])", [connections])).rows;
    const usd = rows.find((row) => row.provider_account_id === "usd")!.id;
    const eur = rows.find((row) => row.provider_account_id === "eur")!.id;
    const other = rows.find((row) => row.provider_account_id === "other")!.id;
    await client.query("UPDATE bank_account SET is_selected=true WHERE id=$1", [usd]);

    const first = batch({ added: [tx("cash", "usd", "123.4500"), tx("pending", "usd", "25.00", true), tx("euro", "eur", "-5.0100")],
      cursor: "fixture-early", initialComplete: false, historicalComplete: false });
    equal(await transaction(client, () => applyFeedBatch(client, connections[0], first)), { added: 3, modified: 0, removed: 0 }, "First ingestion");
    const early = (await client.query("SELECT cursor,initial_sync_complete,last_successful_sync_at FROM bank_connection WHERE id=$1", [connections[0]])).rows[0];
    equal(early, { cursor: "fixture-early", initial_sync_complete: false, last_successful_sync_at: null }, "Early feed cannot claim success");
    equal((await client.query("SELECT count(*)::int AS count FROM bank_transaction WHERE account_id=$1", [eur])).rows[0]?.count, 1, "Deselected account still ingested");
    const second = batch({ added: [tx("posted", "usd", "24.00", false, "pending")], modified: [tx("cash", "usd", "123.4600")], removed: [{ transaction_id: "cash", account_id: "usd" }] });
    equal(await transaction(client, () => applyFeedBatch(client, connections[0], second)), { added: 1, modified: 1, removed: 2 }, "Modify/remove and pending replacement");
    const evidence = async () => (await client.query(`SELECT id,provider_transaction_id,amount,status,source_revisions,removed_at
      FROM bank_transaction WHERE connection_id=$1 ORDER BY provider_transaction_id`, [connections[0]])).rows;
    const snapshot = await evidence();
    equal(snapshot.find((row) => row.provider_transaction_id === "cash")?.source_revisions.length, 2, "Modified and removed source snapshots retained");
    equal(snapshot.find((row) => row.provider_transaction_id === "pending")?.status, "removed", "Pending predecessor replaced");
    equal(await transaction(client, () => applyFeedBatch(client, connections[0], second)), { added: 0, modified: 0, removed: 0 }, "Replay is a no-op");
    equal(await evidence(), snapshot, "Replay preserves IDs, revision count, amount and removed timestamp");
    await rejects(() => transaction(client, () => applyFeedBatch(client, connections[0], batch({
      added: [tx("must-rollback", "usd", "1.00"), tx("unknown", "unknown-account", "1.00")], cursor: "must-not-commit",
    }))), "BANKING_ACCOUNT_MISSING");
    equal(await evidence(), snapshot, "An invalid later row rolls back the earlier insertion");
    equal((await client.query("SELECT cursor FROM bank_connection WHERE id=$1", [connections[0]])).rows[0]?.cursor, "fixture-complete", "Failed batch cannot advance cursor");
    await rejects(() => transaction(client, () => applyFeedBatch(client, connections[0], batch({ added: [tx("cross", "other", "1.00")] }))), "BANKING_ACCOUNT_MISSING");

    const page1 = await bankingTransactions({ account_id: usd, offset: 0, limit: 2 });
    const page2 = await bankingTransactions({ account_id: usd, offset: 2, limit: 2 });
    equal([page1.count, page2.count, page1.transactions.length, page2.transactions.length], [3, 3, 2, 1], "SQL count/page share the full set");
    equal(new Set([...page1.transactions, ...page2.transactions].map((row) => row.id)).size, 3, "Stable pages do not overlap");
    equal((await bankingTransactions({ account_id: usd, offset: 999, limit: 2 })).count, 3, "Empty page retains count");
    equal((await bankingTransactions({ account_id: usd, status: "posted", offset: 0, limit: 5 })).transactions[0]?.amount, "-24.00", "UI negates provider debit as exact decimal text");
    equal((await bankingTransactions({ account_id: eur, offset: 0, limit: 5 })).transactions[0]?.currency, "EUR", "Currency remains per transaction");
    await rejects(() => bankingTransactions({ account_id: "not-our-account", offset: 0, limit: 5 }), "BANKING_ACCOUNT_NOT_FOUND");
    const overview = await bankingOverview(true);
    truth(!JSON.stringify(overview).includes("fixture-token") && !JSON.stringify(overview).includes("access_token_encrypted"), "Overview does not expose token fields");
    equal(overview.accounts.find((row) => row.id === usd)?.current_balance, "1234567890.123456789", "Balance keeps exact decimal text");
    const reversedOrder = batch({ added: [tx("posted-first", "eur", "2.50", false, "pending-late"), tx("pending-late", "eur", "3.00", true)] });
    equal(await transaction(client, () => applyFeedBatch(client, connections[0], reversedOrder)), { added: 2, modified: 0, removed: 1 }, "Posted preceding pending still replaces it");
    const reverseSnapshot = await evidence();
    equal(await transaction(client, () => applyFeedBatch(client, connections[0], reversedOrder)), { added: 0, modified: 0, removed: 0 }, "Reversed-order replay is idempotent");
    equal(await evidence(), reverseSnapshot, "Late pending replay cannot create another revision");

    providerAccounts = [account("usd-rebound", "persistent-usd")];
    await transaction(client, () => saveAccounts(client, connections[0], providerAccounts));
    const rebound = (await client.query("SELECT id,is_selected,provider_account_id FROM bank_account WHERE id=$1", [usd])).rows[0];
    equal(rebound, { id: usd, is_selected: true, provider_account_id: "usd-rebound" }, "Persistent ID retains selection and internal identity");
    equal((await client.query("SELECT is_active FROM bank_account WHERE id=$1", [eur])).rows[0]?.is_active, false, "Missing account becomes inactive without deleting evidence");
    await rejects(() => transaction(client, () => saveAccounts(client, connections[1], [account("duplicate", "persistent-usd")])), "BANKING_DUPLICATE_CONNECTION");
    equal((await client.query("SELECT count(*)::int AS count FROM bank_account WHERE connection_id=ANY($1::text[])", [connections])).rows[0]?.count, 3, "Duplicate attempt leaves exactly three fixtures");
    const qb = (await client.query<{ qb_list_id: string }>(`SELECT qb_list_id FROM qb_account q WHERE account_type='Bank'
      AND is_active AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM bank_account a WHERE a.qb_list_id=q.qb_list_id AND a.is_active AND a.deleted_at IS NULL)
      ORDER BY qb_list_id LIMIT 1`)).rows[0];
    truth(qb, "A real cached unmapped QB Bank account is required as read-only control");
    const mappings = await Promise.allSettled([mapBankAccount(usd, qb!.qb_list_id), mapBankAccount(other, qb!.qb_list_id)]);
    equal(mappings.filter((row) => row.status === "fulfilled").length, 1, "Concurrent mapping has one winner");
    truth(mappings.some((row) => row.status === "rejected" && row.reason?.code === "BANKING_QB_ACCOUNT_ALREADY_MAPPED"), "Duplicate mapping loses with explicit conflict");
    const winner = mappings[0]?.status === "fulfilled" ? usd : other;
    const loser = winner === usd ? other : usd;
    const winnerConnection = winner === usd ? connections[0] : connections[1];
    const winnerProviderAccounts = winner === usd ? providerAccounts : [account("other", "persistent-other")];
    await transaction(client, () => saveAccounts(client, winnerConnection, []));
    await mapBankAccount(loser, qb!.qb_list_id);
    await rejects(() => transaction(client, () => saveAccounts(client, winnerConnection, winnerProviderAccounts)), "23505");
    equal((await client.query("SELECT is_active FROM bank_account WHERE id=$1", [winner])).rows[0]?.is_active, false, "Conflicting reactivation rolls back completely");
    equal((await client.query("SELECT qb_list_id FROM bank_account WHERE id=$1", [loser])).rows[0]?.qb_list_id, qb!.qb_list_id, "Reactivation cannot displace the current mapping");
    await mapBankAccount(loser, null);
    await transaction(client, () => saveAccounts(client, winnerConnection, winnerProviderAccounts));

    process.env.PLAID_CLIENT_ID = "fixture-client";
    process.env.PLAID_SANDBOX_SECRET = "fixture-secret";
    let providerUpdate = "2000-01-01T00:00:00Z";
    let fastRefresh = false;
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(url.origin, "https://sandbox.plaid.com", "No external fetch is permitted");
      assert.equal(init?.method, "POST");
      calls.push(url.pathname);
      if (url.pathname === "/transactions/refresh" && fastRefresh) {
        providerUpdate = new Date().toISOString();
        await new Promise(done => setTimeout(done, 30));
      }
      const responses: Record<string, unknown> = {
        "/accounts/get": { accounts: providerAccounts }, "/item/get": { item: {}, status: { transactions: { last_successful_update: providerUpdate } } },
        "/transactions/sync": { added: [], modified: [], removed: [], next_cursor: "fixture-sync", has_more: false, transactions_update_status: "HISTORICAL_UPDATE_COMPLETE" },
        "/transactions/refresh": {}, "/item/remove": {},
      };
      assert.ok(url.pathname in responses, "Unexpected provider endpoint");
      return new Response(JSON.stringify(responses[url.pathname]), { status: 200 });
    };
    equal((await selectBankAccounts(connections[0], [usd])).status, "synced", "Selection executes the real sync pipeline against fixture provider");
    equal((await refreshBank(connections[0])).status, "refresh_requested", "Refresh acceptance is not completion");
    await rejects(() => refreshBank(connections[0]), "BANKING_REFRESH_COOLDOWN");
    await syncBank(connections[0], "manual");
    truth((await bankingOverview(true)).connections.find((row) => row.id === connections[0])?.refresh_request_pending, "Provider data older than refresh cannot acknowledge it");
    truth(calls.includes("/transactions/sync") && calls.includes("/transactions/refresh"), "Positive controls prove provider mocks were exercised");
    await client.query("UPDATE bank_connection SET refresh_requested_at=NULL WHERE id=$1", [connections[0]]);
    fastRefresh = true;
    await refreshBank(connections[0]);
    await syncBank(connections[0], "manual");
    equal((await bankingOverview(true)).connections.find(row => row.id === connections[0])?.refresh_request_pending,
      false, "A refresh completed before its HTTP response must not remain pending forever");
    await client.query("UPDATE bank_connection SET sync_requested_at='2026-09-08T12:34:56.123456Z'::timestamptz WHERE id=$1", [connections[0]]);
    await syncBank(connections[0], "manual");
    equal((await client.query("SELECT sync_requested_at FROM bank_connection WHERE id=$1", [connections[0]])).rows[0]?.sync_requested_at,
      null, "Microsecond precision request marker is consumed, avoiding an endless recovery loop");

    async function event(code: string) {
      const id = `bwevt_e2e_${randomUUID()}`;
      await client.query(`INSERT INTO bank_webhook_event(id,provider,environment,connection_id,event_digest,event_type,payload,received_at)
        VALUES($1,'plaid','sandbox',$2,$1,$3,$4::jsonb,now())`,
      [id, connections[0], `ITEM:${code}`, JSON.stringify({ item_id: items[0], webhook_type: "ITEM", webhook_code: code, environment: "sandbox" })]);
      return id;
    }
    const revoked = await event("USER_PERMISSION_REVOKED");
    await client.query("SELECT pg_advisory_lock(hashtextextended($1::text,7241))", [connections[0]]);
    try {
      await drainBankWebhooks();
      equal((await client.query("SELECT status,attempts FROM bank_webhook_event WHERE id=$1", [revoked])).rows[0], { status: "pending", attempts: 0 }, "Busy connection leaves webhook durable without burning attempts");
    } finally { await client.query("SELECT pg_advisory_unlock(hashtextextended($1::text,7241))", [connections[0]]); }
    await drainBankWebhooks();
    equal((await client.query("SELECT status FROM bank_connection WHERE id=$1", [connections[0]])).rows[0]?.status, "reauth_required", "Revocation requires renewed consent");
    await event("LOGIN_REPAIRED");
    await drainBankWebhooks();
    equal((await client.query("SELECT status,last_error_code FROM bank_connection WHERE id=$1", [connections[0]])).rows[0], { status: "active", last_error_code: null }, "Repaired login restores a selected active account");
    await disconnectBank(connections[0]);
    await event("LOGIN_REPAIRED");
    await drainBankWebhooks();
    equal((await client.query("SELECT status,access_token_encrypted FROM bank_connection WHERE id=$1", [connections[0]])).rows[0], { status: "disconnected", access_token_encrypted: null }, "Late webhook cannot revive a disconnected token");
  } finally {
    globalThis.fetch = originalFetch;
    try {
      if (ownedLock) {
        await cleanup(client);
        equal((await client.query("SELECT count(*)::int AS count FROM bank_connection WHERE id=ANY($1::text[])", [connections])).rows[0]?.count, 0, "Fixture cleanup completed");
        if (before) equal(await fingerprints(client), before, "All seven financial table fingerprints unchanged");
        await client.query("SELECT pg_advisory_unlock(hashtextextended('e2e-bank-feed-fixtures',7241))");
      }
    } finally { client.release(); await pool.end(); }
  }
  console.log(`PASS banking integration: ${assertions} assertions; fixtures removed; financial fingerprints unchanged`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "BANKING_E2E_FAILED");
  process.exitCode = 1;
});
