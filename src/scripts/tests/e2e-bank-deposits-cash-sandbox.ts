/**
 * E2E — Record deposit into a QuickBooks bank account with NO Plaid feed
 * (deposit-cash-accounts-20260916): Petty Cash / Cash Register. SANDBOX.
 *
 *   1. `GET /deposits/accounts` lists the Plaid depository accounts AND the
 *      no-feed QuickBooks Bank accounts (ListID as id, connection_id null).
 *      Negative: a Bank account that HAS a feed (Chase 7223) is listed once,
 *      as its Plaid row, never as a ListID.
 *   2. Candidates + save + ready + post into Cash Register: the journal debits
 *      Cash Register, the DepositAdd carries DepositToAccountRef = Cash
 *      Register; the row lists `account_id` null / `account_list_id` set.
 *   3. Negatives: saving into Chase's ListID (has a feed) → 404; into a
 *      non-Bank ListID (Undeposited Funds) → 404; dated before the cut → 409.
 *   4. Editing an ADOPTED Cash Register deposit still resolves its account
 *      (save with the same ListID keeps `account_id` null).
 *
 * Run (backend sandbox on the same DB):
 *   env DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa E2E_BACKEND_URL=http://localhost:9099 \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-bank-deposits-cash-sandbox.ts
 */
import { Client } from "pg";

const BACKEND = process.env.E2E_BACKEND_URL ?? "http://localhost:9099";
const PREFIX = "e2e_depcash_";
const CHASE = "80000006-1317847775";
const CASH_REGISTER = "80000057-1353086919";
const PETTY_CASH = "80000045-1330711003";
const UNDEPOSITED_FUNDS = "80000048-1331156691";

let failures = 0;
const assert = (ok: boolean, label: string, detail = ""): void => {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
let token = "";
async function api<T = any>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; json: T }> {
  const res = await fetch(`${BACKEND}${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}
let ikey = 0;
const idem = (): Record<string, string> => ({ "idempotency-key": `${PREFIX}${Date.now()}-${++ikey}` });
async function login(): Promise<void> {
  const res = await fetch(`${BACKEND}/auth/user/emailpass`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: process.env.E2E_EMAIL ?? "sandbox@test.com", password: process.env.E2E_PASSWORD ?? "sandbox123" }) });
  const j = (await res.json()) as { token?: string };
  if (!j.token) throw new Error(`login failed (${res.status})`);
  token = j.token;
}
const manualLine = (suffix: string, amount: string) => ({ payment_id: null, manual: true, reference: `${PREFIX}${suffix}`, description: "cash from the register", amount });

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!/localhost:5499|127\.0\.0\.1:5499/.test(url)) throw new Error("refusing to run outside the sandbox DB (port 5499)");
  await login();
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    // ── 1 · lista de cuentas ───────────────────────────────────────────────
    console.log("── 1. GET /deposits/accounts lists Plaid depository rows + no-feed QuickBooks Bank accounts");
    const list = await api("GET", "/admin/banking/deposits/accounts");
    const accounts: any[] = list.json.accounts ?? [];
    const cashReg = accounts.find((a) => a.id === CASH_REGISTER);
    const petty = accounts.find((a) => a.id === PETTY_CASH);
    assert(list.status === 200 && !!cashReg && !!petty, "Cash Register and Petty Cash are offered", `HTTP ${list.status} n=${accounts.length}`);
    assert(cashReg?.connection_id === null && cashReg?.subtype === "cash" && cashReg?.type === "depository" && cashReg?.currency === "USD" && cashReg?.review_start_date === "2025-12-31", "no-feed row: connection_id null, subtype cash, USD, review_start_date = setup cut", JSON.stringify(cashReg));
    const chasePlaid = (await client.query<{ id: string }>(`SELECT id FROM bank_account WHERE qb_list_id=$1 AND deleted_at IS NULL LIMIT 1`, [CHASE])).rows[0]!;
    assert(accounts.some((a) => a.id === chasePlaid.id && a.connection_id) && !accounts.some((a) => a.id === CHASE), "NEGATIVE: Chase 7223 (has a feed) is listed as its Plaid row only, never as a ListID");
    assert(accounts.every((a) => a.type === "depository"), "every row is depository (no credit cards)");
    const plaidFirst = accounts.findIndex((a) => !a.connection_id);
    assert(plaidFirst === -1 || accounts.slice(plaidFirst).every((a) => !a.connection_id), "feeds first, then the no-feed accounts");

    // ── 2 · candidatos + save + ready + post en Cash Register ──────────────
    console.log("\n── 2. deposit into Cash Register: candidates → save → ready → post → DepositAdd");
    const cand = await api("GET", `/admin/banking/deposit-candidates?account_id=${CASH_REGISTER}`);
    assert(cand.status === 200 && Array.isArray(cand.json.candidates), "candidates endpoint accepts the ListID", `HTTP ${cand.status} count=${cand.json.count}`);
    const lastClosed = (await client.query<{ d: string | null }>(`SELECT max(to_day) AS d FROM bank_statement WHERE account_list_id=$1 AND status='closed'`, [CASH_REGISTER])).rows[0]!.d;
    const day = (await client.query<{ d: string }>(`SELECT to_char(greatest((now() AT TIME ZONE 'America/New_York')::date - 1, COALESCE($1::date,'2025-12-31'::date) + 1),'YYYY-MM-DD') AS d`, [lastClosed])).rows[0]!.d;
    const save = await api("POST", "/admin/banking/deposits", { expected_revision: 0, account_id: CASH_REGISTER, date: day, reference: `${PREFIX}cashreg`, memo: "", fee_amount: "0", lines: [manualLine("cashreg-line", "12.34")] }, idem());
    assert(save.status === 200, "deposit into Cash Register saved", `HTTP ${save.status} ${JSON.stringify(save.json).slice(0, 160)}`);
    const dep = save.json.deposit ?? {};
    const depId: string = dep.id;
    assert(dep.account_id === null && dep.account_list_id === CASH_REGISTER && dep.account_name === "Cash Register", "row: account_id null, account_list_id = Cash Register, named by QuickBooks", JSON.stringify({ account_id: dep.account_id, account_list_id: dep.account_list_id, account_name: dep.account_name }));
    const listed = await api("GET", `/admin/banking/deposits?account_id=${CASH_REGISTER}&status=draft`);
    assert(listed.status === 200 && (listed.json.deposits ?? []).some((d: any) => d.id === depId), "Record Deposits filter by the ListID finds it");
    const ready = await api("POST", `/admin/banking/deposits/${depId}/ready`, { expected_revision: dep.revision, expected_source_hash: dep.source_hash }, idem());
    assert(ready.status === 200 && ready.json.deposit?.status === "ready", "ready (no Plaid account_id needed)", `HTTP ${ready.status} ${JSON.stringify(ready.json).slice(0, 120)}`);
    const acct = await api("GET", `/admin/banking/accounting/deposits/${depId}`);
    assert(acct.status === 200 && acct.json.eligible === true, "eligible to post", JSON.stringify(acct.json.blockers ?? acct.json).slice(0, 160));
    const preview = await api("POST", `/admin/banking/accounting/deposits/${depId}/preview`, { expected_source_hash: acct.json.source_hash });
    const post = await api("POST", `/admin/banking/accounting/deposits/${depId}/post`, { expected_source_hash: acct.json.source_hash, preview_hash: preview.json.preview_hash }, idem());
    assert(post.status === 200, "posted", `HTTP ${post.status} ${JSON.stringify(post.json).slice(0, 160)}`);
    const bankLine = (await client.query<{ acct: string; debit: string }>(
      `SELECT l.account_list_id AS acct, l.debit_cents::text AS debit FROM bank_journal_entry e JOIN bank_journal_line l ON l.entry_id=e.id AND l.role='bank_account'
        WHERE e.source_kind='bank_deposit' AND e.source_id=$1 AND e.kind='document' AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id)`, [depId])).rows[0];
    assert(bankLine?.acct === CASH_REGISTER && bankLine?.debit === "1234", "journal: Dr Cash Register 12.34", JSON.stringify(bankLine));
    const addRow = (await client.query<{ payload: { qbxml?: string } }>(`SELECT payload FROM qb_order_pipeline WHERE reference_id=$1 AND step='gl_document_add' ORDER BY created_at DESC LIMIT 1`, [depId])).rows[0];
    const xml = String(addRow?.payload?.qbxml ?? "");
    assert(xml.includes(`<DepositToAccountRef><ListID>${CASH_REGISTER}</ListID></DepositToAccountRef>`), "DepositAdd queued with DepositToAccountRef = Cash Register", xml.slice(0, 200));
    // limpieza: reversa + void del fixture
    await api("POST", `/admin/banking/accounting/deposits/${depId}/reverse`, { posting_id: post.json.posting?.id, day, reason: `${PREFIX}cleanup` }, idem());
    const cur = await api("GET", `/admin/banking/deposits/${depId}`);
    const voided = await api("POST", `/admin/banking/deposits/${depId}/void`, { expected_revision: cur.json.deposit.revision, reason: `${PREFIX}cleanup` }, idem());
    assert(voided.status === 200, "cleanup: fixture reversed + voided", `HTTP ${voided.status}`);

    // ── 3 · negativos ──────────────────────────────────────────────────────
    console.log("\n── 3. negatives");
    const viaListId = await api("POST", "/admin/banking/deposits", { expected_revision: 0, account_id: CHASE, date: day, reference: `${PREFIX}neg-chase`, memo: "", fee_amount: "0", lines: [manualLine("neg-chase", "1.00")] }, idem());
    assert(viaListId.status === 404 && JSON.stringify(viaListId.json).includes("BANKING_ACCOUNT_NOT_FOUND"), "NEGATIVE: Chase's ListID (has a feed) → 404 (the Plaid row is its only handle)", `HTTP ${viaListId.status} ${JSON.stringify(viaListId.json).slice(0, 120)}`);
    const nonBank = await api("POST", "/admin/banking/deposits", { expected_revision: 0, account_id: UNDEPOSITED_FUNDS, date: day, reference: `${PREFIX}neg-uf`, memo: "", fee_amount: "0", lines: [manualLine("neg-uf", "1.00")] }, idem());
    assert(nonBank.status === 404, "NEGATIVE: a non-Bank ListID (Undeposited Funds) → 404", `HTTP ${nonBank.status}`);
    const early = await api("POST", "/admin/banking/deposits", { expected_revision: 0, account_id: PETTY_CASH, date: "2025-12-30", reference: `${PREFIX}neg-early`, memo: "", fee_amount: "0", lines: [manualLine("neg-early", "1.00")] }, idem());
    assert(early.status === 409 && JSON.stringify(early.json).includes("BANKING_TRANSACTION_BEFORE_REVIEW_START"), "NEGATIVE: Petty Cash dated before the 2025-12-31 cut → 409", `HTTP ${early.status} ${JSON.stringify(early.json).slice(0, 120)}`);
    const leftovers = (await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM bank_deposit WHERE reference LIKE $1 AND status<>'void'`, [`${PREFIX}neg-%`])).rows[0]!.n;
    assert(leftovers === "0", "no negative case left a deposit behind");

    // ── 4 · un depósito ADOPTADO en Cash Register se puede re-guardar ──────
    console.log("\n── 4. an adopted Cash Register deposit (account_id null) resolves its account on save");
    const adopted = (await client.query<{ id: string; revision: number }>(
      `SELECT d.id, d.revision FROM bank_deposit d WHERE d.account_id IS NULL AND d.account_list_id=$1 AND d.status='draft' AND d.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM bank_statement s WHERE s.account_list_id=d.account_list_id AND s.status='closed' AND d.deposit_date BETWEEN s.from_day AND s.to_day) ORDER BY d.deposit_date DESC LIMIT 1`, [CASH_REGISTER])).rows[0];
    if (!adopted) {
      console.log("   (no draft adopted Cash Register deposit outside a closed statement in this clone — skipped)");
    } else {
      const read = await api("GET", `/admin/banking/deposits/${adopted.id}`);
      const d = read.json.deposit;
      const resave = await api("POST", "/admin/banking/deposits", { id: d.id, expected_revision: d.revision, account_id: CASH_REGISTER, date: d.date, reference: d.reference, memo: `${d.memo ?? ""} ${PREFIX}touch`.trim(), fee_amount: d.fee_amount, lines: d.lines.map((l: any) => l.manual ? { payment_id: null, manual: true, reference: l.reference, description: l.description ?? "", amount: l.amount, account_list_id: l.account_list_id ?? undefined } : { payment_id: l.payment_id, amount: l.amount, expected_source_hash: l.source_hash }) }, idem());
      assert(resave.status === 200 && resave.json.deposit?.account_id === null && resave.json.deposit?.account_list_id === CASH_REGISTER, "re-saved with its ListID: account_id stays null, account_list_id kept", `HTTP ${resave.status} ${JSON.stringify(resave.json).slice(0, 160)}`);
    }
  } finally {
    await client.end();
  }
  console.log(`\n${failures === 0 ? "✅ ALL GREEN" : `❌ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
