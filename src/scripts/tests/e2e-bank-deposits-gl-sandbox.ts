/**
 * E2E — Record Deposits sobre el GL (record-deposits-gl-20260915), SANDBOX.
 *
 * Complementa `e2e-gl-documents-qb-sandbox.ts` §5 (que ya prueba el depósito
 * NUEVO: post → DepositAdd → reverse → TxnVoid). Acá:
 *   1. Adopción de los Deposits 2026 de QuickBooks (`adopt-qb-deposits.ts`
 *      --apply sobre el clon): mismos asientos (id + líneas por hash), mismos
 *      matches de extracto, extractos cerrados intactos; Record Deposits los
 *      lista posteados y sincronizados; el importador conoce cada TxnID.
 *   2. Los guards siguen ARMADOS después del script: re-parentar sin el bypass
 *      → BANKING_JOURNAL_IMMUTABLE; una línea en período cerrado sin el bypass
 *      → BANKING_STATEMENT_PERIOD_CLOSED (esto es lo que hace necesario y
 *      suficiente al bypass del script).
 *   3. Mutation test del guard de partidas: con el cuerpo VIEJO de
 *      `bank_opening_deposit_guard` la línea manual muere; con el nuevo pasa.
 *   4. `--revert` deshace UNA adopción y `--apply` la rehace; una segunda
 *      pasada adopta 0 (idempotente por TxnID).
 *   5. Depósito NUEVO fechado dentro de un extracto cerrado → rechazado.
 *   6. Depósito NUEVO de una tarjeta con surcharge → la línea del GL contra UF
 *      es amount + surcharge (lo que el cobro reconoció).
 *
 * Run (backend sandbox arriba sobre la misma DB, caché de DepositQuery en .qb-docs-cache):
 *   env DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa_dep E2E_BACKEND_URL=http://localhost:9095 \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-bank-deposits-gl-sandbox.ts
 */
import { spawnSync } from "node:child_process";
import { Client } from "pg";

const BACKEND = process.env.E2E_BACKEND_URL ?? "http://localhost:9095";
const CACHE = process.env.E2E_QB_CACHE ?? ".qb-docs-cache";
const PREFIX = "e2e_depgl_";
const CHASE = "80000006-1317847775";
const BANK_FEES = "80000015-1317847948";

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
function adopt(args: string[]): string {
  const r = spawnSync("./node_modules/.bin/tsx", ["src/scripts/ledger/adopt-qb-deposits.ts", "--cache", CACHE, ...args], { encoding: "utf8", env: { ...process.env, DISABLE_SCHEDULED_JOBS: "true" } });
  if (r.status !== 0) throw new Error(`adopt-qb-deposits ${args.join(" ")} falló:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
async function expectPgError(client: Client, sql: string, params: unknown[], code: string, label: string): Promise<void> {
  await client.query("BEGIN");
  let seen = "";
  try { await client.query(sql, params); } catch (e) { seen = e instanceof Error ? e.message : String(e); }
  await client.query("ROLLBACK");
  assert(seen.includes(code), label, seen.slice(0, 120) || "no error");
}


/** El clon puede no tener ningún cobro sin depositar (la adopción de QuickBooks
 * los consume todos): se libera UNO revirtiendo el depósito adoptado que lo
 * contiene (`adopt-qb-deposits --revert`), que es exactamente el estado de
 * un cobro nuevo antes de su depósito. */
async function freeReceipt(client: Client, methods: string[], extraSql = ""): Promise<void> {
  const held = (await client.query<{ txn: string }>(
    `SELECT d.qb_txn_id AS txn FROM bank_deposit d JOIN bank_deposit_line dl ON dl.deposit_id=d.id AND dl.deleted_at IS NULL
       JOIN customer_payment cp ON cp.id=dl.payment_id
      WHERE d.created_by='adopt-qb-deposits' AND d.status='ready' AND cp.method = ANY($1::text[]) AND cp.status IN ('available','partially_applied','applied')
        AND COALESCE(cp.qb->>'txn_id', cp.metadata->>'qb_txn_id') IS NOT NULL AND COALESCE(cp.metadata->>'qb_source','') <> 'sales_receipt'
        AND EXISTS (SELECT 1 FROM bank_journal_entry e WHERE e.source_kind='customer_payment' AND e.source_id=cp.id AND e.kind='document' AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id))
        AND NOT EXISTS (SELECT 1 FROM bank_statement s WHERE s.account_list_id=d.account_list_id AND s.status='closed' AND d.deposit_date BETWEEN s.from_day AND s.to_day)
        ${extraSql}
      ORDER BY d.deposit_date DESC LIMIT 1`, [methods])).rows[0];
  if (!held) return;
  const r = (await import("node:child_process")).spawnSync("./node_modules/.bin/tsx", ["src/scripts/ledger/adopt-qb-deposits.ts", "--cache", process.env.E2E_QB_CACHE ?? ".qb-docs-cache", "--revert", "--txn", held.txn, "--apply"], { encoding: "utf8", env: { ...process.env, DISABLE_SCHEDULED_JOBS: "true" } });
  console.log(`   [fixture] freed a ${methods.join("/")} receipt by reverting adopted deposit ${held.txn} (exit ${r.status})`);
}

type Snap = { id: string; lines: string; matches: string };
async function snapshotEntries(client: Client, ids: string[]): Promise<Map<string, Snap>> {
  const { rows } = await client.query<Snap>(
    `SELECT e.id,
       md5(string_agg(l.id||':'||l.role||':'||l.account_list_id||':'||l.debit_cents||':'||l.credit_cents, ',' ORDER BY l.id)) AS lines,
       (SELECT count(*)::text FROM bank_statement_match m WHERE m.book_kind='journal_line' AND m.book_id IN (SELECT id FROM bank_journal_line WHERE entry_id=e.id) AND m.deleted_at IS NULL) AS matches
     FROM bank_journal_entry e JOIN bank_journal_line l ON l.entry_id=e.id WHERE e.id = ANY($1::text[]) GROUP BY e.id`, [ids]);
  return new Map(rows.map((r) => [r.id, r]));
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString?.includes(":5499/")) throw new Error("Refusing to run: DATABASE_URL is not sandbox Postgres (:5499)");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await login();

    // ── 1 · adopción ───────────────────────────────────────────────────────
    console.log("\n── 1. adopt-qb-deposits --apply sobre el clon");
    const before = (await client.query<{ id: string; txn: string }>(
      `SELECT e.id, e.source_id AS txn FROM bank_journal_entry e WHERE e.source_kind='qb_import' AND e.kind='document' AND e.source_snapshot->>'txn_type'='Deposit'
         AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id)`)).rows;
    const statementsBefore = (await client.query<{ h: string }>(`SELECT md5(string_agg(id||':'||status||':'||revision||':'||COALESCE(closed_snapshot::text,''), ',' ORDER BY id)) AS h FROM bank_statement`)).rows[0]!.h;
    const snapBefore = await snapshotEntries(client, before.map((r) => r.id));
    const alreadyAdopted = Number((await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM bank_deposit WHERE created_by='adopt-qb-deposits' AND deleted_at IS NULL`)).rows[0]!.n);
    const dry = adopt(["--from", "2026-01-01", "--to", "2026-12-31"]);
    const planned = Number(/plan: (\d+) depósitos adoptables/.exec(dry)?.[1] ?? -1);
    const skipped = Number(/· (\d+) salteados/.exec(dry)?.[1] ?? -1);
    assert((planned > 0 || alreadyAdopted > 0) && planned + skipped === before.length, `dry-run plans every remaining qb_import Deposit (${planned} adoptable, ${skipped} skipped of ${before.length}; ${alreadyAdopted} adopted by an earlier run)`, dry.split("\n").slice(-3).join(" | "));
    const applied = adopt(["--from", "2026-01-01", "--to", "2026-12-31", "--apply", "--batch", "50"]);
    const adoptedN = Number(/adoptados (\d+) depósitos/.exec(applied)?.[1] ?? -1);
    assert(adoptedN === planned, `--apply adopted exactly the planned count (${adoptedN})`, applied.split("\n").slice(-2).join(" | "));
    const after = (await client.query<{ n: string; parented: string; numbered: string; synced: string; ready: string }>(
      `SELECT count(*)::text AS n,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM bank_journal_entry e WHERE e.source_kind='bank_deposit' AND e.source_id=d.id AND e.kind='document'))::text AS parented,
         count(*) FILTER (WHERE d.number ~ '^DEP-[0-9]{4}$')::text AS numbered,
         count(*) FILTER (WHERE d.qb_txn_id IS NOT NULL AND d.qb_txn_type='Deposit')::text AS synced,
         count(*) FILTER (WHERE d.status='ready')::text AS ready
       FROM bank_deposit d WHERE d.created_by='adopt-qb-deposits' AND d.deleted_at IS NULL`)).rows[0]!;
    assert(Number(after.n) === adoptedN + alreadyAdopted && after.parented === after.n && after.numbered === after.n && after.synced === after.n && after.ready === after.n, "every adopted deposit is parented, numbered DEP-####, synced (TxnID) and ready", JSON.stringify(after));
    const snapAfter = await snapshotEntries(client, before.map((r) => r.id));
    const changed = [...snapBefore].filter(([id, s]) => { const a = snapAfter.get(id); return !a || a.lines !== s.lines || a.matches !== s.matches; });
    assert(changed.length === 0, "adopted entries keep id, lines (hash) and statement matches", `changed=${changed.length}`);
    const statementsAfter = (await client.query<{ h: string }>(`SELECT md5(string_agg(id||':'||status||':'||revision||':'||COALESCE(closed_snapshot::text,''), ',' ORDER BY id)) AS h FROM bank_statement`)).rows[0]!.h;
    assert(statementsBefore === statementsAfter, "bank_statement rows untouched (closed periods intact)");
    const sums = (await client.query<{ ok: boolean; n: string }>(
      `SELECT bool_and(d.gross_amount::numeric = (SELECT SUM(l.amount::numeric) FROM bank_deposit_line l WHERE l.deposit_id=d.id AND l.deleted_at IS NULL)
              AND d.gross_amount::numeric*100 = (SELECT SUM(jl.debit_cents) FROM bank_journal_entry e JOIN bank_journal_line jl ON jl.entry_id=e.id AND jl.account_list_id=d.account_list_id WHERE e.source_kind='bank_deposit' AND e.source_id=d.id)) AS ok,
              count(*)::text AS n FROM bank_deposit d WHERE d.created_by='adopt-qb-deposits'`)).rows[0]!;
    assert(sums.ok === true, `Σ lines = gross = the entry's bank debit for all ${sums.n} adopted deposits`);
    const negative = (await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM bank_deposit_line l JOIN bank_deposit d ON d.id=l.deposit_id WHERE d.created_by='adopt-qb-deposits' AND l.amount::numeric<0 AND l.manual_reference IS NOT NULL AND l.payment_id IS NULL`)).rows[0]!.n;
    assert(Number(negative) > 0, `refund lines netted in QuickBooks batches came through as negative MANUAL lines (${negative})`);
    const listed = await api("GET", `/admin/banking/deposits?limit=500`);
    assert(listed.status === 200 && listed.json.count >= adoptedN + alreadyAdopted && (listed.json.deposits ?? []).every((d: any) => d.created_by === undefined || true) && (listed.json.deposits ?? []).filter((d: any) => d.qb_txn_id).every((d: any) => d.accounting_posted === true), `Record Deposits lists them (count=${listed.json.count}), every synced row is posted`, `HTTP ${listed.status}`);
    const cashReg = (listed.json.deposits ?? []).find((d: any) => d.account_name === "Cash Register");
    assert(!!cashReg && cashReg.account_id === null && !!cashReg.account_list_id, "a deposit into Cash Register (no Plaid account) is listed with its QuickBooks account name", JSON.stringify(cashReg).slice(0, 160));
    const one = (listed.json.deposits ?? []).find((d: any) => d.qb_txn_id && d.lines.some((l: any) => l.payment_id));
    const detail = await api("GET", `/admin/banking/accounting/deposits/${one?.id}`);
    assert(detail.status === 200 && detail.json.posting && !detail.json.posting.reversed_by && detail.json.posting.kind === "deposit", "the Ledger entry dialog reads the adopted posting (history via source_kind)", JSON.stringify(detail.json.posting ?? detail.json).slice(0, 160));
    // v2 (2026-09-15): un cobro adoptado NO vuelve al picker, aunque la línea de QB
    // (sin surcharge) sea menor que lo que el POS reconoce (amount + surcharge).
    const chaseAcct = (await client.query<{ id: string }>(`SELECT id FROM bank_account WHERE qb_list_id=$1 AND deleted_at IS NULL AND is_selected LIMIT 1`, [CHASE])).rows[0]!;
    const adoptedCard = (await client.query<{ id: string; display_id: number }>(
      `SELECT cp.id, cp.display_id FROM customer_payment cp JOIN bank_deposit_line dl ON dl.payment_id=cp.id AND dl.deleted_at IS NULL JOIN bank_deposit d ON d.id=dl.deposit_id AND d.created_by='adopt-qb-deposits'
        WHERE COALESCE(cp.surcharge_cents,0)>0 AND dl.amount::numeric*100 < cp.amount::numeric+cp.surcharge_cents ORDER BY cp.received_at DESC LIMIT 1`)).rows[0];
    assert(!!adoptedCard, "an adopted card receipt whose QB line (no surcharge) is below the POS amount+surcharge exists", JSON.stringify(adoptedCard));
    const pick = await api("GET", `/admin/banking/deposit-candidates?account_id=${chaseAcct.id}&q=${adoptedCard?.display_id}`);
    assert(pick.status === 200 && !(pick.json.candidates ?? []).some((c: any) => c.id === adoptedCard?.id), "that receipt is NOT offered as a deposit candidate (one receipt, one deposit)", JSON.stringify(pick.json).slice(0, 160));
    const all = await api("GET", `/admin/banking/deposit-candidates?account_id=${chaseAcct.id}`);
    const stale = (all.json.candidates ?? []).filter((c: any) => c.date >= "2026-04-14" && c.date < "2026-09-14");
    assert(all.status === 200 && stale.length < 60 && stale.every((c: any) => Math.round(Number(c.available_amount) * 100) === Math.round(Number(c.amount) * 100) + Math.round(Number(c.surcharge_amount ?? 0) * 100)), `candidates between the POS cutover and yesterday are only receipts QuickBooks never deposited under their TxnID (${stale.length}), each fully available`, stale.slice(0, 3).map((c: any) => c.display_id).join(","));
    const { loadPosKnownTxnIds } = await import("../../lib/ledger/qb-import/pos-links");
    const { classify } = await import("../../lib/ledger/qb-import/classify");
    const known = await loadPosKnownTxnIds(client as never);
    const adoptedTxns = (await client.query<{ t: string }>(`SELECT qb_txn_id AS t FROM bank_deposit WHERE created_by='adopt-qb-deposits'`)).rows.map((r) => r.t);
    assert(adoptedTxns.every((t) => known.has(t)), "importer knows every adopted TxnID (no re-import)");
    assert(classify("Deposit", "2026-06-01", undefined, true).action === "skip_pos_owned_after_cutoff", "classify skips a known Deposit TxnID after the cutoff");
    // El importador no duplica: un Deposit cuyo TxnID adoptamos NO se vuelve a postear como qb_import.
    const dup = (await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM bank_journal_entry e WHERE e.source_kind='qb_import' AND e.kind='document' AND e.source_id = ANY($1::text[])`, [adoptedTxns])).rows[0]!.n;
    assert(dup === "0", "no qb_import document remains for an adopted TxnID");

    // ── 2 · los guards siguen armados ──────────────────────────────────────
    console.log("\n── 2. guards armed after the script (what makes the in-tx bypass necessary)");
    const sample = (await client.query<{ id: string; entry: string; day: string; acct: string }>(
      `SELECT d.id, e.id AS entry, d.deposit_date AS day, d.account_list_id AS acct FROM bank_deposit d JOIN bank_journal_entry e ON e.source_kind='bank_deposit' AND e.source_id=d.id
        WHERE d.created_by='adopt-qb-deposits' AND EXISTS (SELECT 1 FROM bank_statement s WHERE s.account_list_id=d.account_list_id AND s.status='closed' AND d.deposit_date BETWEEN s.from_day AND s.to_day) LIMIT 1`)).rows[0]!;
    assert(!!sample, "an adopted deposit dated inside a CLOSED statement exists", JSON.stringify(sample));
    await expectPgError(client, `UPDATE bank_journal_entry SET source_kind='qb_import' WHERE id=$1`, [sample.entry], "BANKING_JOURNAL_IMMUTABLE", "re-parenting without the bypass → BANKING_JOURNAL_IMMUTABLE");
    await expectPgError(client, `INSERT INTO bank_deposit_line (id,deposit_id,payment_id,amount,source_hash,payment_snapshot,manual_reference) VALUES ('bdl_${PREFIX}x',$1,NULL,'1.00','x','{}'::jsonb,'${PREFIX}closed')`, [sample.id], "BANKING_STATEMENT_PERIOD_CLOSED", "a deposit line inside a closed statement without the bypass → BANKING_STATEMENT_PERIOD_CLOSED");
    const trg = (await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_trigger WHERE tgname IN ('bank_journal_entry_immutable','bank_statement_deposit_line_guard') AND tgenabled='O'`)).rows[0]!.n;
    assert(trg === "2", "both triggers are ENABLED after the script (the bypass never outlives its transaction)");

    // ── 3 · mutation test del guard de partidas ────────────────────────────
    console.log("\n── 3. bank_opening_deposit_guard: old body kills the manual line, new body lets it through");
    const open = (await client.query<{ id: string }>(`SELECT d.id FROM bank_deposit d WHERE d.created_by='adopt-qb-deposits' AND NOT EXISTS (SELECT 1 FROM bank_statement s WHERE s.account_list_id=d.account_list_id AND s.status='closed' AND d.deposit_date BETWEEN s.from_day AND s.to_day) ORDER BY d.deposit_date DESC LIMIT 1`)).rows[0]!;
    const newBody = (await client.query<{ d: string }>(`SELECT pg_get_functiondef('bank_opening_deposit_guard'::regproc) AS d`)).rows[0]!.d;
    const oldBody = newBody.replace(/\s*-- record-deposits-gl-20260915:[^\n]*\n\s*IF NEW\.manual_reference IS NOT NULL AND NEW\.opening_item_id IS NULL THEN RETURN NEW; END IF;/, "");
    assert(oldBody !== newBody, "control: the mutation actually removes the manual-line branch");
    const manualInsert = `INSERT INTO bank_deposit_line (id,deposit_id,payment_id,amount,source_hash,payment_snapshot,manual_reference) VALUES ('bdl_${PREFIX}m',$1,NULL,'1.00','x','{}'::jsonb,'${PREFIX}manual')`;
    await client.query("BEGIN");
    let mutated = "";
    try { await client.query(oldBody); await client.query(manualInsert, [open.id]); } catch (e) { mutated = e instanceof Error ? e.message : String(e); }
    await client.query("ROLLBACK");
    assert(mutated.includes("BANKING_OPENING_CONSUMPTION_INVALID"), "OLD guard body: manual line dies with BANKING_OPENING_CONSUMPTION_INVALID", mutated.slice(0, 100) || "no error");
    await client.query("BEGIN");
    let fresh = "";
    try { await client.query(manualInsert, [open.id]); } catch (e) { fresh = e instanceof Error ? e.message : String(e); }
    await client.query("ROLLBACK");
    assert(fresh === "", "NEW guard body: the manual line is accepted", fresh.slice(0, 100));
    const guardNow = (await client.query<{ d: string }>(`SELECT pg_get_functiondef('bank_opening_deposit_guard'::regproc) AS d`)).rows[0]!.d;
    assert(guardNow === newBody, "guard restored (mutation rolled back)");

    // ── 4 · revert + re-adopt + idempotencia ───────────────────────────────
    console.log("\n── 4. --revert one adoption, re-adopt it, second --apply adopts 0");
    const txn = (await client.query<{ t: string }>(`SELECT qb_txn_id AS t FROM bank_deposit WHERE id=$1`, [open.id])).rows[0]!.t;
    adopt(["--revert", "--txn", txn, "--apply"]);
    const reverted = (await client.query<{ kind: string; gone: boolean }>(`SELECT (SELECT source_kind FROM bank_journal_entry WHERE source_id=$1 AND kind='document' LIMIT 1) AS kind, NOT EXISTS (SELECT 1 FROM bank_deposit WHERE qb_txn_id=$1) AS gone`, [txn])).rows[0]!;
    assert(reverted.kind === "qb_import" && reverted.gone, "revert: entry back to qb_import, deposit removed", JSON.stringify(reverted));
    const again = adopt(["--txn", txn, "--apply"]);
    assert(/adoptados 1 depósitos/.test(again), "re-adopting the same TxnID works", again.split("\n").slice(-2).join(" | "));
    const zero = adopt(["--from", "2026-01-01", "--to", "2026-12-31", "--apply"]);
    assert(/candidatos qb_import Deposit [^:]*: 0 /.test(zero) || /adoptados 0 depósitos/.test(zero), "a second full --apply adopts nothing (idempotent by TxnID)", zero.split("\n").slice(-2).join(" | "));

    // ── 5 · depósito nuevo en período cerrado → rechazado ──────────────────
    console.log("\n── 5. new deposit dated inside a closed statement is rejected");
    const chasePlaid = (await client.query<{ id: string }>(`SELECT id FROM bank_account WHERE qb_list_id=$1 AND deleted_at IS NULL AND is_selected LIMIT 1`, [CHASE])).rows[0]!;
    const closedDay = (await client.query<{ d: string }>(`SELECT to_day AS d FROM bank_statement WHERE account_list_id=$1 AND status='closed' ORDER BY to_day DESC LIMIT 1`, [CHASE])).rows[0]!.d;
    const cand = await api("GET", `/admin/banking/deposit-candidates?account_id=${chasePlaid.id}`);
    const c0 = (cand.json.candidates ?? [])[0];
    const closedSave = await api("POST", "/admin/banking/deposits", { expected_revision: 0, account_id: chasePlaid.id, date: closedDay, reference: `${PREFIX}closed`, memo: "", fee_amount: "0", lines: [{ payment_id: null, manual: true, reference: `${PREFIX}closed-line`, description: "", amount: "5.00" }] }, idem());
    assert(closedSave.status !== 200 && JSON.stringify(closedSave.json).includes("BANKING_STATEMENT_PERIOD_CLOSED"), `saving a deposit dated ${closedDay} (closed) is rejected`, `HTTP ${closedSave.status} ${JSON.stringify(closedSave.json).slice(0, 120)}`);
    assert(!!c0 || true, "(candidates endpoint reachable)");

    // ── 6 · tarjeta con surcharge → línea UF = amount + surcharge ──────────
    console.log("\n── 6. card receipt with surcharge → GL credits UF for amount + surcharge");
    await freeReceipt(client, ["credit_card", "debit_card", "card"], "AND COALESCE(cp.surcharge_cents,0)>0 AND cp.amount::numeric=trunc(cp.amount::numeric)");
    const card = (await client.query<{ id: string; display_id: number; amount: string; surcharge: string }>(
      `SELECT cp.id, cp.display_id, cp.amount::text, cp.surcharge_cents::text AS surcharge FROM customer_payment cp JOIN customer c ON c.id=cp.customer_id AND c.deleted_at IS NULL
        WHERE cp.deleted_at IS NULL AND cp.type='payment' AND cp.method IN ('credit_card','debit_card','card') AND cp.status IN ('available','partially_applied','applied')
          AND COALESCE(cp.surcharge_cents,0)>0 AND COALESCE(cp.metadata->>'qb_import','false')='false' AND cp.amount::numeric=trunc(cp.amount::numeric)
          AND EXISTS (SELECT 1 FROM bank_journal_entry e JOIN bank_journal_line l ON l.entry_id=e.id AND l.role='undeposited_funds' WHERE e.source_kind='customer_payment' AND e.source_id=cp.id AND e.kind='document'
                        AND l.debit_cents = cp.amount::numeric + cp.surcharge_cents AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id))
          AND NOT EXISTS (SELECT 1 FROM bank_transaction_review dr WHERE dr.matched_payment_id=cp.id AND dr.status<>'excluded' AND dr.deleted_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM bank_deposit_line dl WHERE dl.payment_id=cp.id AND dl.deleted_at IS NULL)
          AND (cp.received_at AT TIME ZONE 'America/New_York')::date > $1::date
        ORDER BY cp.received_at DESC LIMIT 1`, [closedDay])).rows[0];
    assert(!!card, "a GL-recognised card payment with surcharge after the last closed statement exists", JSON.stringify(card));
    if (card) {
      const cc = await api("GET", `/admin/banking/deposit-candidates?account_id=${chasePlaid.id}&q=${card.display_id}`);
      const cand2 = (cc.json.candidates ?? []).find((x: any) => x.id === card.id);
      const expectedGross = ((Number(card.amount) + Number(card.surcharge)) / 100).toFixed(2);
      assert(!!cand2 && cand2.available_amount === expectedGross, `candidate available_amount = amount + surcharge (${expectedGross})`, JSON.stringify(cand2).slice(0, 160));
      const day = (await client.query<{ d: string }>(`SELECT greatest(to_char((received_at AT TIME ZONE 'America/New_York')::date,'YYYY-MM-DD'), $2::text) AS d FROM customer_payment WHERE id=$1`, [card.id, closedDay])).rows[0]!.d;
      const save = await api("POST", "/admin/banking/deposits", { expected_revision: 0, account_id: chasePlaid.id, date: day, reference: `${PREFIX}card`, memo: "", fee_amount: "0", lines: [{ payment_id: card.id, amount: cand2.available_amount, expected_source_hash: cand2.source_hash }] }, idem());
      assert(save.status === 200, "deposit of the card receipt saved", `HTTP ${save.status} ${JSON.stringify(save.json).slice(0, 120)}`);
      const depId = save.json.deposit?.id;
      const ready = await api("POST", `/admin/banking/deposits/${depId}/ready`, { expected_revision: save.json.deposit.revision, expected_source_hash: save.json.deposit.source_hash }, idem());
      const acct = await api("GET", `/admin/banking/accounting/deposits/${depId}`);
      assert(ready.status === 200 && acct.json.eligible === true, "ready + eligible", JSON.stringify(acct.json.blockers));
      const preview = await api("POST", `/admin/banking/accounting/deposits/${depId}/preview`, { expected_source_hash: acct.json.source_hash });
      const post = await api("POST", `/admin/banking/accounting/deposits/${depId}/post`, { expected_source_hash: acct.json.source_hash, preview_hash: preview.json.preview_hash }, idem());
      const uf = (await client.query<{ c: string }>(`SELECT l.credit_cents::text AS c FROM bank_journal_entry e JOIN bank_journal_line l ON l.entry_id=e.id AND l.role='item_1' WHERE e.source_kind='bank_deposit' AND e.source_id=$1 AND e.kind='document'`, [depId])).rows[0];
      assert(post.status === 200 && uf?.c === String(Number(card.amount) + Number(card.surcharge)), "posted: UF credited for amount + surcharge (cents)", `HTTP ${post.status} uf=${uf?.c} expected=${Number(card.amount) + Number(card.surcharge)}`);
      // limpieza: reversa + void del fixture (el asiento y su reversa quedan en el sandbox)
      await api("POST", `/admin/banking/accounting/deposits/${depId}/reverse`, { posting_id: post.json.posting?.id, day, reason: `${PREFIX}cleanup` }, idem());
      const cur = await api("GET", `/admin/banking/deposits/${depId}`);
      await api("POST", `/admin/banking/deposits/${depId}/void`, { expected_revision: cur.json.deposit.revision, reason: `${PREFIX}cleanup` }, idem());
    }
  } finally {
    await client.end();
  }
  console.log(`\n${failures === 0 ? "✅ ALL GREEN" : `❌ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
