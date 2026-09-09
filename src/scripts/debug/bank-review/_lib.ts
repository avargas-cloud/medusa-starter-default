/**
 * Shared helper for the guided Banking review (docs/BANK_REVIEW_CASES.md).
 * Sandbox ONLY: configureBankSandbox() pins DATABASE_URL to :5499 and refuses without the sandbox key.
 * Data created here is the operator's (persists); never fixtures of another suite.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { configureBankSandbox } from "../../../lib/banking/sandbox-runtime";
import { getDbPool } from "../../../api/utils/db-pool";

export const API = "http://localhost:9099";
export const POS = "http://localhost:3099";
export const LOGIN = { email: "sandbox@test.com", password: "sandbox123" };
export type Json = Record<string, unknown>;

export function record(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}
export function safeCode(value: unknown): string {
  return typeof value === "string" && /^[A-Z0-9_]{1,80}$/.test(value) ? value : "UNKNOWN";
}

export interface Api {
  jwt: string;
  /** Throws on !ok unless `allow` lists the status; returns { status, body }. */
  call(path: string, init?: { method?: string; body?: Json; headers?: Record<string, string>; allow?: number[] }): Promise<{ status: number; body: Json }>;
  get(path: string): Promise<Json>;
  post(path: string, body?: Json, headers?: Record<string, string>): Promise<Json>;
}

export async function connect(): Promise<{ api: Api; pool: ReturnType<typeof getDbPool> }> {
  configureBankSandbox();
  let healthy = false;
  for (let attempt = 0; attempt < 60 && !healthy; attempt++) {
    healthy = (await fetch(`${API}/health`, { signal: AbortSignal.timeout(3000) }).catch(() => null))?.ok === true;
    if (!healthy) await new Promise(done => setTimeout(done, 1000)); // medusa develop restarts after a source edit
  }
  assert(healthy, "SANDBOX_BACKEND_UNAVAILABLE (:9099) — run sandbox-runtime.ts --start");
  const auth = await fetch(`${API}/auth/user/emailpass`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(LOGIN) });
  const token = record(await auth.json())?.token;
  assert(typeof token === "string", "SANDBOX_LOGIN_FAILED");
  const api: Api = {
    jwt: token,
    async call(path, init = {}) {
      const response = await fetch(`${API}${path}`, {
        method: init.method ?? (init.body ? "POST" : "GET"),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Idempotency-Key": randomUUID(), ...(init.headers ?? {}) },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}), signal: AbortSignal.timeout(120_000),
      });
      const text = await response.text();
      let body: Json = {};
      try { body = record(JSON.parse(text)) ?? {}; } catch { body = { raw: text.slice(0, 300) }; }
      if (!response.ok && !(init.allow ?? []).includes(response.status)) {
        throw new Error(`HTTP_${response.status}_${safeCode(body.code)} ${init.method ?? "GET"} ${path} ${JSON.stringify(body).slice(0, 300)}`);
      }
      return { status: response.status, body };
    },
    async get(path) { return (await api.call(path)).body; },
    async post(path, body = {}, headers = {}) { return (await api.call(path, { method: "POST", body, headers })).body; },
  };
  const config = record((await api.get("/admin/banking")).config);
  assert.equal(config?.environment, "sandbox", "BANKING_NOT_SANDBOX");
  return { api, pool: getDbPool() };
}

/** The operator's base account from the catalog: "EPT Sandbox checking" ···0042, 2 movements. */
export async function baseAccount(api: Api, pool: ReturnType<typeof getDbPool>) {
  const row = (await pool.query<{ id: string; connection_id: string }>(
    `SELECT a.id, a.connection_id FROM bank_account a JOIN bank_connection c ON c.id=a.connection_id
      WHERE a.name='EPT Sandbox checking' AND a.mask='0042' AND c.environment='sandbox' AND c.status<>'disconnected'
        AND a.deleted_at IS NULL AND c.deleted_at IS NULL ORDER BY a.created_at LIMIT 1`)).rows[0];
  assert(row, "BASE_ACCOUNT_MISSING — run case-01 first");
  const feed = await api.get(`/admin/banking/transactions?account_id=${row.id}&limit=100&offset=0&history=true`);
  const transactions = (feed.transactions as Json[]) ?? [];
  const byName = (name: string) => transactions.find(t => t.name === name);
  return { ...row, transactions, utilities: byName("EPT utilities test"), deposit: byName("EPT deposit test") };
}

export async function journalCount(pool: ReturnType<typeof getDbPool>, where = "TRUE", params: unknown[] = []) {
  const result = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM bank_journal_entry WHERE ${where}`, params);
  return Number(result.rows[0]?.n ?? 0);
}

export function block(title: string, value: unknown) {
  console.log(`\n## ${title}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
}

export async function run(caseId: string, body: (ctx: { api: Api; pool: ReturnType<typeof getDbPool> }) => Promise<void>) {
  const ctx = await connect();
  try { await body(ctx); console.log(`\nPASS ${caseId}`); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`\nFAIL ${caseId}: ${message.replace(/(?:access|public|link)-(?:sandbox|production)-[A-Za-z0-9_-]+/g, "[REDACTED]")}`);
    process.exitCode = 1;
  } finally { await ctx.pool.end(); }
}
