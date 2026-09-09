/**
 * Case 01 · Banks hub: accounts and feed (initial state).
 * Ensures the operator's base connection exists (Plaid Sandbox, user_custom, 2 movements) through the REAL routes,
 * syncs it, and reports exactly what /accounting/banks must show. Idempotent: a second run creates nothing.
 */
import assert from "node:assert/strict";
import { run, block, journalCount, record, safeCode, type Json } from "./_lib";
import { syncBank } from "../../../lib/banking/sync";

const CUSTOM = { override_accounts: [{ type: "depository", subtype: "checking", starting_balance: 1500, currency: "USD",
  meta: { name: "EPT Sandbox checking", mask: "0042" },
  transactions: [
    { date_transacted: "2026-09-01", date_posted: "2026-09-02", amount: 125.5, description: "EPT utilities test" },
    { date_transacted: "2026-09-02", date_posted: "2026-09-03", amount: -500, description: "EPT deposit test" },
  ] }] };

void run("case-01", async ({ api, pool }) => {
  const existing = await pool.query<{ id: string }>(`SELECT c.id FROM bank_connection c JOIN bank_account a ON a.connection_id=c.id
    WHERE a.name='EPT Sandbox checking' AND a.mask='0042' AND c.environment='sandbox' AND c.status<>'disconnected' AND c.deleted_at IS NULL LIMIT 1`);
  let connectionId = existing.rows[0]?.id;
  let created = false;
  if (!connectionId) {
    const link = await api.post("/admin/banking/link-token", {});
    assert(String(link.link_token).startsWith("link-sandbox-"), "link token must be sandbox");
    const response = await fetch("https://sandbox.plaid.com/sandbox/public_token/create", {
      method: "POST", headers: { "Content-Type": "application/json", "Plaid-Version": "2020-09-14" },
      body: JSON.stringify({ client_id: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SANDBOX_SECRET,
        institution_id: "ins_109508", initial_products: ["transactions"],
        options: { override_username: "user_custom", override_password: JSON.stringify(CUSTOM) } }),
      signal: AbortSignal.timeout(30_000),
    });
    const token = record(await response.json());
    assert(response.ok && typeof token?.public_token === "string", `PLAID_${safeCode(token?.error_code)}`);
    const connected = await api.post("/admin/banking/connections", { public_token: token.public_token });
    connectionId = String(connected.connection_id);
    const accounts = await pool.query<{ id: string }>("SELECT id FROM bank_account WHERE connection_id=$1", [connectionId]);
    assert.equal(accounts.rowCount, 1, "one custom account");
    await api.post(`/admin/banking/connections/${connectionId}/accounts`, { account_ids: accounts.rows.map(a => a.id) });
    created = true;
  }
  for (let attempt = 0; attempt < 24; attempt++) {
    await syncBank(connectionId, "manual");
    const row = (await pool.query<{ historical_sync_complete: boolean }>("SELECT historical_sync_complete FROM bank_connection WHERE id=$1", [connectionId])).rows[0];
    if (row?.historical_sync_complete) break;
    assert(attempt < 23, "HISTORY_STILL_PENDING");
    await new Promise(done => setTimeout(done, 5000));
  }

  const overview = await api.get("/admin/banking");
  const config = record(overview.config) ?? {};
  const account = (overview.accounts as Json[]).find(a => a.connection_id === connectionId);
  const connection = (overview.connections as Json[]).find(c => c.id === connectionId);
  assert(account && connection, "account and connection visible in overview");
  const feed = await api.get(`/admin/banking/transactions?account_id=${account.id}&limit=50&offset=0`);
  const rows = (feed.transactions as Json[]).map(t => ({ date: t.date, name: t.name, amount: t.amount, status: t.status, review_status: t.review_status }));
  const journal = await journalCount(pool);

  assert.equal(config.environment, "sandbox");
  assert.equal(config.enabled, true); assert.equal(config.control_enabled, true);
  assert.equal(account.name, "EPT Sandbox checking"); assert.equal(account.mask, "0042"); assert.equal(account.selected, true);
  assert.equal(feed.count, 2, "two movements in the feed");
  assert.deepEqual(rows.map(r => r.amount).sort(), ["-125.5", "500"], "bank signs: utilities is a debit, deposit is a credit");
  assert.equal(journal, 0, "no journal entries in the initial state");

  block("Qué hice", { connection_created_now: created, connection_id: connectionId, account_id: account.id,
    sync: "syncBank(manual) until historical_sync_complete", plaid: { institution: "ins_109508 First Platypus Bank", username: "user_custom", custom: CUSTOM } });
  block("Qué esperamos", { badge: config.environment, enabled: config.enabled, control_enabled: config.control_enabled,
    card: { name: account.name, mask: account.mask, current_balance: account.current_balance, available_balance: account.available_balance, currency: account.currency, setup_revision: account.setup_revision, review_start_date: account.review_start_date },
    connection: { institution: connection.institution_name, status: connection.status, history_complete: connection.history_complete, last_synced_at: connection.last_synced_at },
    feed: { count: feed.count, rows }, bank_journal_entry: journal });
  block("Mirá", `${"http://localhost:3099"}/accounting/banks`);
});
