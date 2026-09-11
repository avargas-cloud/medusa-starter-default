/** V13 full documented statements, grouped/partial matches, immutable two-period carry and zero GL. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { getDbPool } from "../../api/utils/db-pool";
import { configureCompletionSandbox, completionBankCaps, completionDirectory } from "./bank-completion-fixtures";
import { OpeningSandboxApi, openingItem, accountListIdFor } from "../../lib/banking/opening-sandbox-api";
import { nextStatementDay } from "../../lib/banking/statement-source";
import type { MovementContext } from "../../lib/banking/movement-types";
import type { StatementContext, StatementInput } from "../../lib/banking/statement-types";
import { statementPrefix as prefix, statementAccount as account, seedStatementAccount, seedStatementTransaction,
  statementMutation, cleanStatementFixtures, fingerprints, bankingFingerprint } from "./bank-statements-fixtures";

type Value = Record<string, unknown>;
export type StatementBrowserOptions = {
  statementId: string; secondStatementId: string; accountId: string; evidenceId: string;
  firstFrom: string; firstTo: string; secondFrom: string; secondTo: string; pdfBase64: string; prefix: string;
  depositItemId: string; checkItemId: string; expectedBookBalanceCents: number;
};
export type StatementBrowserHook = (options: StatementBrowserOptions) => Promise<{ checks: number; screenshots?: string[] }>;
export async function runBankStatementsSandbox(snapshot: { file: string; sha256: string }, browser?: StatementBrowserHook) {
  configureCompletionSandbox();
  const bytes = readFileSync(snapshot.file);
  assert(bytes.subarray(0, 5).toString() === "PGDMP" && createHash("sha256").update(bytes).digest("hex") === snapshot.sha256);
  const pool = getDbPool(), client = await pool.connect(), test = new OpeningSandboxApi();
  let owns = false, seeded = false, ownSetup = false, setupEventIds: string[] = [];
  let before: Value | undefined, banksBefore: Value | undefined;
  const base = "/admin/banking/statements";
  const ctx = (id: string) => test.api(`${base}/${id}`) as Promise<StatementContext>;
  const save = (body: StatementInput) => test.api(base, body) as Promise<StatementContext>;
  const close = async (context: StatementContext) => {
    const preview = await test.api(`${base}/${context.statement.id}/preview`, { expected_revision: context.statement.revision });
    assert.deepEqual(preview.blockers, []);
    const body = { expected_revision: context.statement.revision, preview_hash: preview.preview_hash }, key = randomUUID();
    const result = await test.api(`${base}/${context.statement.id}/close`, body, 200, key) as StatementContext;
    assert.deepEqual(await test.api(`${base}/${context.statement.id}/close`, body, 200, key), result);
    test.check(result.statement.status === "closed" && !result.needs_review && result.difference_cents === 0, "Close/retry keeps exact reconciled evidence");
    return result;
  };
  try {
    owns = Boolean((await client.query("SELECT pg_try_advisory_lock(hashtextextended('e2e-bank-completion',7241)) ok")).rows[0].ok);
    test.check(owns, "Single completion harness owns V13 fixtures");
    assert((await client.query("SELECT 1 FROM mikro_orm_migrations WHERE name='Migration20260909200000'")).rowCount);
    before = await fingerprints(client); banksBefore = await bankingFingerprint(client);
    for (const [table, row] of Object.entries(banksBefore)) assert(Number((row as { count: string }).count) <= completionBankCaps[table]!);
    assert(!(await client.query("SELECT 1 FROM bank_connection WHERE starts_with(id,$1)", [prefix])).rowCount);
    await seedStatementAccount(client); seeded = true; await test.login();
    await test.api(base, undefined, 401, undefined, true);
    const setup = (await test.api("/admin/banking/accounting/setup")).setup as { cut_date: string } | null;
    if (!setup) {
      const eventIds = (await client.query("SELECT id FROM bank_review_event WHERE entity_id='local-usd'")).rows.map(row => String(row.id));
      await test.setup("2026-09-01"); ownSetup = true;
      setupEventIds = (await client.query("SELECT id FROM bank_review_event WHERE entity_id='local-usd' AND NOT(id=ANY($1::text[]))", [eventIds])).rows.map(row => String(row.id));
    }
    const setupHash = (await client.query("SELECT md5(to_jsonb(s)::text) hash FROM bank_accounting_setup s WHERE id='local-usd'")).rows[0]?.hash ?? null;
    writeFileSync(`${completionDirectory}/statements-recovery.json`, JSON.stringify({ ownSetup, setupEventIds,
      expectedSetupHash: setupHash, bankingBaseline: banksBefore, protectedBaseline: before }, null, 2), { mode: 0o600 });
    const first = setup?.cut_date ?? "2026-09-01", last = nextStatementDay(first), second = nextStatementDay(last), secondEnd = nextStatementDay(second);
    assert(secondEnd <= new Date().toISOString().slice(0, 10));
    const openingEvidence = await test.evidence(prefix + "verified-opening.pdf");
    const originalDay = new Date(`${first}T12:00:00Z`); originalDay.setUTCDate(originalDay.getUTCDate() - 1);
    const originalDayStr = originalDay.toISOString().slice(0, 10);
    const historical = (kind: "deposit_in_transit" | "outstanding_check") => ({ ...openingItem(kind, 10000, prefix + kind), original_day: originalDayStr });
    // banking-on-gl: the retired draft→preview→adopt opening flow is now a single
    // atomic POST to the GL `opening_balance` document, keyed by `account_list_id`
    // (the QB List ID, resolved here from the internal `bank_account.id`) — and
    // the GL entry's OWN `day` must be the day BEFORE this statement's `first`
    // (Banking-on-GL: "the first statement must start the day after the entry's day").
    const accountListId = await accountListIdFor(client, account);
    const opening = await test.adopt({ account_list_id: accountListId, day: originalDayStr, balance_cents: 100000,
      evidence_ids: [openingEvidence], items: [historical("deposit_in_transit"), historical("outstanding_check")] });
    const unclearedFor = (kind: "deposit_in_transit" | "outstanding_check") =>
      Object.values(opening.uncleared).find(row => row.role.includes(kind));
    const deposit = unclearedFor("deposit_in_transit")!, cheque = unclearedFor("outstanding_check")!;
    assert(deposit && cheque, "GL opening_balance posted an uncleared_<key> line for both historical items");
    const evidence = String(((await test.api("/admin/banking/evidence", { name: prefix + "complete-statement.pdf",
      mime_type: "application/pdf", content_base64: test.pdfBase64 })).evidence as Value).id);
    const loanTx = await seedStatementTransaction(client, "loan", -1500, first);
    const liability = (await client.query(`SELECT qb_list_id FROM qb_account WHERE is_active AND deleted_at IS NULL
      AND account_type IN ('LongTermLiability','OtherCurrentLiability') AND (currency IS NULL OR currency IN ('USD','US Dollar')) ORDER BY qb_list_id LIMIT 1`)).rows[0]; assert(liability);
    const loan = await test.api("/admin/banking/movements", { expected_revision: 0, kind: "loan_payment", reference: prefix + "loan",
      description: "Owned V13 dated projection", day: first, bank_account_id: account, transaction_id: loanTx, evidence_id: evidence,
      amount_cents: 1500, attested: true, destination_bank_account_id: null, transit_account_list_id: null,
      allocations: [{ role: "principal", account_list_id: liability.qb_list_id, amount_cents: 1500, source_kind: "document",
        source_id: prefix + "loan", documented_capacity_cents: 1500, documented_as_of: first, recognition_owner: "existing", evidence_id: evidence }] }) as MovementContext;
    const loanPreview = await test.api(`/admin/banking/movements/${loan.movement.id}/preview`, { expected_revision: 1 });
    const loanPosted = await test.api(`/admin/banking/movements/${loan.movement.id}/post`, { expected_revision: 1,
      preview_hash: loanPreview.preview_hash }) as MovementContext;
    const inTx = await seedStatementTransaction(client, "first_in", 6000, first), outTx = await seedStatementTransaction(client, "first_out", -4000, last);
    const body: StatementInput = { expected_revision: 0, bank_account_id: account, from: first, to: last, reference: prefix + "period-one",
      evidence_id: evidence, opening_balance_cents: 100000, closing_balance_cents: 100500, declared_line_count: 5,
      declared_credits_cents: 7000, declared_debits_cents: 6500, completeness_attested: true,
      lines: [{ external_key: "credit", day: first, amount_cents: 6000, description: "Partial historic deposit", transaction_id: inTx },
        { external_key: "debit", day: last, amount_cents: -4000, description: "Partial historic check", transaction_id: outTx },
        { external_key: "loan", day: first, amount_cents: -1500, description: "Loan principal", transaction_id: loanTx }] };
    let one = await save(body);
    test.check(one.blockers.includes("BANKING_STATEMENT_DOCUMENT_INCOMPLETE"), "Omitted offsetting1000/1000 blocked despite same net balance");
    await test.api(`${base}/${one.statement.id}/close`, { expected_revision: one.statement.revision, preview_hash: "0".repeat(64) }, 409);
    const completeBody = { ...body, id: one.statement.id, expected_revision: one.statement.revision,
      declared_line_count: 3, declared_credits_cents: 6000, declared_debits_cents: 5500 };
    one = await save(completeBody);
    await test.api(base, { ...body, reference: prefix + "duplicate-period" }, 409);
    await test.api(base, { ...completeBody, expected_revision: 1 }, 409);
    // banking-on-gl: the retired "opening_item" book_kind is gone — the former
    // outstanding-check/deposit-in-transit items ARE `bank_journal_line` rows now
    // (role `uncleared_<key>`), matched exactly like any other journal line.
    const allocate = (context: StatementContext, lineKey: string, bookId: string, cents: number) => ({
      statement_line_id: context.lines.find(line => line.external_key === lineKey)!.id, book_kind: "journal_line",
      book_id: bookId, amount_cents: cents, expected_book_hash: context.book_items.find(item => item.id === bookId)!.source_hash });
    await test.api(`${base}/${one.statement.id}/matches`, { expected_revision: one.statement.revision,
      allocations: [allocate(one, "credit", deposit.id, 6001)] }, 409);
    const raceBody = { expected_revision: one.statement.revision, allocations: [allocate(one, "credit", deposit.id, 3000)] };
    const race = await Promise.all([test.api(`${base}/${one.statement.id}/matches`, raceBody, [200, 409]), test.api(`${base}/${one.statement.id}/matches`, raceBody, [200, 409])]);
    test.check(race.filter(row => row.statement).length === 1, "Concurrent same-revision match has exactly one winner");
    one = await ctx(one.statement.id);
    one = await test.api(`${base}/${one.statement.id}/matches`, { expected_revision: one.statement.revision,
      allocations: [allocate(one, "credit", deposit.id, 3000), allocate(one, "debit", cheque.id, 4000)] }) as StatementContext;
    const loanLine = one.book_items.find(item => item.kind === "journal_line" && item.amount_cents === -1500)!;
    one = await test.api(`${base}/${one.statement.id}/matches`, { expected_revision: one.statement.revision, allocations: [{
      statement_line_id: one.lines.find(line => line.external_key === "loan")!.id, book_kind: "journal_line", book_id: loanLine.id,
      amount_cents: 1500, expected_book_hash: loanLine.source_hash }] }) as StatementContext;
    test.check(one.deposits_in_transit_cents === 4000 && one.outstanding_disbursements_cents === 6000
      && one.book_balance_cents === 98500 && one.difference_cents === 0, "Grouped partial matches carry deposit40/check60 with book985/statement1005");
    // "opening_item" no longer distinguishes this match from the loan's `journal_line`
    // match below — select the same one the old test picked (deposit's partial match) by `book_id`.
    const matchedId = one.matches.find(match => match.book_kind === "journal_line" && match.book_id === deposit.id)!.id;
    one = await test.api(`${base}/${one.statement.id}/unmatch`, { expected_revision: one.statement.revision,
      match_ids: [matchedId], reason: "Verify audited unmatch and restore" }) as StatementContext;
    const openLine = one.lines.find(line => line.remaining_cents > 0)!;
    one = await test.api(`${base}/${one.statement.id}/matches`, { expected_revision: one.statement.revision,
      allocations: [allocate(one, openLine.external_key, openLine.amount_cents > 0 ? deposit.id : cheque.id, openLine.remaining_cents)] }) as StatementContext;
    const glBefore = Number((await client.query("SELECT count(*)::int n FROM bank_journal_entry")).rows[0].n);
    one = await close(one);
    const frozen = one.statement.closed_snapshot;
    await assert.rejects(statementMutation(client, "SELECT bank_statement_assert_open($1,$2)", [one.statement.account_list_id, first]), /BANKING_STATEMENT_PERIOD_CLOSED/);
    await test.api(`${base}/${one.statement.id}/matches`, { expected_revision: one.statement.revision, allocations: [allocate(one, "credit", deposit.id, 1)] }, 409);
    await statementMutation(client, "UPDATE bank_transaction SET source_version=source_version+1 WHERE id=$1", [inTx]);
    const drift = await ctx(one.statement.id);
    test.check(drift.needs_review, "Closed source drift is visible"); assert.deepEqual(drift.statement.closed_snapshot, frozen);
    await statementMutation(client, "UPDATE bank_transaction SET source_version=source_version-1 WHERE id=$1", [inTx]);
    test.check(!(await ctx(one.statement.id)).needs_review, "Restored exact evidence removes drift without replacing snapshot");
    await test.api(`/admin/banking/movements/${loan.movement.id}/reverse`, { posting_id: loanPosted.postings[0]!.id,
      day: second, reason: "Owned dated correction after closed statement" });
    const reverseTx = await seedStatementTransaction(client, "loan_reverse", 1500, second);
    const inTwo = await seedStatementTransaction(client, "second_in", 4000, second), outTwo = await seedStatementTransaction(client, "second_out", -6000, secondEnd);
    let two = await save({ ...body, from: second, to: secondEnd, reference: prefix + "period-two", opening_balance_cents: 100500,
      closing_balance_cents: 100000, declared_line_count: 3, declared_credits_cents: 5500, declared_debits_cents: 6000,
      lines: [{ external_key: "credit", day: second, amount_cents: 4000, description: "Remaining historic deposit", transaction_id: inTwo },
        { external_key: "debit", day: secondEnd, amount_cents: -6000, description: "Remaining historic check", transaction_id: outTwo },
        { external_key: "reverse", day: second, amount_cents: 1500, description: "Loan correction", transaction_id: reverseTx }] });
    two = await test.api(`${base}/${two.statement.id}/matches`, { expected_revision: two.statement.revision,
      allocations: [allocate(two, "credit", deposit.id, 4000), allocate(two, "debit", cheque.id, 6000)] }) as StatementContext;
    const reverseLine = two.book_items.find(item => item.kind === "journal_line" && item.amount_cents === 1500)!;
    two = await test.api(`${base}/${two.statement.id}/matches`, { expected_revision: two.statement.revision, allocations: [{
      statement_line_id: two.lines.find(line => line.external_key === "reverse")!.id, book_kind: "journal_line", book_id: reverseLine.id,
      amount_cents: 1500, expected_book_hash: reverseLine.source_hash }] }) as StatementContext;
    test.check(two.book_balance_cents === 100000, "Typed Bank journal projection includes original/reversal on their own dates");
    test.check(two.deposits_in_transit_cents === 0 && two.outstanding_disbursements_cents === 0 && two.difference_cents === 0, "Second period consumes exact carried residuals to zero");
    two = await close(two);
    await test.api(`${base}/${one.statement.id}/reopen`, { expected_revision: one.statement.revision, reason: "Must not detach a closed successor" }, 409);
    const exported = await test.api(`${base}/${two.statement.id}/export`); assert.deepEqual(exported.closed_snapshot, two.statement.closed_snapshot);
    two = await test.api(`${base}/${two.statement.id}/reopen`, { expected_revision: two.statement.revision, reason: "Audited terminal period correction" }) as StatementContext;
    test.check(two.statement.history.length === 1 && two.statement.status === "draft", "Terminal reopen preserves prior immutable snapshot/history");
    two = await close(two);
    test.check(Number((await client.query("SELECT count(*)::int n FROM bank_journal_entry")).rows[0].n) === glBefore + 1, "Only explicit reversal adds one journal; matching/closing/reopening/export remains zero GL");
    assert.equal(two.global_ledger_coverage, "partial");
    if (browser) {
      const ui = await browser({ statementId: one.statement.id, secondStatementId: two.statement.id, accountId: account,
        evidenceId: evidence, firstFrom: first, firstTo: last, secondFrom: second, secondTo: secondEnd,
        pdfBase64: test.pdfBase64, prefix, depositItemId: deposit.id, checkItemId: cheque.id, expectedBookBalanceCents: 100000 });
      assert(Number.isSafeInteger(ui.checks) && ui.checks > 0); test.checks += ui.checks;
      const final = await ctx(two.statement.id);
      test.check(final.statement.status === "closed" && !final.needs_review && final.difference_cents === 0
        && final.book_balance_cents === 100000 && final.book_items.every(item => item.remaining_cents === 0),
      "Browser leaves terminal period fully reconciled with exact source capacities");
      assert.deepEqual((await ctx(one.statement.id)).statement.closed_snapshot, frozen);
      test.check(Number((await client.query("SELECT count(*)::int n FROM bank_journal_entry")).rows[0].n) === glBefore + 1,
        "Browser statement mutations create zero journal entries");
    }
  } finally {
    try { if (owns) {
      await client.query("ROLLBACK");
      if (seeded) {
        const setupHash = (await client.query("SELECT md5(to_jsonb(s)::text) hash FROM bank_accounting_setup s WHERE id='local-usd'")).rows[0]?.hash ?? null;
        writeFileSync(`${completionDirectory}/statements-recovery.json`, JSON.stringify({ ownSetup, setupEventIds,
          expectedSetupHash: setupHash, bankingBaseline: banksBefore, protectedBaseline: before }, null, 2), { mode: 0o600 });
        await cleanStatementFixtures(client, ownSetup, setupEventIds);
      }
      if (before) assert.deepEqual(await fingerprints(client), before);
      if (banksBefore) assert.deepEqual(await bankingFingerprint(client), banksBefore);
      await client.query("SELECT pg_advisory_unlock(hashtextextended('e2e-bank-completion',7241))");
    } } finally { client.release(); }
  }
  console.log(`PASS bank statements V13: ${test.checks} checks; owned residue=0; protected sources unchanged`);
  return { checks: test.checks, residue: 0 };
}
