/**
 * e2e-bank-card-statements-sandbox.ts — extractos de TARJETA (QuickBooks `CreditCard`,
 * Plaid `credit`) por el mismo motor que los bancos (plan card-statements-20260914).
 *
 * Corre contra una DB sandbox DESECHABLE (clon de una copia de prod con las migraciones
 * aplicadas) — no limpia: cada corrida usa fixtures con sufijo propio y el clon se descarta. Todo pasa por las mismas funciones de
 * lib/banking y lib/ledger que usa la UI; nada de SQL directo sobre Banking salvo los
 * fixtures de feed (bank_connection/bank_account/bank_transaction en entorno sandbox).
 *
 *   ECOPOWERTECH_ENV=sandbox GL_POSTING_ENABLED=true \
 *   DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa_cards' \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-bank-card-statements-sandbox.ts
 *
 * Qué prueba (todo en signo GL: pasivo negativo, cargo = línea negativa, pago positiva):
 *   1. Apertura de tarjeta al 31/01 (owed $500 → línea `opening` −50.000) ancla el extracto
 *      31/01→28/02 (el primer extracto EMPIEZA el día del corte, como los de los bancos).
 *   2. Cargos y pago de febrero como asientos; extracto de febrero desde el "feed" sandbox;
 *      casamiento; preview con diferencia 0 y el cargo sin línea como outstanding; cierre.
 *   3. NEGATIVO: un asiento sobre la tarjeta fechado dentro del mes cerrado →
 *      BANKING_STATEMENT_PERIOD_CLOSED (bank_statement_journal_guard); en marzo pasa.
 *   4. Feed: las líneas casadas salen `review_status='reconciled'` y desaparecen de "To review".
 */
import assert from "node:assert/strict";
import type { PoolClient } from "pg";

import { getDbPool } from "../../api/utils/db-pool";
import { bankingTransactions } from "../../lib/banking/views";
import { requireBankingSandbox } from "../../lib/banking/security";
import { closeStatement, previewStatement, saveStatement } from "../../lib/banking/statement-core";
import { matchStatement } from "../../lib/banking/statement-matching";
import { addCompletionEvidence } from "../../lib/banking/completion-evidence";
import { createJournalEntry, postJournalEntry } from "../../lib/ledger/documents/journal-entry";
import { postOpeningBalance } from "../../lib/ledger/documents/opening-balance";
import { addOpeningBalanceEvidence } from "../../lib/ledger/opening-evidence";

// One fixture set per RUN: a closed statement can never be deleted (guard), so re-running
// against the same clone needs a fresh card. The clone accumulates and is thrown away.
const RUN = Date.now().toString(36);
const PREFIX = `e2e_card_${RUN}_`;
const CARD_LIST_ID = `${PREFIX}visa_qb`;
const CONNECTION = `${PREFIX}conn`;
const ACCOUNT = `${PREFIX}acct`;
const ACTOR = "e2e-card-statements";
// The first statement STARTS on the cut day (the opening line is dated there and is always
// cleared), exactly like the banks' `1221_2025-12-31_2026-01-31` statements.
const CUT = "2026-01-31", FROM = CUT, TO = "2026-02-28";
const OWED_AT_CUT = 50000n; // $500 owed → GL −50.000
const CHARGE_A = 12345, CHARGE_B = 6789, OUTSTANDING = 4321, PAYMENT = 30000;

let checks = 0;
const check = (ok: boolean, label: string) => { assert(ok, label); checks++; console.log(`  ✓ ${label}`); };
const key = (...parts: string[]) => `${PREFIX}${parts.join(":")}`;
const tinyPdf = () => Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"
).toString("base64");

async function seed(client: PoolClient) {
  const expense = (await client.query<{ qb_list_id: string }>(
    `SELECT qb_list_id FROM qb_account WHERE account_type='Expense' AND is_active AND deleted_at IS NULL ORDER BY qb_list_id LIMIT 1`
  )).rows[0]; assert(expense, "an active Expense account exists");
  const bank = (await client.query<{ qb_list_id: string }>(
    `SELECT q.qb_list_id FROM qb_account q WHERE q.account_type='Bank' AND q.is_active AND q.deleted_at IS NULL
       AND NOT EXISTS(SELECT 1 FROM bank_statement s WHERE s.account_list_id=q.qb_list_id AND s.status='closed') ORDER BY q.qb_list_id LIMIT 1`
  )).rows[0]; assert(bank, "a Bank account without closed statements exists (pays the card)");
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO qb_account(id,qb_list_id,full_name,name,account_type,currency,is_active,normal_balance,last_synced_at)
     VALUES($1,$1,'E2E Visa Card','E2E Visa Card','CreditCard',NULL,true,'credit',now())`, [CARD_LIST_ID]);
  await client.query(
    `INSERT INTO bank_connection(id,provider,environment,provider_item_id,status,initial_sync_complete,historical_sync_complete,last_successful_sync_at)
     VALUES($1,'plaid','sandbox',$1,'active',true,true,now())`, [CONNECTION]);
  await client.query(
    `INSERT INTO bank_account(id,connection_id,provider_account_id,name,mask,type,subtype,currency,is_selected,qb_list_id,setup_revision)
     VALUES($1,$2,$1,'E2E Visa Card','9999','credit','credit card','USD',true,$3,1)`, [ACCOUNT, CONNECTION, CARD_LIST_ID]);
  await client.query("COMMIT");
  return { expense: expense.qb_list_id, bank: bank.qb_list_id };
}

async function feedRow(client: PoolClient, suffix: string, plaidAmount: number, day: string, name: string) {
  const id = `${PREFIX}txn_${suffix}`;
  await client.query(
    `INSERT INTO bank_transaction(id,connection_id,account_id,provider_transaction_id,amount,currency,status,transaction_date,name,source_data,first_seen_at,last_seen_at)
     VALUES($1,$2,$3,$1,$4::numeric,'USD','posted',$5,$6,'{}',now(),now())`,
    [id, CONNECTION, ACCOUNT, (plaidAmount / 100).toFixed(2), day, name]);
  return id;
}

async function cardEntry(client: PoolClient, day: string, cents: number, other: string, charge: boolean, memo: string) {
  const lines = charge
    ? [{ account_list_id: other, debit_cents: BigInt(cents), credit_cents: 0n, memo }, { account_list_id: CARD_LIST_ID, debit_cents: 0n, credit_cents: BigInt(cents), memo }]
    : [{ account_list_id: CARD_LIST_ID, debit_cents: BigInt(cents), credit_cents: 0n, memo }, { account_list_id: other, debit_cents: 0n, credit_cents: BigInt(cents), memo }];
  const draft = await createJournalEntry(client, { day, memo, evidence_id: null, lines }, ACTOR);
  const posted = await postJournalEntry(client, draft.id, ACTOR);
  assert(posted.status === "posted", `${memo} posted`);
  return posted.entry_id;
}

async function main() {
  requireBankingSandbox();
  assert(process.env.GL_POSTING_ENABLED === "true", "GL_POSTING_ENABLED=true (the ledger must post)");
  const pool = getDbPool(), client = await pool.connect();
  try {
    const fn = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_proc WHERE proname IN ('bank_statement_match_capacity','bank_statement_check_close','bank_statement_journal_guard')
         AND pg_get_functiondef(oid) LIKE '%CreditCard%'`);
    check(fn.rows[0]?.n === "3", "the 3 Postgres functions were reinstalled with CreditCard (migration applied)");
    const { expense, bank } = await seed(client);

    // 1. Opening at the cut: $500 owed → credit line 50.000 on the card (GL −50.000).
    const openingEvidence = await addOpeningBalanceEvidence(client, ACTOR, { name: "e2e-card-opening.pdf", mime_type: "application/pdf", content_base64: tinyPdf() });
    const opening = await postOpeningBalance(client, { account_list_id: CARD_LIST_ID, day: CUT, balance_cents: OWED_AT_CUT, evidence_ids: [openingEvidence.id], items: [], actor_id: ACTOR });
    assert(opening.status === "posted");
    const openingLine = (await client.query<{ signed: string }>(
      `SELECT (l.debit_cents-l.credit_cents)::text AS signed FROM bank_journal_line l WHERE l.entry_id=$1 AND l.role='opening'`, [opening.entry_id])).rows[0];
    check(openingLine?.signed === "-50000", "card opening line is −50.000 (liability in GL sign)");

    // 2. February activity as GL documents, and its feed.
    const entryA = await cardEntry(client, "2026-02-03", CHARGE_A, expense, true, "E2E card charge A");
    const entryB = await cardEntry(client, "2026-02-10", CHARGE_B, expense, true, "E2E card charge B");
    const entryPay = await cardEntry(client, "2026-02-20", PAYMENT, bank, false, "E2E card payment");
    const entryOut = await cardEntry(client, "2026-02-25", OUTSTANDING, expense, true, "E2E card charge not yet on the statement");
    await cardEntry(client, "2026-03-02", 999, expense, true, "E2E March charge (outside the period)");
    const txnA = await feedRow(client, "a", CHARGE_A, "2026-02-03", "E2E MERCHANT A");
    const txnB = await feedRow(client, "b", CHARGE_B, "2026-02-10", "E2E MERCHANT B");
    const txnPay = await feedRow(client, "pay", -PAYMENT, "2026-02-20", "E2E ONLINE PAYMENT - THANK YOU");
    const evidence = await addCompletionEvidence(ACTOR, key("evidence"), { name: "e2e-card-feb.pdf", mime_type: "application/pdf", content_base64: tinyPdf() });

    // Statement in GL sign: charges negative, payment positive; closing = opening + credits − debits.
    const openingCents = -Number(OWED_AT_CUT), credits = PAYMENT, debits = CHARGE_A + CHARGE_B;
    const closingCents = openingCents + credits - debits;
    const lines = [
      { external_key: "feb-a", day: "2026-02-03", amount_cents: -CHARGE_A, description: "E2E MERCHANT A", transaction_id: txnA },
      { external_key: "feb-b", day: "2026-02-10", amount_cents: -CHARGE_B, description: "E2E MERCHANT B", transaction_id: txnB },
      { external_key: "feb-pay", day: "2026-02-20", amount_cents: PAYMENT, description: "E2E ONLINE PAYMENT", transaction_id: txnPay },
    ];
    let context = await saveStatement(ACTOR, key("statement"), {
      expected_revision: 0, bank_account_id: ACCOUNT, from: FROM, to: TO, reference: "E2E Visa Feb 2026", evidence_id: evidence.evidence.id,
      opening_balance_cents: openingCents, closing_balance_cents: closingCents, declared_line_count: lines.length,
      declared_credits_cents: credits, declared_debits_cents: debits, completeness_attested: true, lines,
    });
    // Before matching only the two close-blockers that matching resolves may remain.
    const early = context.blockers.filter((b) => !["BANKING_STATEMENT_UNMATCHED_LINES", "BANKING_STATEMENT_DIFFERENCE"].includes(b));
    check(context.statement.status === "draft" && early.length === 0, `card statement saved: anchored on the card opening, CreditCard + credit accepted (${context.blockers.join(",") || "no blockers"})`);
    check(context.statement.opening_balance_cents === -50000, "statement opening equals the GL opening line");
    const bookByEntry = new Map(context.book_items.map((b) => [b.id, b]));
    const bookIds = (await client.query<{ entry_id: string; id: string }>(
      `SELECT entry_id,id FROM bank_journal_line WHERE account_list_id=$1 AND entry_id=ANY($2::text[])`, [CARD_LIST_ID, [entryA, entryB, entryPay, entryOut]])).rows;
    const lineOf = (entry: string) => bookIds.find((r) => r.entry_id === entry)?.id ?? "";
    check([entryA, entryB, entryPay, entryOut].every((e) => bookByEntry.has(lineOf(e))), "book items list the 4 February card lines");
    check(!context.book_items.some((b) => b.day > TO), "the March charge is not a book item of February");
    check(context.book_items.every((b) => b.blockers.length === 0), "posted GL documents carry no source blockers");

    // 3. Match the three feed lines, preview, close in $0 with one outstanding charge.
    const lineId = (k: string) => context.lines.find((l) => l.external_key === k)?.id ?? "";
    const bookHash = (entry: string) => bookByEntry.get(lineOf(entry))?.source_hash ?? "";
    context = await matchStatement(context.statement.id, ACTOR, key("match"), {
      expected_revision: context.statement.revision,
      allocations: [
        { statement_line_id: lineId("feb-a"), book_kind: "journal_line", book_id: lineOf(entryA), amount_cents: CHARGE_A, expected_book_hash: bookHash(entryA) },
        { statement_line_id: lineId("feb-b"), book_kind: "journal_line", book_id: lineOf(entryB), amount_cents: CHARGE_B, expected_book_hash: bookHash(entryB) },
        { statement_line_id: lineId("feb-pay"), book_kind: "journal_line", book_id: lineOf(entryPay), amount_cents: PAYMENT, expected_book_hash: bookHash(entryPay) },
      ],
    });
    check(context.matches.length === 3 && context.lines.every((l) => l.remaining_cents === 0), "3 lines matched, nothing remaining on the statement side");
    const preview = await previewStatement(context.statement.id, ACTOR, key("preview"), { expected_revision: context.statement.revision });
    check(preview.difference_cents === 0, "preview difference is $0");
    check(preview.outstanding_disbursements_cents === OUTSTANDING && preview.deposits_in_transit_cents === 0, "the unmatched charge is the only outstanding item (shown as '+ Outstanding charges' on a card)");
    check(preview.book_balance_cents === closingCents - OUTSTANDING, "book balance = closing − outstanding charge, in GL sign");
    const closed = await closeStatement(context.statement.id, ACTOR, key("close"), { expected_revision: context.statement.revision, preview_hash: preview.preview_hash });
    check(closed.statement.status === "closed" && !closed.needs_review && closed.difference_cents === 0, "card statement CLOSED in $0 (bank_statement_check_close accepted the CreditCard book)");

    // 4. Negative: a card line dated inside the closed month is refused; March is fine.
    let refused = "";
    try { await cardEntry(client, "2026-02-15", 555, expense, true, "E2E backdated into closed Feb"); }
    catch (error) { refused = error instanceof Error ? error.message : String(error); }
    check(refused.includes("BANKING_STATEMENT_PERIOD_CLOSED"), `journal guard refuses a card line inside the closed statement (${refused.slice(0, 60)})`);
    await cardEntry(client, "2026-03-05", 555, expense, true, "E2E March charge after the close");
    check(true, "a card line dated after the closed period still posts");

    // 5. Feed: matched transactions read `reconciled`, and leave "To review".
    const all = await bankingTransactions({ account_id: ACCOUNT, offset: 0, limit: 50, review_status: "all", history: true });
    const reconciled = all.transactions.filter((t) => t.review_status === "reconciled");
    check(reconciled.length === 3 && reconciled.every((t) => t.reconciled?.statement_id === closed.statement.id && t.reconciled.from_day === FROM), "the 3 matched feed rows are 'reconciled' and point at the closed statement");
    const pending = await bankingTransactions({ account_id: ACCOUNT, offset: 0, limit: 50, review_status: "pending", history: true });
    check(pending.count === 0, "'To review' no longer lists reconciled rows");
    const only = await bankingTransactions({ account_id: ACCOUNT, offset: 0, limit: 50, review_status: "reconciled", history: true });
    check(only.count === 3, "the 'Reconciled' filter lists exactly the matched rows");
    console.log(`\ne2e-bank-card-statements: ${checks}/${checks} checks passed`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
