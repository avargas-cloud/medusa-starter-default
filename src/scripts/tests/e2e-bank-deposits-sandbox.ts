/** V7 setup and real HTTP/browser verification; financial source tables are immutable. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getDbPool } from "../../api/utils/db-pool";
import { configureBankSandbox } from "../../lib/banking/sandbox-runtime";
import { transaction } from "../../lib/banking/store";
import { withReviewLock } from "../../lib/banking/review-common";
import { Migration20260909005000 } from "../../modules/banking/migrations/Migration20260909005000";
import { verifiedDepositSnapshot, financialFingerprint, cleanDepositFixtures, seedDepositAccount,
  seedDepositMovement, fixtureAccount, fixtureConnection, fixtureDay, fixtureReference,
  deferCompanionFixture, restoreCompanionFixture, type TemporarySetup } from "./bank-deposits-fixtures";

type Value = Record<string, unknown>;
type Candidate = { id: string; source_hash: string; available_amount: string; amount: string; customer_id: string };
type Deposit = { id: string; revision: number; status: string; source_hash: string; net_amount: string; lines: Value[] };
let checks = 0;
function check(condition: unknown, label: string): asserts condition { assert(condition, label); checks++; }
function record(value: unknown): Value { assert(value && typeof value === "object" && !Array.isArray(value)); return value as Value; }

async function setup() {
  configureBankSandbox();
  await verifiedDepositSnapshot();
  const migration = Object.create(Migration20260909005000.prototype) as InstanceType<typeof Migration20260909005000>;
  const statements: string[] = []; migration.addSql = (sql: string) => { statements.push(sql); }; await migration.up();
  const pool = getDbPool(); const client = await pool.connect();
  try {
    const before = await financialFingerprint(client);
    await transaction(client, async () => { await withReviewLock(client); for (const sql of statements) await client.query(sql); });
    assert.deepEqual(await financialFingerprint(client), before, "Migration preserves financial source evidence");
    console.log("PASS targeted V7 banking migration applied atomically; financial fingerprints unchanged");
  } finally { client.release(); await pool.end(); }
}

async function main() {
  configureBankSandbox(); process.env.POS_URL = "http://localhost:3099"; process.env.MEDUSA_SANDBOX_URL = "http://localhost:9099";
  const pool = getDbPool(); const client = await pool.connect();
  let owns = false; let before: Record<string, unknown> | undefined; let jwt = "";
  let companion: TemporarySetup | undefined;
  const measurements: { path: string; bytes: number; ms: number }[] = [];
  const api = async (path: string, body?: Value, status = 200, key = randomUUID(), anonymous = false) => {
    const start = performance.now(); const response = await fetch(`http://localhost:9099${path}`, {
      method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(!anonymous && jwt ? { Authorization: `Bearer ${jwt}` } : {}),
        ...(body ? { "Idempotency-Key": key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
    const text = await response.text(); let value: Value;
    try { value = record(JSON.parse(text)); } catch { throw new Error(`Non-JSON HTTP ${response.status} at ${path}`); }
    check(response.status === status, `${path}: expected ${status}, received ${response.status}, code ${String(value.code ?? "none")}`);
    if (!body && response.ok) measurements.push({ path: path.split("?")[0]!, bytes: Buffer.byteLength(text), ms: Math.round(performance.now() - start) });
    return value;
  };
  const version = async (id: string) => ({ expected_revision: (await client.query("SELECT revision FROM bank_transaction_review WHERE transaction_id=$1", [id])).rows[0]?.revision ?? 0, expected_source_version: 1 });
  const getDeposit = async (id: string) => (await api(`/admin/banking/deposits/${id}`)).deposit as Deposit;
  try {
    owns = (await client.query("SELECT pg_try_advisory_lock(hashtextextended('e2e-bank-deposits-http',7241)) AS ok")).rows[0].ok;
    check(owns, "Only one HTTP deposit harness owns these fixtures");
    before = await financialFingerprint(client); await cleanDepositFixtures(client);
    check(!(await client.query("SELECT 1 FROM bank_day_close WHERE day=$1", [fixtureDay])).rowCount, "Fixture day has no unrelated close history");
    companion = await deferCompanionFixture(client); await seedDepositAccount(client);
    await api("/admin/banking/deposits", undefined, 401, undefined, true);
    jwt = String((await api("/auth/user/emailpass", { email: "sandbox@test.com", password: "sandbox123" })).token);
    const candidateResult = await api(`/admin/banking/deposit-candidates?account_id=${fixtureAccount}&q=`);
    const candidates = candidateResult.candidates as Candidate[];
    check(Array.isArray(candidates) && candidates.length >= 2, "Real receipt candidate list is usable");
    const selected = candidates.filter(row => Number(row.available_amount) >= 2).slice(0, 2);
    check(selected.length === 2, "Two existing receipts have at least two dollars of available bank allocation");
    const feeAccount = (await client.query("SELECT qb_list_id FROM qb_account WHERE is_active AND deleted_at IS NULL AND account_type='Expense' ORDER BY qb_list_id LIMIT 1")).rows[0]?.qb_list_id as string;
    check(feeAccount, "Real expense account available for explicit fee");
    const body: Value = { expected_revision: 0, account_id: fixtureAccount, date: fixtureDay, reference: fixtureReference, memo: "HTTP deposit evidence",
      fee_amount: "0.25", fee_account_list_id: feeAccount, fee_reference: "Synthetic fee advice: 25 cents",
      lines: selected.map(row => ({ payment_id: row.id, amount: "1.00", expected_source_hash: row.source_hash })) };
    const retry = randomUUID();
    const created = (await api("/admin/banking/deposits", body, 200, retry)).deposit as Deposit;
    const repeated = (await api("/admin/banking/deposits", body, 200, retry)).deposit as Deposit;
    check(created.id === repeated.id && created.revision === repeated.revision, "Creation retry returns the original deposit");
    check(Number(created.net_amount) === 1.75 && created.lines.length === 2, "Two partial receipts minus explicit fee total $1.75");
    const reserved = (await api(`/admin/banking/deposit-candidates?account_id=${fixtureAccount}&q=`)).candidates as Candidate[];
    for (const receipt of selected) check(Number(reserved.find(row => row.id === receipt.id)?.available_amount) === Number(receipt.available_amount) - 1,
      "Draft consumes only its one-dollar portion of receipt availability");
    await api("/admin/banking/deposits", { ...body, id: created.id, expected_revision: 0 }, 409);
    await api("/admin/banking/deposits", { ...body, reference: "Invalid fractional cents", lines: [{ payment_id: selected[0]!.id, amount: "0.001", expected_source_hash: selected[0]!.source_hash }] }, 400);
    await api("/admin/banking/deposits", { ...body, fee_reference: "" }, 400);
    const ready = (await api(`/admin/banking/deposits/${created.id}/ready`, { expected_revision: created.revision, expected_source_hash: created.source_hash })).deposit as Deposit;
    check(ready.status === "ready", "Deposit explicitly prepared for matching");
    const tx = "btx_e2e_deposits_http_match";
    await seedDepositMovement(client, tx, "1.75");
    const saveMatch = async (deposit: Deposit) => api(`/admin/banking/transactions/${tx}/review`, { ...await version(tx), mode: "deposit", matched_deposit_id: deposit.id,
      expected_deposit_source_hash: deposit.source_hash, comment: "Explicit grouped match" });
    const saved = record((await saveMatch(ready)).review);
    check(saved.mode === "deposit" && saved.matched_deposit_id === ready.id, "Deposit links through the actual review endpoint");
    await api(`/admin/banking/transactions/${tx}/confirm`, await version(tx));
    const day = await api(`/admin/banking/daily?date=${fixtureDay}`);
    check(JSON.stringify(day.accounts).includes(ready.id), "Daily review exposes grouped deposit evidence");
    const edited = (await api("/admin/banking/deposits", { ...body, id: ready.id, expected_revision: (await getDeposit(ready.id)).revision, memo: "Corrected evidence after preliminary confirmation" })).deposit as Deposit;
    const liveReview = (await client.query("SELECT status FROM bank_transaction_review WHERE transaction_id=$1", [tx])).rows[0];
    check(liveReview?.status !== "confirmed", "Editing linked deposit invalidates preliminary review confirmation");
    check(edited.status === "draft", "Edited deposit requires preparation again");
    const browserSuite = await import(pathToFileURL(resolve(__dirname, "../../../../store-pos/scripts/e2e/bank-deposits.mjs")).href) as {
      runDepositBrowser(input: { depositId: string; accountId: string; transactionId: string; day: string; reference: string }): Promise<number> };
    checks += await browserSuite.runDepositBrowser({ depositId: created.id, accountId: fixtureAccount, transactionId: tx, day: fixtureDay, reference: fixtureReference });
    const current = await getDeposit(created.id);
    check(current.status === "ready", "Browser leaves the deposit ready and selected");
    const reviewState = (await client.query("SELECT status FROM bank_transaction_review WHERE transaction_id=$1", [tx])).rows[0];
    if (reviewState.status !== "confirmed") await api(`/admin/banking/transactions/${tx}/confirm`, await version(tx));
    const closing = await api(`/admin/banking/daily?date=${fixtureDay}`);
    check(closing.can_close, `Daily close ready after matching: ${JSON.stringify(closing.blockers)}`);
    await api("/admin/banking/daily/confirm", { date: fixtureDay, expected_revision: closing.revision, input_hash: closing.input_hash });
    const snapshot = (await api(`/admin/banking/daily?date=${fixtureDay}`));
    check(snapshot.status === "closed" && JSON.stringify(snapshot.accounts).includes(current.id), "Closed day retains deposit composition");
    await api("/admin/banking/deposits", { ...body, id: current.id, expected_revision: current.revision }, 409);
    await api(`/admin/banking/deposits/${current.id}/void`, { expected_revision: current.revision, reason: "Must reject while closed" }, 409);
    await api("/admin/banking/daily/reopen", { date: fixtureDay, expected_revision: snapshot.revision, reason: "Owned E2E reopen" });
    await api(`/admin/banking/deposits/${current.id}/void`, { expected_revision: (await getDeposit(current.id)).revision, reason: "Owned fixture completed" });
    const reopened = await api(`/admin/banking/daily?date=${fixtureDay}`);
    const history = (await client.query("SELECT history FROM bank_day_close WHERE day=$1", [fixtureDay])).rows[0]?.history;
    check(Array.isArray(reopened.history) && reopened.history.length === 1 && JSON.stringify(history).includes(current.id), "Voiding after reopen preserves earlier audited deposit evidence");
    console.log(JSON.stringify({ measurement: "deposit_http", samples: measurements }));
  } finally {
    try { if (owns) { await cleanDepositFixtures(client); if (companion) await restoreCompanionFixture(client, companion); if (before) { assert.deepEqual(await financialFingerprint(client), before); checks++; }
      check(!(await client.query("SELECT 1 FROM bank_connection WHERE id=$1", [fixtureConnection])).rowCount, "Owned banking fixtures removed");
      await client.query("SELECT pg_advisory_unlock(hashtextextended('e2e-bank-deposits-http',7241))"); } }
    finally { client.release(); await pool.end(); }
  }
  console.log(`PASS bank deposit HTTP/browser: ${checks} checks; financial sources unchanged`);
}

const mode = process.argv[2];
void (mode === "--setup" ? setup() : !mode ? main() : Promise.reject(new Error("INVALID_MODE"))).catch((error: unknown) => {
  console.error(`Deposit verification failed after ${checks} checks:`, error instanceof Error ? error.message : "UNKNOWN_ERROR"); process.exitCode = 1;
});
