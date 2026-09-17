/**
 * E2E — Void de un depósito POSTEADO en un solo gesto (deposit-void-one-gesture-20260917), SANDBOX.
 *
 * Antes: anular un depósito con asiento vivo exigía pasar por "Ledger entry →
 * Reverse posted deposit" y recién después "Void deposit" (dos diálogos, y el
 * botón de void escondido). Ahora `POST /admin/banking/deposits/:id/void`
 * reversa el asiento, encola el TxnVoid del Deposit en QuickBooks y anula el
 * depósito en UNA transacción. Acá:
 *   1. Depósito manual → ready → post: asiento `document` vivo + `gl_document_add`.
 *   2. Void directo (sin reverse previo) → 200; status='void'; asiento de reversa
 *      apuntando al original; con el DepositAdd CONFIRMADO (TxnID simulado en
 *      `bank_deposit`, QB apagado en sandbox) → fila `gl_document_void` con el
 *      TxnVoid de ese TxnID; eventos `deposit_reversed` + `deposit_void`.
 *   2b. Add que nunca salió (estado natural del sandbox) → la fila del Add queda
 *      `skipped` y NO se encola ningún TxnVoid (nada que anular en QB).
 *   3. NEGATIVO de permiso: `voidBankDeposit(..., canPost=false)` sobre otro
 *      depósito posteado → BANKING_ACCOUNTING_FORBIDDEN y NADA cambia (status,
 *      revisión, asientos, cola).
 *   4. Un DRAFT se anula sin reversa ni cola (como siempre).
 *   5. Idempotencia: repetir el void con la misma key devuelve el mismo depósito.
 *
 * Run (backend sandbox arriba sobre la misma DB; las conexiones bancarias del clon con
 * environment='sandbox'; ECOPOWERTECH_ENV=sandbox también acá porque §3 llama al helper directo):
 *   env ECOPOWERTECH_ENV=sandbox DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa_depvoid \
 *     E2E_BACKEND_URL=http://localhost:9096 DISABLE_SCHEDULED_JOBS=true \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-bank-deposit-void-one-gesture-sandbox.ts
 */
import { Client } from "pg";

import { voidBankDeposit } from "../../lib/banking/deposit-core";

const BACKEND = process.env.E2E_BACKEND_URL ?? "http://localhost:9096";
const PREFIX = "e2e_depvoid_";

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

type Snap = { status: string; revision: number; live: string; reversals: string; voids: string; adds: string; adds_skipped: string };
async function snap(client: Client, id: string): Promise<Snap> {
  return (await client.query<Snap>(
    `SELECT d.status, d.revision,
       (SELECT count(*)::text FROM bank_journal_entry e WHERE e.source_kind='bank_deposit' AND e.source_id=d.id AND e.kind='document' AND e.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id)) AS live,
       (SELECT count(*)::text FROM bank_journal_entry r JOIN bank_journal_entry e ON e.id=r.reverses_entry_id
          WHERE e.source_kind='bank_deposit' AND e.source_id=d.id) AS reversals,
       (SELECT count(*)::text FROM qb_order_pipeline p WHERE p.reference_id=d.id AND p.step='gl_document_void') AS voids,
       (SELECT count(*)::text FROM qb_order_pipeline p WHERE p.reference_id=d.id AND p.step='gl_document_add') AS adds,
       (SELECT count(*)::text FROM qb_order_pipeline p WHERE p.reference_id=d.id AND p.step='gl_document_add' AND p.status='skipped') AS adds_skipped
     FROM bank_deposit d WHERE d.id=$1`, [id])).rows[0]!;
}
/** Simula que el DepositAdd ya CONFIRMÓ en QuickBooks (el bridge está apagado en sandbox). */
async function confirmAddInQb(client: Client, id: string, txn: string): Promise<void> {
  await client.query(`UPDATE qb_order_pipeline SET status='confirmed', updated_at=now() WHERE reference_id=$1 AND step='gl_document_add'`, [id]);
  await client.query(`UPDATE bank_deposit SET qb_txn_id=$2, qb_txn_type='Deposit', qb_synced_at=now() WHERE id=$1`, [id, txn]);
}

/** Depósito manual (sin cobro detrás) en la cuenta con feed más reciente, fechado HOY (ET). */
async function postedDeposit(client: Client, accountId: string, day: string, tag: string): Promise<{ id: string; revision: number }> {
  const save = await api("POST", "/admin/banking/deposits", { expected_revision: 0, account_id: accountId, date: day, reference: `${PREFIX}${tag}`, memo: "", fee_amount: "0", lines: [{ payment_id: null, manual: true, reference: `${PREFIX}${tag}-line`, description: "", amount: "7.00" }] }, idem());
  assert(save.status === 200, `[${tag}] manual deposit saved`, `HTTP ${save.status} ${JSON.stringify(save.json).slice(0, 160)}`);
  const id: string = save.json.deposit.id;
  const ready = await api("POST", `/admin/banking/deposits/${id}/ready`, { expected_revision: save.json.deposit.revision, expected_source_hash: save.json.deposit.source_hash }, idem());
  const acct = await api("GET", `/admin/banking/accounting/deposits/${id}`);
  assert(ready.status === 200 && acct.json.eligible === true, `[${tag}] ready + eligible`, JSON.stringify(acct.json.blockers ?? acct.json).slice(0, 160));
  const preview = await api("POST", `/admin/banking/accounting/deposits/${id}/preview`, { expected_source_hash: acct.json.source_hash });
  const post = await api("POST", `/admin/banking/accounting/deposits/${id}/post`, { expected_source_hash: acct.json.source_hash, preview_hash: preview.json.preview_hash }, idem());
  const s = await snap(client, id);
  assert(post.status === 200 && s.live === "1" && s.adds === "1", `[${tag}] posted: one live journal entry + one gl_document_add queued`, `HTTP ${post.status} ${JSON.stringify(s)}`);
  const cur = await api("GET", `/admin/banking/deposits/${id}`);
  assert(cur.json.deposit?.accounting_posted === true, `[${tag}] read-back says accounting_posted`);
  return { id, revision: cur.json.deposit.revision };
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await login();
    const acct = (await client.query<{ id: string }>(`SELECT id FROM bank_account WHERE deleted_at IS NULL AND is_selected AND type='depository' AND review_start_date IS NOT NULL ORDER BY created_at LIMIT 1`)).rows[0];
    assert(!!acct, "a depository bank account with review_start_date exists");
    if (!acct) return;
    const day = (await client.query<{ d: string }>(`SELECT to_char((now() AT TIME ZONE 'America/New_York')::date,'YYYY-MM-DD') AS d`)).rows[0]!.d;
    const closed = (await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM bank_statement s JOIN bank_account a ON a.qb_list_id=s.account_list_id WHERE a.id=$1 AND s.status='closed' AND $2::text BETWEEN s.from_day AND s.to_day`, [acct.id, day])).rows[0]!.n;
    assert(closed === "0", `today (${day}) is not inside a closed statement of the fixture account`);

    // ── 1+2 · posted → void in ONE gesture ────────────────────────────────
    console.log("\n── 1+2. posted deposit → POST /void directly (no reverse first)");
    const a = await postedDeposit(client, acct.id, day, "one");
    await confirmAddInQb(client, a.id, `${PREFIX}TXN-ONE`);
    const before = await snap(client, a.id);
    const v = await api("POST", `/admin/banking/deposits/${a.id}/void`, { expected_revision: a.revision, reason: `${PREFIX}one-gesture` }, idem());
    const after = await snap(client, a.id);
    assert(v.status === 200 && v.json.deposit?.status === "void", "void accepted without a prior reverse", `HTTP ${v.status} ${JSON.stringify(v.json).slice(0, 160)}`);
    assert(after.status === "void" && after.live === "0" && after.reversals === "1", "journal entry reversed (0 live, 1 reversal) and deposit void", JSON.stringify(after));
    assert(before.voids === "0" && after.voids === "1", "one gl_document_void queued for QuickBooks (TxnVoid)", `before=${before.voids} after=${after.voids}`);
    const voidRow = (await client.query<{ status: string; payload: { qbxml?: string; qb_txn_id?: string } }>(`SELECT status, payload FROM qb_order_pipeline WHERE reference_id=$1 AND step='gl_document_void' ORDER BY created_at DESC LIMIT 1`, [a.id])).rows[0];
    const xml = String(voidRow?.payload?.qbxml ?? "");
    assert(!!voidRow && xml.includes("<TxnVoidRq>") && xml.includes(`<TxnID>${PREFIX}TXN-ONE</TxnID>`) && xml.includes("<TxnVoidType>Deposit</TxnVoidType>"), "TxnVoid targets the confirmed Deposit TxnID", `${voidRow?.status} ${xml.slice(0, 200)}`);
    const rev = (await client.query<{ day: string; reason: string }>(`SELECT r.day::text, r.reason FROM bank_journal_entry r JOIN bank_journal_entry e ON e.id=r.reverses_entry_id WHERE e.source_kind='bank_deposit' AND e.source_id=$1`, [a.id])).rows[0];
    assert(rev?.day === day && rev?.reason === `${PREFIX}one-gesture`, "reversal dated today with the void reason", JSON.stringify(rev));
    // runReviewCommand registra el comando (idempotency_key) y el void agrega su audit: ambos `deposit_void`; la reversa deja `deposit_reversed`.
    const events = (await client.query<{ action: string }>(`SELECT DISTINCT action FROM bank_review_event WHERE entity_id=$1 AND action IN ('deposit_reversed','deposit_void') ORDER BY action`, [a.id])).rows.map((r) => r.action);
    assert(events.join(",") === "deposit_reversed,deposit_void", "audit: deposit_reversed + deposit_void recorded", events.join(","));

    // ── 2b · Add que nunca salió → skipped, sin TxnVoid ───────────────────
    console.log("\n── 2b. posted deposit whose DepositAdd never left → add row skipped, no TxnVoid");
    const u = await postedDeposit(client, acct.id, day, "unsent");
    const vu = await api("POST", `/admin/banking/deposits/${u.id}/void`, { expected_revision: u.revision, reason: `${PREFIX}unsent` }, idem());
    const su = await snap(client, u.id);
    assert(vu.status === 200 && su.status === "void" && su.reversals === "1" && su.voids === "0" && su.adds_skipped === "1", "void ok: journal reversed, Add row skipped, nothing queued for QB", `HTTP ${vu.status} ${JSON.stringify(su)}`);
    assert(v.json.deposit?.accounting_posted === false, "read-back: accounting_posted=false after the void");

    // ── 5 · idempotencia ───────────────────────────────────────────────────
    console.log("\n── 5. same idempotency key replays the same result");
    const key = idem();
    const b = await postedDeposit(client, acct.id, day, "idem");
    await confirmAddInQb(client, b.id, `${PREFIX}TXN-IDEM`);
    const v1 = await api("POST", `/admin/banking/deposits/${b.id}/void`, { expected_revision: b.revision, reason: `${PREFIX}idem` }, key);
    const v2 = await api("POST", `/admin/banking/deposits/${b.id}/void`, { expected_revision: b.revision, reason: `${PREFIX}idem` }, key);
    const sb = await snap(client, b.id);
    assert(v1.status === 200 && v2.status === 200 && v2.json.deposit?.revision === v1.json.deposit?.revision, "replay returns the same deposit", `HTTP ${v1.status}/${v2.status}`);
    assert(sb.reversals === "1" && sb.voids === "1", "replay did not reverse twice nor queue a second TxnVoid", JSON.stringify(sb));

    // ── 3 · negativo: sin `post` no se reversa nada ────────────────────────
    console.log("\n── 3. NEGATIVE: voidBankDeposit(canPost=false) on a posted deposit → 403, nothing changes");
    const c = await postedDeposit(client, acct.id, day, "noperm");
    await confirmAddInQb(client, c.id, `${PREFIX}TXN-NOPERM`);
    const s0 = await snap(client, c.id);
    let code = "";
    try {
      await voidBankDeposit(c.id, "e2e-no-post", `${PREFIX}noperm-${Date.now()}`, { expected_revision: c.revision, reason: `${PREFIX}noperm` }, false);
    } catch (e) { code = e instanceof Error ? e.message : String(e); }
    const s1 = await snap(client, c.id);
    assert(code === "BANKING_ACCOUNTING_FORBIDDEN", "rejected with BANKING_ACCOUNTING_FORBIDDEN", code || "no error");
    assert(JSON.stringify(s0) === JSON.stringify(s1) && s1.status === "ready" && s1.live === "1" && s1.voids === "0", "status, revision, journal and queue untouched", JSON.stringify(s1));
    // control positivo del mismo helper: con canPost=true sí anula
    const ok = await voidBankDeposit(c.id, "e2e-post", `${PREFIX}perm-${Date.now()}`, { expected_revision: c.revision, reason: `${PREFIX}cleanup` }, true);
    const s2 = await snap(client, c.id);
    assert(ok.deposit.status === "void" && s2.reversals === "1" && s2.voids === "1", "control: canPost=true voids + reverses + queues", JSON.stringify(s2));

    // ── 4 · draft: void sin reversa ni cola ────────────────────────────────
    console.log("\n── 4. draft deposit voids as before: no reversal, no gl_document_void");
    const save = await api("POST", "/admin/banking/deposits", { expected_revision: 0, account_id: acct.id, date: day, reference: `${PREFIX}draft`, memo: "", fee_amount: "0", lines: [{ payment_id: null, manual: true, reference: `${PREFIX}draft-line`, description: "", amount: "3.00" }] }, idem());
    const d = save.json.deposit;
    const vd = await api("POST", `/admin/banking/deposits/${d.id}/void`, { expected_revision: d.revision, reason: `${PREFIX}draft-void` }, idem());
    const sd = await snap(client, d.id);
    assert(vd.status === 200 && sd.status === "void" && sd.reversals === "0" && sd.voids === "0" && sd.adds === "0", "draft void: status void, nothing in the ledger or the queue", `HTTP ${vd.status} ${JSON.stringify(sd)}`);
  } finally {
    // los fixtures quedan void en el sandbox (asiento + reversa son historia, no se borran)
    await client.end();
  }
  console.log(`\n${failures === 0 ? "✅ ALL GREEN" : `❌ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
