/** V11 verification only. Never imported by production routes. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { POS_USER_MODULE } from "../../modules/pos-user";
import { POST as postRoute } from "../../api/admin/banking/movements/[id]/post/route";
import { POST as reverseRoute } from "../../api/admin/banking/movements/[id]/reverse/route";
import { POST as previewRoute } from "../../api/admin/banking/movements/[id]/preview/route";
import { OpeningSandboxApi, openingApiBase, openingItem } from "./opening-sandbox-api";
import { movementPrefix as prefix, movementActor as actor, movementAccounts as banks,
  movementDay as day, movementLaterDay as laterDay, seedMovementTransaction, movementFixtureMutation } from "../../scripts/tests/bank-movements-fixtures";
import { seedMovementPayroll, movementPayrollMonth } from "../../scripts/tests/bank-movements-fixtures";
import { previewMovement, postMovement } from "./movement-core";
import { previewAccountingExpense, postAccountingExpense } from "./accounting-core";
import type { MovementContext, MovementInput, MovementPreview } from "./movement-types";
import { getDbPool } from "../../api/utils/db-pool";
import { transaction } from "./store";
import { withReviewLock, reviewHash } from "./review-common";
import { movementFacts, movementRow } from "./movement-read";
import { postCompletionJournal } from "./completion-journal";

type Value = Record<string, unknown>;
type Input = { client: PoolClient; test: OpeningSandboxApi;
  make(suffix: string, overrides?: Partial<MovementInput>): Promise<{ body: MovementInput; ctx: MovementContext }>;
  post(ctx: MovementContext): Promise<MovementContext>; evidence(suffix: string): Promise<string>;
  loanAccount: string; expenseAccount: string; payableAccount: string; payrollAccount: string };
export async function runMovementAdversarial({ client, test, make, post, loanAccount, expenseAccount, payableAccount, payrollAccount }: Input) {
  const base = "/admin/banking/movements";
  const unknown = await make("unknown"); unknown.body.allocations[0]!.documented_capacity_cents = null;
  const unknownSaved = await test.api(base, { ...unknown.body, id: unknown.ctx.movement.id, expected_revision: 1 }) as MovementContext;
  test.check(unknownSaved.external_balance === "unknown", "Unknown obligation balance remains unknown");
  const blocked = await test.api(`${base}/${unknownSaved.movement.id}/preview`, { expected_revision: 2 }) as MovementPreview;
  test.check(blocked.blockers.includes("BANKING_DOCUMENTED_CAPACITY_REQUIRED"), "Unknown documented capacity blocks posting");
  await test.api(`${base}/${unknownSaved.movement.id}/post`, { expected_revision: 2, preview_hash: blocked.preview_hash }, 409);
  const driftTx = await seedMovementTransaction(client, "drift_tx", 10000), drift = await make("drift", { transaction_id: driftTx });
  const old = await test.api(`${base}/${drift.ctx.movement.id}/preview`, { expected_revision: 1 });
  await movementFixtureMutation(client, "UPDATE bank_transaction SET source_version=source_version+1 WHERE id=$1", [driftTx]);
  await test.api(`${base}/${drift.ctx.movement.id}/post`, { expected_revision: 1, preview_hash: old.preview_hash }, 409);
  await movementFixtureMutation(client, "UPDATE bank_transaction SET currency='CAD' WHERE id=$1", [driftTx]);
  const currency = await test.api(`${base}/${drift.ctx.movement.id}`) as MovementContext;
  test.check(currency.blockers.includes("BANKING_MOVEMENT_TRANSACTION_INVALID"), "Foreign currency fails closed without source mutation");
  const restricted = await make("permissions");
  assert(Number((await client.query("SELECT count(*)::int n FROM bank_review_permission")).rows[0].n) < 25,
    "One owned permission remains within the approved total cap");
  await movementFixtureMutation(client, `INSERT INTO bank_review_permission(id,user_id,can_review,can_close,can_post,granted_by)
    VALUES($1,$2,true,true,false,$3)`, [prefix + "permission", actor + "staff", actor]);
  const request = { auth_context: { actor_id: actor + "staff" }, params: { id: restricted.ctx.movement.id }, body: {},
    headers: { "idempotency-key": randomUUID() }, scope: { resolve: (name: string) => {
      if (name === "user") return { retrieveUser: async () => ({ email: "v11-staff@example.invalid" }) };
      if (name === POS_USER_MODULE) return { listPosUsers: async () => [{ can_view_accounting: true }] };
      throw new Error(`Unexpected dependency ${name}`);
    } } } as unknown as AuthenticatedMedusaRequest;
  for (const route of [previewRoute, postRoute, reverseRoute]) {
    let status = 200, result: Value = {};
    const response = { status: (s: number) => { status = s; return response; }, json: (v: Value) => { result = v; return response; } };
    await route(request, response as unknown as MedusaResponse);
    test.check(status === 403 && result.code === "BANKING_ACCESS_DENIED", "Executing movement route checks can_post before accepting input");
  }
  const sqlProbe = await make("sql_contract");
  const journalBefore = (await client.query("SELECT count(*)::text n FROM bank_journal_entry")).rows[0].n;
  for (const variant of ["wrong_counterpart", "wrong_payload", "missing_claims"] as const) {
    await assert.rejects(() => transaction(client, async () => {
      await withReviewLock(client);
      const { movement } = await movementRow(client, sqlProbe.ctx.movement.id), facts = await movementFacts(client, movement);
      const lines = facts.lines.map(line => line.role.startsWith("counterpart") && variant === "wrong_counterpart"
        ? { ...line, account_snapshot: { ...line.account_snapshot, account_type: "Equity" } } : line);
      await postCompletionJournal(client, { kind: "movement", origin_id: movement.id, stage: "outgoing", day,
        actor_id: actor, reference: movement.reference, description: movement.description, source_hash: reviewHash(facts.snapshot),
        source_snapshot: { source: { kind: "movement", id: movement.id }, facts: facts.snapshot,
          movement: variant === "wrong_payload" ? { ...movement, amount_cents: movement.amount_cents + 1 } : movement },
        lines, claims: variant === "missing_claims" ? [] : facts.claims });
    }), error => Boolean(error && typeof error === "object" && "code" in error && error.code === "P0001"
      && "message" in error && ["BANKING_MOVEMENT_CONTRACT_INVALID", "BANKING_SOURCE_CLAIM_INVALID"].includes(String(error.message))));
    test.check(true, `Deferred SQL independently rejects ${variant}`);
  }
  assert.equal((await client.query("SELECT count(*)::text n FROM bank_journal_entry")).rows[0].n, journalBefore,
    "Failed SQL probes roll back headers, lines and capacity claims");
  // Existing source rows are read-only. Only documentary links/claims in our own movement are written.
  for (const [kind, source, account] of [["obligation_payment", "vendor_bill", payableAccount],
    ["wire_match", "wire", payableAccount]] as const) {
    const rows = (await test.api(`${base}/sources?kind=${source}&q=`)).sources as Value[];
    const found = rows.find(r => typeof r.day === "string" && r.day <= day && (r.amount_cents === null || Number(r.amount_cents) >= 1));
    if (!found) { console.log(`LIMIT ${source}: no eligible read-only source; typed ownership is covered by unit cases`); continue; }
    const linked = await make("existing_" + source, { kind, amount_cents: 1, allocations: [{ role: "principal", account_list_id: account,
      amount_cents: 1, source_kind: source, source_id: String(found.id), documented_capacity_cents: 1, documented_as_of: day,
      recognition_owner: "existing", evidence_id: "pending" }] });
    if (source === "vendor_bill") {
      await test.api(base, { ...sqlProbe.body, amount_cents: sqlProbe.body.amount_cents + 1,
        allocations: [...sqlProbe.body.allocations, { ...sqlProbe.body.allocations[0]!, role: "interest", account_list_id: expenseAccount,
          amount_cents: 1, documented_capacity_cents: 1, source_id: `vendor_bill:${String(found.id)}`, recognition_owner: "new" }] }, 409);
      test.check(true, "Explicit existing bill identity cannot be renamed as new loan interest");
    }
    const before = (await client.query(`SELECT coalesce(sum(l.debit_cents-l.credit_cents),0)::text n FROM bank_journal_line l
      WHERE l.account_snapshot->>'account_type' IN ('Expense','OtherExpense')`)).rows[0].n;
    const result = await post(linked.ctx);
    test.check(result.postings[0]!.lines.every(l => !l.role.startsWith("expense")), `${source} principal uses existing balance sheet recognition`);
    assert.equal((await client.query(`SELECT coalesce(sum(l.debit_cents-l.credit_cents),0)::text n FROM bank_journal_line l
      WHERE l.account_snapshot->>'account_type' IN ('Expense','OtherExpense')`)).rows[0].n, before);
  }
  const payrollReport = async (from: string, to: string) => {
    const current = (await test.api(`/admin/reports/profit-loss/statement?from=${from}&to=${to}`)).current as Value;
    return { expense: Math.round(Number((current.expense as Value).total) * 100), income: Math.round(Number(current.net_income) * 100) };
  };
  const periods = [["2026-02-01T05:00:00Z", "2026-02-15T05:00:00Z"],
    ["2026-02-15T05:00:00Z", "2026-02-28T05:00:00Z"], ["2026-02-28T05:00:00Z", "2026-03-01T05:00:00Z"]] as const;
  const payrollBefore = [];
  for (const [from, to] of periods) payrollBefore.push(await payrollReport(from, to));
  await seedMovementPayroll(client);
  const payrollAfter = [];
  for (const [index, [from, to]] of periods.entries()) {
    const report = await payrollReport(from, to); payrollAfter.push(report);
    const expected = [0, 50, 51][index]!;
    test.check(report.expense - payrollBefore[index]!.expense === expected && report.income - payrollBefore[index]!.income === -expected,
      `Canonical payroll P&L recognizes ${expected} cents in ${from}..${to}`);
  }
  const payrollSources = (await test.api(`${base}/sources?kind=payroll&q=${movementPayrollMonth}`)).sources as Value[];
  assert.deepEqual(payrollSources.map(s => [s.id, s.amount_cents]).sort(), [["2026-02:15", 50], ["2026-02:28", 51]]);
  const payrollDocument = async (suffix: string, installment: "15" | "28", cents: number) => {
    const date = `${movementPayrollMonth}-${installment}`;
    const txId = await seedMovementTransaction(client, suffix + "_tx", cents, banks[0], date);
    return make(suffix, { kind: "payroll_match", day: date, amount_cents: cents, transaction_id: txId,
      allocations: [{ role: "principal", account_list_id: payrollAccount, amount_cents: cents, source_kind: "payroll",
        source_id: `${movementPayrollMonth}:${installment}`, documented_capacity_cents: cents, documented_as_of: date,
        recognition_owner: "existing", evidence_id: "pending" }] });
  };
  const firstPayroll = await payrollDocument("payroll_first", "15", 50);
  await test.api(base, { ...firstPayroll.body, transaction_id: null, day: "2026-02-14", reference: prefix + "payroll_early",
    allocations: firstPayroll.body.allocations.map(a => ({ ...a, documented_as_of: "2026-02-14" })) }, 409);
  await test.api(base, { ...firstPayroll.body, transaction_id: null, amount_cents: 51, reference: prefix + "payroll_overhalf",
    allocations: firstPayroll.body.allocations.map(a => ({ ...a, amount_cents: 51, documented_capacity_cents: 51 })) }, 409);
  await test.api(base, { ...firstPayroll.body, transaction_id: null, reference: prefix + "payroll_month_ambiguous",
    allocations: firstPayroll.body.allocations.map(a => ({ ...a, source_id: movementPayrollMonth })) }, 409);
  await post(firstPayroll.ctx);
  const secondPayroll = await payrollDocument("payroll_second", "28", 51); await post(secondPayroll.ctx);
  test.check(true, "Payroll101 posts two distinct dated installments50+51 against documented liability");
  const duplicatePayroll = await test.api(base, { ...firstPayroll.body, transaction_id: null, reference: prefix + "payroll_duplicate" }) as MovementContext;
  const duplicatePayrollPreview = await test.api(`${base}/${duplicatePayroll.movement.id}/preview`, { expected_revision: 1 }, 409);
  test.check(duplicatePayrollPreview.code === "BANKING_SOURCE_OVERCONSUMED", "A payroll installment cannot be consumed twice");
  for (const [index, [from, to]] of periods.entries()) assert.deepEqual(await payrollReport(from, to), payrollAfter[index],
    "Matching either payroll installment creates no second payroll expense");
  // V8 and V11 compete for one physical bank debit, with valid previews for each executing actor.
  const tx = await seedMovementTransaction(client, "legacy_race_tx", 731), modern = await make("legacy_race", { amount_cents: 731, transaction_id: tx });
  await test.api(`/admin/banking/transactions/${tx}/review`, { expected_revision: 0, expected_source_version: 1,
    mode: "categorize", category_list_id: expenseAccount, comment: "Owned isolated cross-writer race" });
  await test.api(`/admin/banking/transactions/${tx}/confirm`, { expected_revision: 1, expected_source_version: 1 });
  const legacyBase = `/admin/banking/accounting/transactions/${tx}`, legacy = await test.api(legacyBase);
  await test.api(legacyBase, { expected_revision: 0, source_hash: legacy.source_hash, nature: "new_direct_expense", reference: prefix + "old_expense",
    description: "Synthetic cross-writer contention", attested: true,
    dismissals: (legacy.candidates as Array<{ key: string; definite: boolean }>).filter(c => !c.definite)
      .map(c => ({ key: c.key, reason: "Unrelated document; owned synthetic verification only" })) });
  const oldPreview = await previewAccountingExpense(tx, actor + "old", randomUUID(), { expected_revision: 1 });
  const newPreview = await previewMovement(modern.ctx.movement.id, actor + "new", randomUUID(), { expected_revision: 1 });
  const race = await Promise.allSettled([
    postAccountingExpense(tx, actor + "old", randomUUID(), { expected_revision: 1, preview_hash: oldPreview.preview_hash }),
    postMovement(modern.ctx.movement.id, actor + "new", randomUUID(), { expected_revision: 1, preview_hash: newPreview.preview_hash }),
  ]);
  test.check(race.filter(r => r.status === "fulfilled").length === 1, "Legacy expense and new movement SQL guards permit one bank transaction owner");
  const winners = (await client.query("SELECT id,kind FROM bank_journal_entry WHERE transaction_id=$1 AND kind<>'reversal'", [tx])).rows;
  assert.equal(winners.length, 1);
  await test.api(winners[0].kind === "expense" ? legacyBase + "/reverse" : `${base}/${modern.ctx.movement.id}/reverse`,
    { posting_id: winners[0].id, day: laterDay, reason: "Reverse owned cross-writer race winner" });
  // Real lock observation: hold only the period key, wait until the post is blocked, then release.
  const waiting = await make("period_wait"), ready = await test.api(`${base}/${waiting.ctx.movement.id}/preview`, { expected_revision: 1 });
  const holder = await getDbPool().connect(); let pending: Promise<Value> | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,7242))", ["accounting-period:" + day.slice(0, 7)]);
    pending = test.api(`${base}/${waiting.ctx.movement.id}/post`, { expected_revision: 1, preview_hash: ready.preview_hash });
    let blockedByPeriod = false;
    for (let i = 0; i < 60; i++) {
      blockedByPeriod = Boolean((await holder.query(`SELECT 1 FROM pg_locks waiter JOIN pg_locks holder
        ON holder.locktype=waiter.locktype AND holder.database=waiter.database AND holder.classid=waiter.classid
        AND holder.objid=waiter.objid AND holder.objsubid=waiter.objsubid WHERE holder.pid=pg_backend_pid()
        AND holder.locktype='advisory' AND holder.granted AND NOT waiter.granted LIMIT 1`)).rowCount);
      if (blockedByPeriod) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    test.check(blockedByPeriod, "Posting demonstrably waits for the shared accounting period lock");
    await holder.query("COMMIT"); await pending;
  } finally { await holder.query("ROLLBACK"); if (pending) await pending.catch(() => undefined); holder.release(); }
  // V10 source ownership race requires a pre-existing verified setup, never overwrites operator setup.
  const setup = (await client.query("SELECT cut_date FROM bank_accounting_setup WHERE id='local-usd'")).rows[0];
  assert(setup, "Parent verifier must provide local-usd setup before V11 opening-clear check");
  const cutDate = String(setup.cut_date);
  assert(cutDate <= day && cutDate > "1900-01-01");
  const originalDay = new Date(Date.parse(cutDate + "T12:00:00Z") - 86400000).toISOString().slice(0, 10);
  const ev = await test.evidence(prefix + "opening.pdf");
  const opening = await test.save({ expected_revision: 0, kind: "bank", bank_account_id: banks[0], book_balance_cents: 0,
    statement_balance_cents: 911, statement_evidence_id: ev, books_evidence_id: ev, reference: prefix + "opening",
    items: [{ ...openingItem("outstanding_check", 911, prefix + "opening_check", ev), original_day: originalDay }] });
  const adopted = await test.adopt(opening.opening.id), item = adopted.items[0]!;
  const openingTx = await seedMovementTransaction(client, "opening_race_tx", 911), competitor = await make("opening_race", { amount_cents: 911, transaction_id: openingTx });
  const competitorPreview = await test.api(`${base}/${competitor.ctx.movement.id}/preview`, { expected_revision: 1 });
  const openingRace = await Promise.all([
    test.api(`${openingApiBase}/items/${item.id}/clear`, { transaction_id: openingTx, expected_source_version: 1,
      expected_item_hash: item.source_hash }, [200, 409]),
    test.api(`${base}/${competitor.ctx.movement.id}/post`, { expected_revision: 1, preview_hash: competitorPreview.preview_hash }, [200, 409]),
  ]);
  const count = (await client.query(`SELECT (SELECT count(*) FROM bank_opening_clear c WHERE transaction_id=$1 AND kind='clear'
      AND NOT EXISTS(SELECT 1 FROM bank_opening_clear r WHERE r.reverses_clear_id=c.id)) +
    (SELECT count(*) FROM bank_journal_entry e WHERE transaction_id=$1 AND kind='movement'
      AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id)) AS n`, [openingTx])).rows[0].n;
  test.check(Number(count) === 1 && openingRace.filter(r => r.code).length === 1, "Opening clear and movement race cannot create both zero-GL and new-GL claims");
  void loanAccount;
}
