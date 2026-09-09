/** V10 integration: real HTTP, Postgres and browser, with isolated owned Finance fixtures. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getDbPool } from "../../api/utils/db-pool";
import { configureBankSandbox } from "../../lib/banking/sandbox-runtime";
import { transaction } from "../../lib/banking/store";
import { withReviewLock } from "../../lib/banking/review-common";
import { OpeningSandboxApi, openingApiBase, openingItem } from "../../lib/banking/opening-sandbox-api";
import { openingBoundaryCases, openingSqlProbes, openingTransitCase } from "../../lib/banking/opening-sandbox-adversarial";
import { openingPeriodChecks } from "../../lib/banking/opening-sandbox-periods";
import { runOpeningPermissions } from "../../lib/banking/opening-sandbox-permissions";
import type { BankDeposit } from "../../lib/banking/deposit-types";
import { account, day, laterDay, openingPrefix, openingPreflight, fingerprints, bankingFingerprint,
  seedReceiptAccount, seedReceiptPayment, seedReceiptMovement, cleanOpeningFixtures } from "./bank-openings-fixtures";

async function main() {
  configureBankSandbox(); process.env.POS_URL = "http://localhost:3099"; process.env.MEDUSA_SANDBOX_URL = "http://localhost:9099";
  const test: OpeningSandboxApi = new OpeningSandboxApi();
  const pool = getDbPool(), client = await pool.connect(); let owns = false, seeded = false;
  let before: Record<string, unknown> | undefined, banksBefore: Record<string, unknown> | undefined;
  const mutate = (sql: string, values: unknown[]) => transaction(client, async () => { await withReviewLock(client); await client.query(sql, values); });
  const journalCount = async () => Number((await client.query("SELECT count(*)::int n FROM bank_journal_entry")).rows[0].n);
  const deposit = async (id: string) => (await test.api(`/admin/banking/deposits/${id}`)).deposit as BankDeposit;
  const reverseDeposit = async (id: string) => {
    const ctx = await test.receipt(id, true);
    await test.api(`/admin/banking/accounting/deposits/${id}/reverse`, { posting_id: ctx.posting!.id, day: laterDay, reason: "Owned v10 explicit correction" });
  };
  const voidDeposit = async (id: string) => test.api(`/admin/banking/deposits/${id}/void`, {
    expected_revision: (await deposit(id)).revision, reason: "Release owned v10 reservation after reversal" });
  try {
    owns = Boolean((await client.query("SELECT pg_try_advisory_lock(hashtextextended('e2e-bank-openings-v10',7241)) ok")).rows[0].ok);
    test.check(owns, "Single harness owns v10 fixtures");
    await openingPreflight(client);
    test.check(!(await client.query("SELECT 1 FROM bank_accounting_setup UNION ALL SELECT 1 FROM bank_review_event WHERE entity_id='local-usd'")).rowCount,
      "No operator setup or command history is overwritten");
    before = await fingerprints(client); banksBefore = await bankingFingerprint(client);
    await seedReceiptAccount(client); seeded = true;
    await test.login(); await test.setup("2000-01-01");
    await test.api(openingApiBase, undefined, 401, undefined, true);
    const payment = await seedReceiptPayment(client, "opening_partial", 50000, "1999-12-31");
    const evidence = await test.evidence(openingPrefix + "books-statement.pdf");
    const boundaryDraft = await openingBoundaryCases(test, evidence);
    await test.api(openingApiBase + "/evidence", { name: "invalid.pdf", mime_type: "application/pdf", content_base64: Buffer.from("not a PDF").toString("base64") }, 400);
    const bankDraft = await test.save({ expected_revision: 0, kind: "bank", bank_account_id: account,
      book_balance_cents: null, statement_balance_cents: 1000000, statement_evidence_id: evidence,
      books_evidence_id: evidence, reference: openingPrefix + "bank", items: [openingItem("outstanding_check", 100000, openingPrefix + "check", evidence)] });
    test.check(bankDraft.opening.book_balance_cents === null && bankDraft.current_book_balance_cents === null, "Unknown opening is never zero");
    await test.api(`${openingApiBase}/${bankDraft.opening.id}/preview`, { expected_revision: bankDraft.opening.revision }, 409);
    const bankReady = await test.save({ id: bankDraft.opening.id, expected_revision: bankDraft.opening.revision,
      kind: "bank", bank_account_id: account, book_balance_cents: 900000, statement_balance_cents: 1000000,
      statement_evidence_id: evidence, books_evidence_id: evidence, reference: openingPrefix + "bank",
      items: [openingItem("outstanding_check", 100000, openingPrefix + "check", evidence)] });
    const ufReady = await test.save({ expected_revision: 0, kind: "clearing", book_balance_cents: 50000, statement_balance_cents: null,
      books_evidence_id: evidence, reference: openingPrefix + "uf", items: [
        openingItem("uf_receipt", 20000, openingPrefix + "partial-cpay", evidence, payment),
        openingItem("uf_receipt", 30000, openingPrefix + "external-cash", evidence),
      ] });
    const baselineCount = await journalCount();
    const browser = await import(pathToFileURL(resolve(__dirname, "../../../../store-pos/scripts/e2e/bank-openings.mjs")).href);
    const draftUi = await browser.runOpeningsBrowserDraft({ bankOpeningId: bankReady.opening.id, ufOpeningId: ufReady.opening.id,
      pdfBase64: test.pdfBase64, accountId: account, depositDay: day, reference: openingPrefix + "browser" });
    test.check(Number(draftUi.checks) > 0, "Browser edits evidence, previews/adopts opening and saves/voids typed UF deposit"); test.checks += Number(draftUi.checks);
    const bank = await test.opening(bankReady.opening.id), uf = await test.opening(ufReady.opening.id);
    test.check(await journalCount() === baselineCount, "Adopting Bank/UF creates no journal, Equity, AR, income or expense");
    test.check(bank.current_book_balance_cents === 900000 && uf.current_book_balance_cents === 50000, "Exact verified Bank9000/UF500 baseline");
    test.check(bank.coverage === "partial" && uf.coverage === "partial", "Verified opening retains partial book coverage");
    const partial = uf.items.find(row => row.payment_id === payment)!, external = uf.items.find(row => !row.payment_id)!;
    test.check(partial.available_cents === 20000 && partial.amount_cents === 20000, "Payment500 supplies only documented pending200");
    const normal = await test.receipt(payment);
    test.check(!normal.eligible, "Opening identity cannot also recognize a normal receipt");
    await mutate("UPDATE customer_payment SET batch_day=$2 WHERE id=$1", [payment, day]);
    const dateChanged = await test.receipt(payment);
    test.check(!dateChanged.eligible && dateChanged.blockers.includes("BANKING_OPENING_PAYMENT_CLAIMED"), "Moving batch_day after cut cannot bypass opening identity claim");
    const normalPost = await test.api(`/admin/banking/accounting/receipts/${payment}/preview`, { expected_source_hash: dateChanged.source_hash }, 409);
    test.check(normalPost.code === "BANKING_OPENING_PAYMENT_CLAIMED", "Normal recognition fails for the opening claim itself");
    await mutate("UPDATE customer_payment SET batch_day='1999-12-31' WHERE id=$1", [payment]);
    const full = await test.makeDeposit(account, openingPrefix + "full500", [
      { id: partial.id, amount: "200.00", opening: true }, { id: external.id, amount: "300.00", opening: true },
    ]);
    test.check(await journalCount() === baselineCount && !full.accounting_posted, "Ready opening deposit remains zeroGL");
    const posted = await test.postReceipt(full.id, true);
    assert.deepEqual(posted.posting!.lines.map(line => [line.role, line.debit_cents, line.credit_cents]), [["bank", 50000, 0], ["clearing", 0, 50000]]); test.check(true, "Opening deposit is exact DrBank500/CrUF500 without AR");
    test.check((await test.opening(bank.opening.id)).current_book_balance_cents === 950000 &&
      (await test.opening(uf.opening.id)).current_book_balance_cents === 0, "Opening plus deposit yields Bank9500/UF0");
    const checkTx = await seedReceiptMovement(client, "opening_check", "1000.00", "2000-01-05"), item = bank.items[0]!;
    const clearBody = { transaction_id: checkTx, expected_source_version: 1, expected_item_hash: item.source_hash }, key = randomUUID();
    const countBeforeClear = await journalCount();
    await test.api(`${openingApiBase}/items/${item.id}/clear`, clearBody, 200, key);
    await test.api(`${openingApiBase}/items/${item.id}/clear`, clearBody, 200, key);
    test.check(await journalCount() === countBeforeClear && (await test.opening(bank.opening.id)).current_book_balance_cents === 950000,
      "Historical check clear/retry preserves Bank9500 and creates zeroGL");
    const clearItem = (await test.opening(bank.opening.id)).items[0]!;
    test.check(clearItem.transaction_id === checkTx && Boolean(clearItem.clear_id), "Old cheque has durable bank transaction claim");
    const review = (await test.api(`/admin/banking/transactions/${checkTx}/review`)).review as { revision: number };
    await test.api(`/admin/banking/transactions/${checkTx}/return`, { expected_revision: review.revision, expected_source_version: 1 }, 409);
    await openingPeriodChecks(client, test, bank.opening.id, item.id, checkTx);
    await runOpeningPermissions({ client, test, bankOpeningId: bank.opening.id, ufOpeningId: uf.opening.id, itemId: item.id, transactionId: checkTx });
    await mutate("UPDATE bank_transaction SET source_version=2 WHERE id=$1", [checkTx]);
    const changedClear = (await test.opening(bank.opening.id)).items.find(row => row.id === item.id)!;
    test.check(changedClear.stale && Boolean(changedClear.clear_id), "Changed bank evidence flags drift while keeping historical claim");
    await test.api(`${openingApiBase}/items/${item.id}/unclear`, { clear_id: changedClear.clear_id, reason: "Stale original source version", expected_source_version: 1 }, 409);
    await test.api(`${openingApiBase}/items/${item.id}/unclear`, { clear_id: changedClear.clear_id, reason: "Explicit current source review", expected_source_version: 2 });
    test.check(((await test.api(`/admin/banking/transactions/${checkTx}/review`)).review as { status: string }).status === "draft",
      "Correcting changed bank evidence restores a draft for fresh review");
    await test.api(`${openingApiBase}/items/${item.id}/clear`, { ...clearBody, expected_source_version: 2 });
    await test.api(`${openingApiBase}/${uf.opening.id}/revoke`, { expected_revision: (await test.opening(uf.opening.id)).opening.revision, reason: "Must retain consumed opening" }, 409);
    await reverseDeposit(full.id);
    test.check((await test.opening(uf.opening.id)).items.every(row => row.available_cents === 0), "Reversal preserves operational deposit reservation");
    await voidDeposit(full.id);
    test.check((await test.opening(uf.opening.id)).current_book_balance_cents === 50000, "Explicit reversal restores UF baseline effect");
    const split = await test.makeDeposit(account, openingPrefix + "split75", [{ id: partial.id, amount: "75.00", opening: true }]);
    await test.postReceipt(split.id, true);
    test.check((await test.opening(uf.opening.id)).items.find(row => row.id === partial.id)!.available_cents === 12500, "Partial75 leaves exactly125 of verified200");
    const over = await test.api("/admin/banking/deposits", { expected_revision: 0, account_id: account, date: day,
      reference: openingPrefix + "over-by-cent", memo: "Must reject one cent above verified remainder", fee_amount: "0.00",
      fee_account_list_id: null, fee_reference: null,
      lines: [{ opening_item_id: partial.id, amount: "125.01", expected_source_hash: partial.source_hash }] }, 409);
    test.check(over.code === "BANKING_DEPOSIT_OVER_RESERVED", "Real save rejects one cent over the verified residual");
    const newPayment = await seedReceiptPayment(client, "opening_new", 5000); await test.postReceipt(newPayment);
    const feeAccount = String((await client.query("SELECT qb_list_id FROM qb_account WHERE is_active AND deleted_at IS NULL AND account_type='Expense' AND (currency IS NULL OR currency IN ('USD','US Dollar')) ORDER BY qb_list_id LIMIT 1")).rows[0].qb_list_id);
    const mixed = await test.makeDeposit(account, openingPrefix + "mixed", [{ id: partial.id, amount: "125.00", opening: true },
      { id: external.id, amount: "300.00", opening: true }, { id: newPayment, amount: "50.00" }], feeAccount);
    const mixedPost = await test.postReceipt(mixed.id, true);
    await openingSqlProbes(client, test, bank, uf, boundaryDraft);
    assert.deepEqual(mixedPost.posting!.lines.map(line => [line.role, line.debit_cents, line.credit_cents]),
      [["bank", 47300, 0], ["clearing", 0, 47500], ["expense", 200, 0]]); test.check(true, "Mixed sources transfer gross475/net473/newfee2 exactly once");
    test.check((await test.opening(bank.opening.id)).current_book_balance_cents === 954800 &&
      (await test.opening(uf.opening.id)).current_book_balance_cents === 0, "Baseline projections include postcut receipt and mixed deposit exactly once");
    await mutate("UPDATE customer_payment SET amount=60000,raw_amount='{\"value\":\"60000\",\"precision\":20}' WHERE id=$1", [payment]);
    const drift = (await test.opening(uf.opening.id)).items.find(row => row.id === partial.id)!;
    test.check(drift.stale && drift.amount_cents === 20000 && drift.available_cents === 0, "Source growth flags drift and never replenishes verified residual");
    await mutate("DELETE FROM customer_payment WHERE id=$1", [payment]);
    const missing = (await test.opening(uf.opening.id)).items.find(row => row.id === partial.id)!;
    test.check(missing.stale && missing.consumed_cents === 20000, "Hard-deleted source keeps opening evidence and consumed money");
    const ui = await browser.runOpeningsBrowser({ bankOpeningId: bank.opening.id, ufOpeningId: uf.opening.id,
      checkItemId: item.id, clearTransactionId: checkTx, depositId: mixed.id, accountId: account, reverseDay: laterDay });
    test.check(Number(ui.checks) > 0, "Real browser exercised v10 openings and source identity"); test.checks += Number(ui.checks);
    await cleanOpeningFixtures(client);
    assert.deepEqual(await fingerprints(client), before, "Main scenario cleanup preserves protected Finance");
    assert.deepEqual(await bankingFingerprint(client), banksBefore, "Main scenario cleanup preserves foreign Banking");
    await openingTransitCase(client, test);
  } catch (error) { console.error("V10 primary failure before cleanup:", error instanceof Error ? error.message : "UNKNOWN_ERROR"); throw error; }
  finally {
    try {
      if (owns) {
        await client.query("ROLLBACK");
        if (seeded) await cleanOpeningFixtures(client);
        if (before) { assert.deepEqual(await fingerprints(client), before, "Financial sources and stock unchanged after own cleanup"); test.checks++; }
        if (banksBefore) { assert.deepEqual(await bankingFingerprint(client), banksBefore, "Foreign Banking rows unchanged after own cleanup"); test.checks++; }
        await client.query("SELECT pg_advisory_unlock(hashtextextended('e2e-bank-openings-v10',7241))");
      }
    } finally { client.release(); await pool.end(); }
  }
  console.log(`PASS bank openings integration: ${test.checks} checks; owned residue=0; protected sources unchanged`);
}
void main().catch((error: unknown) => { console.error("V10 failed", error instanceof Error ? error.message : "UNKNOWN_ERROR"); process.exitCode = 1; });
