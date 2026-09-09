import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { configureBankSandbox } from "../../lib/banking/sandbox-runtime";
import { getDbPool } from "../../api/utils/db-pool";
import { syncBank } from "../../lib/banking/sync";
import { decryptBankToken, sandboxTokenKey } from "../../lib/banking/security";
import { plaidRequest, object } from "../../lib/banking/plaid";

const BANKS = ["Wells Fargo", "Chase", "Regions", "TD Bank", "American Express", "PayPal"];
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}
function safeCode(value: unknown): string {
  return typeof value === "string" && /^[A-Z0-9_]{1,80}$/.test(value) ? value : "NETWORK_OR_PROVIDER_ERROR";
}
function publicUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    url.search = ""; url.hash = "";
    return url.toString();
  } catch { return null; }
}
async function main() {
  if (process.argv.length === 3 && ["--provider", "--persistence"].includes(process.argv[2] || "")) return provider(process.argv[2] === "--persistence");
  if (process.argv.length !== 3 || process.argv[2] !== "--institutions") throw new Error();
  const env = parse(readFileSync(resolve(__dirname, "../../../.env")));
  const clientId = env.PLAID_CLIENT_ID?.trim();
  const secret = env.PLAID_SANDBOX_SECRET?.trim();
  if (!clientId || !secret) throw new Error();
  const results = await Promise.all(BANKS.map(async (query) => {
    try {
      const response = await fetch("https://sandbox.plaid.com/institutions/search", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, secret, query,
          products: ["transactions"], country_codes: ["US"],
          options: { include_optional_metadata: true } }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = record(await response.json() as unknown);
      if (!response.ok || !body || !Array.isArray(body.institutions)) {
        return { query, status: response.status, error_code: safeCode(body?.error_code) };
      }
      return { query, status: response.status, institutions: body.institutions.map((value: unknown) => {
        const institution = record(value);
        return {
          id: typeof institution?.institution_id === "string" ? institution.institution_id : null,
          name: typeof institution?.name === "string" ? institution.name : null,
          url: publicUrl(institution?.url),
          products: Array.isArray(institution?.products) ? institution.products.filter((p: unknown) => typeof p === "string" && /^[a-z_]+$/.test(p)) : [],
          countries: Array.isArray(institution?.country_codes) ? institution.country_codes.filter((p: unknown) => typeof p === "string" && /^[A-Z]{2}$/.test(p)) : [],
        };
      }) };
    } catch (error: unknown) {
      return { query, status: null, error_code: safeCode(record(record(error)?.cause)?.code) };
    }
  }));
  const failed = results.filter((result) => result.error_code).length;
  console.log(JSON.stringify({ environment: "sandbox", production_coverage_verified: false,
    successful_queries: results.length - failed, failed_queries: failed, results }, null, 2));
  if (failed) process.exitCode = 1;
}
async function provider(persistenceOnly: boolean) {
  configureBankSandbox();
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch("http://localhost:9099/health", { signal: AbortSignal.timeout(1500) })).ok) break; }
    catch { /* medusa develop can restart after a source edit */ }
    assert(attempt < 59, "SANDBOX_BACKEND_UNAVAILABLE");
    await new Promise(done => setTimeout(done, 1000));
  }
  assert.equal((await fetch("http://localhost:9099/admin/banking")).status, 401, "unauthenticated banking is denied");
  assert.equal((await fetch("http://localhost:9099/pub/banking/webhook", { method: "POST",
    headers: { "Content-Type": "application/json", "plaid-verification": "invalid" }, body: "{}" })).status, 401);
  let jwt = "";
  async function api(path: string, body?: RecordValue) {
    const response = await fetch(`http://localhost:9099${path}`, {
      method: body ? "POST" : "GET", headers: { "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`, "Idempotency-Key": randomUUID() },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120_000),
    });
    const value = record(await response.json());
    assert(response.ok, `HTTP_${response.status}_${safeCode(value?.code)}`);
    assert(value); return value;
  }
  const auth = await api("/auth/user/emailpass", { email: "sandbox@test.com", password: "sandbox123" });
  assert.equal(typeof auth.token, "string"); jwt = auth.token as string;
  const pool = getDbPool();
  try {
    const existing = await pool.query<{ id: string }>(`SELECT c.id FROM bank_connection c JOIN bank_account a ON a.connection_id=c.id
      WHERE a.name='EPT Sandbox checking' AND c.environment='sandbox' AND c.status<>'disconnected' LIMIT 1`);
    let connectionId = existing.rows[0]?.id;
    if (!connectionId) {
      assert(!persistenceOnly, "PERSISTED_CONNECTION_REQUIRED");
      const link = await api("/admin/banking/link-token", {});
      assert(String(link.link_token).startsWith("link-sandbox-"));
      console.log("PASS: authenticated sandbox Link token; unauthenticated and unsigned requests rejected");
      const custom = { override_accounts: [{ type: "depository", subtype: "checking",
        starting_balance: 1500, currency: "USD", meta: { name: "EPT Sandbox checking", mask: "0042" },
        transactions: [
          { date_transacted: "2026-09-01", date_posted: "2026-09-02", amount: 125.5, description: "EPT utilities test" },
          { date_transacted: "2026-09-02", date_posted: "2026-09-03", amount: -500, description: "EPT deposit test" },
        ] }] };
      const response = await fetch("https://sandbox.plaid.com/sandbox/public_token/create", {
        method: "POST", headers: { "Content-Type": "application/json", "Plaid-Version": "2020-09-14" },
        body: JSON.stringify({ client_id: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SANDBOX_SECRET,
          institution_id: "ins_109508", initial_products: ["transactions"],
          options: { override_username: "user_custom", override_password: JSON.stringify(custom) } }),
        signal: AbortSignal.timeout(30_000),
      });
      const created = record(await response.json());
      if (!response.ok) {
        let diagnostic = typeof created?.error_message === "string" ? created.error_message : "";
        for (const secret of [process.env.PLAID_CLIENT_ID, process.env.PLAID_SANDBOX_SECRET]) {
          if (secret) diagnostic = diagnostic.split(secret).join("[REDACTED]");
        }
        diagnostic = diagnostic.replace(/(?:access|public|link)-(?:sandbox|production)-[A-Za-z0-9_-]+/g, "[REDACTED]");
        console.log(JSON.stringify({ stage: "sandbox_public_token_create", status: response.status,
          error_code: safeCode(created?.error_code), error_type: safeCode(created?.error_type), diagnostic: diagnostic.slice(0, 1200) }));
      }
      assert(response.ok, `PLAID_${safeCode(created?.error_code)}`);
      assert.equal(typeof created?.public_token, "string");
      const connected = await api("/admin/banking/connections", { public_token: created?.public_token });
      assert.equal(typeof connected.connection_id, "string"); connectionId = connected.connection_id as string;
      const replay = await api("/admin/banking/connections", { public_token: created?.public_token });
      assert.equal(replay.connection_id, connectionId, "exchange retry must retain connection");
      console.log("PASS: provider exchange persisted; replay retains one connection");
      const accounts = await pool.query<{ id: string }>("SELECT id FROM bank_account WHERE connection_id=$1", [connectionId]);
      assert.equal(accounts.rowCount, 1, "custom sandbox account count");
      await api(`/admin/banking/connections/${connectionId}/accounts`, { account_ids: accounts.rows.map(a => a.id) });
    }
    assert(connectionId);
    if (persistenceOnly) {
      for (let attempt = 0; attempt < 36; attempt++) {
        const automatic = (await pool.query(`SELECT c.status,c.last_error_code,c.last_successful_sync_at,c.sync_requested_at,c.refresh_requested_at,c.refresh_completed_at,
          (SELECT count(*) FROM bank_sync_run) AS total_runs,
          EXISTS(SELECT 1 FROM bank_sync_run s WHERE s.connection_id=c.id AND s.trigger='scheduled'
            AND s.status='succeeded' AND s.started_at>now()-interval '3 minutes') AS worker_ran
          FROM bank_connection c WHERE c.id=$1`, [connectionId])).rows[0];
        if (attempt === 0) {
          const stored = (await pool.query("SELECT access_token_encrypted FROM bank_connection WHERE id=$1", [connectionId])).rows[0];
          const item = await plaidRequest("/item/get", { access_token: decryptBankToken(stored?.access_token_encrypted as string, connectionId, sandboxTokenKey()) });
          console.log(JSON.stringify({ stage: "automatic_refresh", requested_at: automatic?.refresh_requested_at,
            completed_at: automatic?.refresh_completed_at, worker_ran: automatic?.worker_ran,
            status: automatic?.status, last_error_code: automatic?.last_error_code, total_runs: automatic?.total_runs,
            last_successful_sync_at: automatic?.last_successful_sync_at, sync_requested_at: automatic?.sync_requested_at,
            provider_last_successful_update: object(object(item.status).transactions).last_successful_update }));
        }
        if (automatic?.worker_ran && automatic.sync_requested_at === null && automatic.refresh_requested_at &&
          automatic.refresh_completed_at >= automatic.refresh_requested_at) break;
        assert(attempt < 35, "AUTOMATIC_REFRESH_NOT_CONFIRMED");
        await new Promise(done => setTimeout(done, 5000));
      }
      console.log("PASS: banking worker completed refresh after restart without another bank login");
    }
    const before = await pool.query("SELECT access_token_encrypted FROM bank_connection WHERE id=$1", [connectionId]);
    const cipher = before.rows[0]?.access_token_encrypted as string;
    assert(cipher && !cipher.includes("access-sandbox-"), "token encrypted at rest");
    assert(decryptBankToken(cipher, connectionId, sandboxTokenKey()).startsWith("access-sandbox-"));
    for (let attempt = 0; attempt < 24; attempt++) {
      await syncBank(connectionId, "manual");
      const row = (await pool.query("SELECT historical_sync_complete FROM bank_connection WHERE id=$1", [connectionId])).rows[0];
      if (row?.historical_sync_complete) break;
      assert(attempt < 23, "HISTORY_STILL_PENDING");
      await new Promise(done => setTimeout(done, 5000));
    }
    const accounts = await pool.query<{ id: string }>("SELECT id FROM bank_account WHERE connection_id=$1", [connectionId]);
    const page = await api(`/admin/banking/transactions?account_id=${accounts.rows[0]?.id}&limit=50&offset=0`);
    assert.equal(page.count, 2, "entire custom history persisted");
    const amounts = (page.transactions as RecordValue[]).map(t => t.amount).sort();
    assert.deepEqual(amounts, ["-125.5", "500"], "bank signs preserved, UI signs explicit");
    console.log("PASS: complete custom provider history persisted with correct signs");
    await syncBank(connectionId, "manual");
    assert.equal((await api(`/admin/banking/transactions?account_id=${accounts.rows[0]?.id}&limit=50&offset=0`)).count, 2);
    if (!persistenceOnly) {
      const refresh = await api(`/admin/banking/connections/${connectionId}/refresh`, {});
      assert.equal(refresh.status, "refresh_requested");
      const update = await api("/admin/banking/link-token", { connection_id: connectionId });
      assert(String(update.link_token).startsWith("link-sandbox-"));
      await api(`/admin/banking/connections/${connectionId}/reconnect`, {});
    }
    const after = (await pool.query("SELECT access_token_encrypted,status,sync_requested_at FROM bank_connection WHERE id=$1", [connectionId])).rows[0];
    assert.equal(after?.access_token_encrypted, cipher, "authorization persisted unchanged");
    assert.equal(after?.status, "active");
    const overview = JSON.stringify(await api("/admin/banking"));
    assert(!/access-sandbox-|access_token_encrypted|linked_public_token_hash|cursor/.test(overview));
    console.log(JSON.stringify({ pass: true, mode: persistenceOnly ? "persistence" : "provider", environment: "sandbox",
      connection_id: connectionId, accounts: accounts.rowCount, transactions: page.count,
      real_bank_login_verified: false, provider_api_verified: true }));
  } finally { await pool.end(); }
}
void main().catch((error: unknown) => {
  const location = error instanceof Error ? error.stack?.split("\n").find(line => line.includes("verify-bank-feed.ts:"))?.trim() : undefined;
  const code = record(error)?.code;
  console.log(JSON.stringify({ error_code: "BANK_FEED_VERIFICATION_FAILED", code: safeCode(code), location }));
  process.exitCode = 1;
});
