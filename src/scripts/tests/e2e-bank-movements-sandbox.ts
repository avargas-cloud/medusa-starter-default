/** V11 real HTTP/PG. Parent verifier supplies the verified snapshot and applies V11–V13 first. */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { getDbPool } from "../../api/utils/db-pool";
import { configureCompletionSandbox, completionBankCaps } from "./bank-completion-fixtures";
import { OpeningSandboxApi } from "../../lib/banking/opening-sandbox-api";
import { postMovement, previewMovement } from "../../lib/banking/movement-core";
import type { MovementAllocation, MovementContext, MovementInput, MovementPreview } from "../../lib/banking/movement-types";
import { runMovementAdversarial } from "../../lib/banking/movement-sandbox-adversarial";
import { movementPrefix as prefix, movementActor as actor, movementAccounts as banks, movementDay as day,
  movementLaterDay as laterDay, seedMovementAccounts, ensureMovementSetup, seedMovementTransaction, seedMovementRefund,
  movementFixtureMutation, cleanMovementFixtures, fingerprints, bankingFingerprint } from "./bank-movements-fixtures";

type Value = Record<string, unknown>;
export type MovementBrowserOptions = { allowMutations: true; fixtureOwner: string;
  movementDraft: { id: string; post: true; pdfBase64: string } };
export type MovementBrowserHook = (options: MovementBrowserOptions) => Promise<{ checks: number; artifacts?: string[] }>;
export async function runBankMovementsSandbox(snapshot: { file: string; sha256: string }, browser?: MovementBrowserHook) {
  configureCompletionSandbox();
  const bytes = readFileSync(snapshot.file);
  assert(bytes.length > 1000 && bytes.subarray(0, 5).toString() === "PGDMP");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), snapshot.sha256, "Verified parent snapshot hash is exact");
  const pool = getDbPool(), client = await pool.connect(), test = new OpeningSandboxApi();
  let owns = false, seeded = false;
  let before: Value | undefined, banksBefore: Value | undefined;
  let browserChecks = 0; const browserArtifacts: string[] = [], evidencePdfs = new Map<string, string>();
  const base = "/admin/banking/movements";
  const context = (id: string) => test.api(`${base}/${id}`) as Promise<MovementContext>;
  const preview = (ctx: MovementContext) => test.api(`${base}/${ctx.movement.id}/preview`,
    { expected_revision: ctx.movement.revision }) as Promise<MovementPreview>;
  const post = async (ctx: MovementContext) => {
    const p = await preview(ctx); assert.deepEqual(p.blockers, []);
    return test.api(`${base}/${ctx.movement.id}/post`, { expected_revision: ctx.movement.revision, preview_hash: p.preview_hash }) as Promise<MovementContext>;
  };
  const reverse = async (ctx: MovementContext, postingId: string, expected = 200) => test.api(`${base}/${ctx.movement.id}/reverse`,
    { posting_id: postingId, day: laterDay, reason: "Owned V11 explicit correction" }, expected);
  const report = async () => {
    const r = (await test.api("/admin/reports/profit-loss/statement?from=2026-09-01&to=2026-09-30")).current as Value;
    return { expense: Math.round(Number((r.expense as Value).total) * 100), income: Math.round(Number(r.net_income) * 100) };
  };
  const evidence = async (suffix: string) => {
    // Real minimal PDF with correct offsets; each document has a distinct, readable economic reference.
    const stream = `BT /F1 10 Tf 10 50 Td (${prefix}${suffix}) Tj ET\n`;
    const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
    let pdf = "%PDF-1.4\n"; const offsets = [0];
    for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const pdfBase64 = Buffer.from(pdf).toString("base64");
    const result = await test.api("/admin/banking/evidence", { name: prefix + suffix + ".pdf", mime_type: "application/pdf",
      content_base64: pdfBase64 });
    const id = String((result.evidence as Value).id); evidencePdfs.set(id, pdfBase64); return id;
  };
  let loanAccount = "", expenseAccount = "", transitAccount = "", payableAccount = "", payrollAccount = "", refundAccount = "";
  const make = async (suffix: string, overrides: Partial<MovementInput> = {}) => {
    const ev = await evidence(suffix), amount = overrides.amount_cents ?? 10000;
    const body: MovementInput = { expected_revision: 0, kind: "loan_payment", reference: prefix + suffix,
      description: "Owned documented local bank movement", day, bank_account_id: banks[0], transaction_id: null,
      evidence_id: ev, amount_cents: amount, attested: true, destination_bank_account_id: null, transit_account_list_id: null,
      allocations: [{ role: "principal", account_list_id: loanAccount, amount_cents: amount, source_kind: "document",
        source_id: prefix + suffix, documented_capacity_cents: amount, documented_as_of: day, recognition_owner: "existing", evidence_id: ev }],
      ...overrides };
    // Caller supplies source/amount overrides, evidence always belongs to this specific synthetic document.
    body.allocations = body.allocations.map(a => ({ ...a, evidence_id: ev }));
    return { body, ctx: await test.api(base, body) as MovementContext };
  };
  try {
    owns = Boolean((await client.query("SELECT pg_try_advisory_lock(hashtextextended('e2e-bank-completion',7241)) ok")).rows[0].ok);
    test.check(owns, "Single completion harness owns V11 fixtures");
    for (const migration of ["Migration20260909180000", "Migration20260909190000", "Migration20260909200000"])
      assert((await client.query("SELECT 1 FROM mikro_orm_migrations WHERE name=$1", [migration])).rowCount, `Applied prerequisite ${migration}`);
    before = await fingerprints(client); banksBefore = await bankingFingerprint(client);
    for (const [table, row] of Object.entries(banksBefore)) {
      assert(completionBankCaps[table] !== undefined && Number((row as { count: string }).count) <= completionBankCaps[table]!);
    }
    assert(!(await client.query("SELECT 1 FROM bank_connection WHERE starts_with(id,$1)", [prefix])).rowCount,
      "Stale fixtures require explicit recovery; do not silently fold them into the baseline");
    await seedMovementAccounts(client); seeded = true; await ensureMovementSetup(); await test.login();
    await test.api(base, undefined, 401, undefined, true);
    const accounts = (await test.api(base + "/accounts")).accounts as Array<{ id: string; account_type: string; currency: string | null }>;
    const choose = (types: string[]) => { const a = accounts.find(a => types.includes(a.account_type) && (!a.currency || a.currency === "USD")); assert(a, `Existing typed account ${types}`); return a.id; };
    loanAccount = choose(["LongTermLiability", "OtherCurrentLiability"]); expenseAccount = choose(["Expense"]);
    transitAccount = choose(["OtherCurrentAsset"]); payableAccount = choose(["AccountsPayable"]);
    payrollAccount = choose(["OtherCurrentLiability"]); refundAccount = choose(["AccountsReceivable"]);
    for (const kind of ["vendor_bill", "wire", "payroll", "refund"]) {
      const empty = await test.api(`${base}/sources?kind=${kind}&q=${prefix}impossible`);
      test.check((empty.sources as unknown[]).length === 0 && empty.more === false, `${kind} lookup SQL binds a no-match target`);
    }
    const baseline = await report(), tx = await seedMovementTransaction(client, "loan_tx", 10000);
    const allocation = (role: "principal" | "interest", account: string, cents: number): MovementAllocation => ({ role,
      account_list_id: account, amount_cents: cents, source_kind: "document", source_id: prefix + role,
      documented_capacity_cents: cents, documented_as_of: day, recognition_owner: role === "principal" ? "existing" : "new", evidence_id: "pending" });
    const loan = await make("loan", { transaction_id: tx, allocations: [allocation("principal", loanAccount, 9000), allocation("interest", expenseAccount, 1000)] });
    const p = await preview(loan.ctx), postBody = { expected_revision: 1, preview_hash: p.preview_hash }, key = randomUUID();
    assert.deepEqual(p.lines.map(l => [l.role, l.debit_cents, l.credit_cents]), [["bank", 0, 10000], ["counterpart_0", 9000, 0], ["expense", 1000, 0]]);
    const posted = await test.api(`${base}/${loan.ctx.movement.id}/post`, postBody, 200, key) as MovementContext;
    assert.deepEqual(await test.api(`${base}/${loan.ctx.movement.id}/post`, postBody, 200, key), posted);
    await test.api(`${base}/${loan.ctx.movement.id}/post`, { ...postBody, preview_hash: "0".repeat(64) }, 409, key);
    await test.api(base, { ...loan.body, id: loan.ctx.movement.id, expected_revision: 1 }, 409);
    const aliasDocument = await test.api(base, { ...loan.body, transaction_id: null, reference: prefix + "renamed-proof",
      allocations: loan.body.allocations.map((a, i) => ({ ...a, source_id: prefix + "new-random-reference-" + i })) }) as MovementContext;
    const duplicateProof = await test.api(`${base}/${aliasDocument.movement.id}/preview`, { expected_revision: 1 }, 409);
    test.check(duplicateProof.code === "BANKING_SOURCE_OVERCONSUMED", "Changing document IDs cannot enlarge the same evidence capacity");
    const changed = await report(); test.check(changed.expense - baseline.expense === 1000 && changed.income - baseline.income === -1000, "Loan100 = principal90 + new Expense10 exactly once");
    const documents = (await test.api("/admin/reports/expenses/documents?from=2026-09-01&to=2026-09-30")).documents as Value[];
    test.check(documents.filter(r => r.document_id === posted.postings[0]!.id).length === 1, "Movement expense has one navigable report row");
    const privatePdf = await fetch(`${process.env.BANKING_SANDBOX_API_BASE ?? "http://localhost:9099"}/admin/banking/evidence/${loan.body.evidence_id}`, { headers: { Authorization: `Bearer ${test.jwt}` } });
    test.check(privatePdf.status === 200 && privatePdf.headers.get("cache-control")?.includes("no-store") &&
      Buffer.from(await privatePdf.arrayBuffer()).subarray(0, 5).toString() === "%PDF-", "Evidence downloads privately as real PDF");
    const transferTx = await seedMovementTransaction(client, "transfer_out", 5000);
    const incomingTx = await seedMovementTransaction(client, "transfer_in", -5000, banks[1], laterDay);
    const transfer = await make("transfer", { kind: "bank_transfer", amount_cents: 5000, transaction_id: transferTx,
      destination_bank_account_id: banks[1], transit_account_list_id: transitAccount, allocations: [] });
    const out = await post(transfer.ctx), outgoing = out.postings.find(e => e.completion_stage === "outgoing")!;
    const incoming = { expected_revision: 1, day: laterDay, transaction_id: incomingTx };
    const inPreview = await test.api(`${base}/${out.movement.id}/receive-preview`, incoming) as MovementPreview;
    assert.deepEqual(inPreview.blockers, []);
    const receiveBody = { ...incoming, preview_hash: inPreview.preview_hash }, receiveKey = randomUUID();
    const both = await test.api(`${base}/${out.movement.id}/receive`, receiveBody, 200, receiveKey) as MovementContext;
    assert.deepEqual(await report(), changed, "Both bank dates create no P&L");
    test.check(both.postings.length === 2 && new Set(both.postings.map(e => e.day)).size === 2, "Transfer posts each bank on its own date");
    await movementFixtureMutation(client,"UPDATE bank_transaction SET source_version=source_version+1 WHERE id=$1",[incomingTx]);
    test.check((await context(out.movement.id)).blockers.includes("BANKING_MOVEMENT_SOURCE_STALE"),
      "Incoming transfer source drift is visible and blocks statement reconciliation");
    await movementFixtureMutation(client,"UPDATE bank_transaction SET source_version=source_version-1 WHERE id=$1",[incomingTx]);
    test.check((await context(out.movement.id)).blockers.length===0,"Restoring exact incoming evidence clears its drift warning");
    await reverse(both, outgoing.id, 409);
    await reverse(both, both.postings.find(e => e.completion_stage === "incoming")!.id);
    await reverse(both, outgoing.id);
    assert.deepEqual(await report(), changed);
    const race = await make("race"), raceId = race.ctx.movement.id;
    const racePreview = await preview(race.ctx), raceBody = { expected_revision: 1, preview_hash: racePreview.preview_hash };
    const same = await Promise.all([test.api(`${base}/${raceId}/post`, raceBody, 200, "same-key"), test.api(`${base}/${raceId}/post`, raceBody, 200, "same-key")]);
    assert.deepEqual(same[0], same[1]); test.check(true, "Concurrent exact-key retries return one committed journal");
    const contested = await make("different-key");
    const pa = await previewMovement(contested.ctx.movement.id, actor + "a", randomUUID(), { expected_revision: 1 });
    await previewMovement(contested.ctx.movement.id, actor + "b", randomUUID(), { expected_revision: 1 });
    const outcomes = await Promise.allSettled(["a", "b"].map(a => postMovement(contested.ctx.movement.id, actor + a, randomUUID(), { expected_revision: 1, preview_hash: pa.preview_hash })));
    test.check(outcomes.filter(r => r.status === "fulfilled").length === 1, "Different actors and keys cannot duplicate a movement");
    const refund = await seedMovementRefund(client, "source"), refundTx = await seedMovementTransaction(client, "refund_tx", 1234);
    const matched = await make("refund", { kind: "refund_match", amount_cents: 1234, transaction_id: refundTx,
      allocations: [{ ...allocation("principal", refundAccount, 1234), source_kind: "refund", source_id: refund }] });
    await post(matched.ctx); assert.deepEqual(await report(), changed, "Existing refund matched without duplicate expense or revenue");
    await movementFixtureMutation(client, "UPDATE customer_payment SET amount=1235,raw_amount=jsonb_build_object('value','1235','precision',20) WHERE id=$1", [refund]);
    test.check((await context(matched.ctx.movement.id)).blockers.includes("BANKING_MOVEMENT_SOURCE_STALE"), "Posted source drift remains visible without journal mutation");
    await runMovementAdversarial({ client, test, make, post, evidence, loanAccount, expenseAccount, payableAccount, payrollAccount });
    await reverse(posted, posted.postings[0]!.id); assert.deepEqual(await report(), baseline, "Explicit loan reversal removes only the new interest expense");
    if (browser) {
      const browserTransaction = await seedMovementTransaction(client, "browser_loan_tx", 4321);
      const draft = await make("browser_loan", { amount_cents: 4321, transaction_id: browserTransaction, attested: false });
      const pdfBase64 = evidencePdfs.get(draft.body.evidence_id); assert(pdfBase64, "Owned browser PDF is available");
      const result = await browser({ allowMutations: true, fixtureOwner: prefix,
        movementDraft: { id: draft.ctx.movement.id, post: true, pdfBase64 } });
      test.check(Number.isSafeInteger(result.checks) && result.checks > 0, "V11 real browser returned executed checks");
      browserChecks += result.checks; browserArtifacts.push(...result.artifacts ?? []);
      const browserPosted = await context(draft.ctx.movement.id);
      const active = browserPosted.postings.filter(entry => entry.kind === "movement" && !entry.reversed_by);
      assert.equal(active.length, 1, "Browser posts exactly one owned loan journal");
      assert.equal(browserPosted.movement.revision, 2, "Browser saved its evidence and attestation before preview/post");
      test.check(browserPosted.movement.attested && active[0]!.amount_cents === 4321
        && active[0]!.lines.some(line => line.role === "bank" && line.credit_cents === 4321)
        && active[0]!.lines.some(line => line.account_list_id === loanAccount && line.debit_cents === 4321)
        && !active[0]!.lines.some(line => line.role.startsWith("expense")),
      "Browser principal43.21 clears the documented loan and bank with no Expense");
      assert.deepEqual(await report(), baseline, "Browser loan principal leaves P&L unchanged");
      await reverse(browserPosted, active[0]!.id);
      const corrected = await context(browserPosted.movement.id);
      test.check(corrected.postings.filter(entry => entry.kind === "reversal").length === 1
        && corrected.postings.find(entry => entry.id === active[0]!.id)?.reversed_by,
      "Owned browser loan is explicitly reversed before fixture cleanup");
      assert.deepEqual(await report(), baseline, "Browser loan reversal preserves the exact P&L baseline");
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    console.error("V11_ORIGINAL_FAILURE", code, error instanceof Error ? error.message : "UNKNOWN_ERROR");
    throw error;
  } finally {
    try { if (owns) { await client.query("ROLLBACK"); if (seeded) await cleanMovementFixtures(client);
      if (before) assert.deepEqual(await fingerprints(client), before, "Protected financial documents unchanged");
      if (banksBefore) assert.deepEqual(await bankingFingerprint(client), banksBefore, "Banking baseline restored exactly");
      await client.query("SELECT pg_advisory_unlock(hashtextextended('e2e-bank-completion',7241))");
    } } finally { client.release(); }
  }
  console.log(`PASS V11 real HTTP/PG: ${test.checks} checks; browser=${browserChecks}; owned residue=0; protected fingerprints unchanged`);
  return { checks: test.checks, browser_checks: browserChecks, browser_artifacts: browserArtifacts,
    owned_residue: 0, protected_unchanged: true };
}
// Deliberately no implicit main: importing this file cannot mutate the sandbox.
