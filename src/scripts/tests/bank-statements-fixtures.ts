/** Owned V13 fixture rows; parent executes only after the approved snapshot/migrations. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { transaction } from "../../lib/banking/store";
import { withReviewLock } from "../../lib/banking/review-common";
import { completionBankCaps, completionDirectory } from "./bank-completion-fixtures";
import { fingerprints, bankingFingerprint } from "./bank-accounting-fixtures";
export { fingerprints, bankingFingerprint };
export const statementPrefix = "e2e_bank_completion_statements_";
export const statementAccount = statementPrefix + "bank", statementConnection = statementPrefix + "connection";
export async function statementMutation(client: PoolClient, sql: string, values: unknown[]) {
  await transaction(client, async () => { await withReviewLock(client); await client.query(sql, values); });
}
export async function seedStatementAccount(client: PoolClient) {
  await transaction(client, async () => {
    await withReviewLock(client);
    for (const table of ["bank_connection", "bank_account"]) assert(Number((await client.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n) < completionBankCaps[table]!);
    const bank = (await client.query(`SELECT qb_list_id FROM qb_account q WHERE q.is_active AND q.deleted_at IS NULL
      AND q.account_type='Bank' AND q.currency IN ('USD','US Dollar') AND NOT EXISTS(SELECT 1 FROM bank_opening_balance b
        WHERE b.account_list_id=q.qb_list_id AND b.status='adopted') ORDER BY qb_list_id LIMIT 1`)).rows[0]; assert(bank);
    await client.query(`INSERT INTO bank_connection(id,provider,environment,provider_item_id,status,initial_sync_complete,
      historical_sync_complete,last_successful_sync_at) VALUES($1,'plaid','sandbox',$1,'active',true,true,now())`, [statementConnection]);
    await client.query(`INSERT INTO bank_account(id,connection_id,provider_account_id,name,type,currency,is_selected,qb_list_id,
      review_start_date,opening_bank_balance,opening_balance_date,opening_reference,setup_revision)
      VALUES($1,$2,$1,$1,'depository','USD',true,$3,'2000-01-01','0','1999-12-31',$1,1)`, [statementAccount, statementConnection, bank.qb_list_id]);
  });
}
export async function seedStatementTransaction(client: PoolClient, suffix: string, cents: number, day: string) {
  const id = statementPrefix + suffix;
  await statementMutation(client, `INSERT INTO bank_transaction(id,connection_id,account_id,provider_transaction_id,amount,currency,
    status,transaction_date,name,source_data,first_seen_at,last_seen_at)
    VALUES($1,$2,$3,$1,$4::numeric,'USD','posted',$5,$1,'{}',now(),now())`,
  [id, statementConnection, statementAccount, (-cents / 100).toFixed(2), day]);
  return id;
}
export type StatementRecovery = { ownSetup: boolean; setupEventIds: string[];
  expectedSetupHash: string | null; bankingBaseline: Record<string, unknown> };
export async function cleanStatementFixtures(client: PoolClient, ownSetup: boolean, setupEventIds: string[], recovery?: StatementRecovery) {
  await transaction(client, async () => {
    await withReviewLock(client);
    const protectedBefore = await fingerprints(client);
    assert(setupEventIds.length <= 2 && new Set(setupEventIds).size === setupEventIds.length);
    if (recovery) {
      assert(recovery.ownSetup === ownSetup && JSON.stringify(recovery.setupEventIds) === JSON.stringify(setupEventIds));
      const setup = (await client.query("SELECT md5(to_jsonb(s)::text) hash FROM bank_accounting_setup s WHERE id='local-usd'")).rows[0];
      assert.equal(setup?.hash ?? null, recovery.expectedSetupHash, "Exact reviewed setup fingerprint required for recovery");
      if (ownSetup) assert.equal((recovery.bankingBaseline.bank_accounting_setup as { count: string }).count, "0");
      assert((await client.query("SELECT id FROM bank_review_event WHERE id=ANY($1::text[]) AND entity_id='local-usd'", [setupEventIds])).rowCount === setupEventIds.length);
    }
    const guards = [["bank_statement", "bank_statement_document_guard"], ["bank_statement_line", "bank_statement_line_guard"],
      ["bank_statement_match", "bank_statement_match_guard"], ["bank_opening_item", "bank_opening_item_immutable"],
      ["bank_opening_balance", "bank_opening_balance_immutable"], ["bank_opening_evidence", "bank_opening_evidence_immutable"],
      ["bank_evidence_document", "bank_evidence_document_immutable"], ["bank_journal_entry", "bank_journal_entry_immutable"],
      ["bank_journal_line", "bank_journal_line_immutable"], ["bank_source_claim", "bank_source_claim_immutable"],
      ["bank_movement", "bank_movement_immutable"], ["bank_movement_allocation", "bank_movement_allocation_immutable"]] as const;
    await client.query(`LOCK TABLE ${guards.map(([table]) => table).join(",")} IN ACCESS EXCLUSIVE MODE`);
    const statements = (await client.query("SELECT id FROM bank_statement WHERE starts_with(payload->>'reference',$1)", [statementPrefix])).rows.map(r => String(r.id));
    const openings = (await client.query("SELECT id FROM bank_opening_balance WHERE starts_with(reference,$1)", [statementPrefix])).rows.map(r => String(r.id));
    const items = (await client.query("SELECT id FROM bank_opening_item WHERE opening_id=ANY($1::text[])", [openings])).rows.map(r => String(r.id));
    const evidence = (await client.query("SELECT id FROM bank_evidence_document WHERE starts_with(original_name,$1)", [statementPrefix])).rows.map(r => String(r.id));
    const openingEvidence = (await client.query("SELECT id FROM bank_opening_evidence WHERE starts_with(original_name,$1)", [statementPrefix])).rows.map(r => String(r.id));
    assert(statements.length <= 36 && openings.length <= 20 && items.length <= 2000 && evidence.length <= 100);
    assert(!(await client.query(`SELECT 1 FROM bank_statement WHERE opening_id=ANY($1::text[]) AND NOT(id=ANY($2::text[]))
      UNION ALL SELECT 1 FROM bank_statement_match WHERE book_kind='opening_item' AND book_id=ANY($3::text[]) AND NOT(statement_id=ANY($2::text[]))
      UNION ALL SELECT 1 FROM bank_opening_clear WHERE item_id=ANY($3::text[])
      UNION ALL SELECT 1 FROM bank_receipt_consumption WHERE opening_item_id=ANY($3::text[])`, [openings, statements, items])).rowCount);
    const movements = (await client.query("SELECT id FROM bank_movement WHERE starts_with(reference,$1)", [statementPrefix])).rows.map(row => String(row.id));
    const entries = (await client.query("SELECT id FROM bank_journal_entry WHERE completion_id=ANY($1::text[])", [movements])).rows.map(row => String(row.id));
    assert(movements.length <= 2 && entries.length <= 4);
    assert(!(await client.query(`SELECT 1 FROM bank_statement_match WHERE book_kind='journal_line'
      AND book_id IN(SELECT id FROM bank_journal_line WHERE entry_id=ANY($1::text[])) AND NOT(statement_id=ANY($2::text[]))
      UNION ALL SELECT 1 FROM bank_source_claim WHERE source_kind='journal_funding' AND source_id=ANY($1::text[])`, [entries, statements])).rowCount);
    const names = guards.map(([, name]) => name);
    const state = (await client.query("SELECT tgname,tgenabled FROM pg_trigger WHERE tgname=ANY($1::text[]) ORDER BY tgname", [names])).rows;
    assert(state.length === names.length && state.every(row => row.tgenabled === "O"));
    for (const [table, name] of guards) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${name}`);
    await client.query("DELETE FROM bank_statement_match WHERE statement_id=ANY($1::text[])", [statements]);
    await client.query("DELETE FROM bank_statement_line WHERE statement_id=ANY($1::text[])", [statements]);
    await client.query("UPDATE bank_statement SET predecessor_id=NULL WHERE id=ANY($1::text[])", [statements]);
    await client.query("DELETE FROM bank_statement WHERE id=ANY($1::text[])", [statements]);
    await client.query("DELETE FROM bank_source_claim WHERE entry_id=ANY($1::text[])", [entries]);
    await client.query("DELETE FROM bank_journal_line WHERE entry_id=ANY($1::text[])", [entries]);
    await client.query("DELETE FROM bank_journal_entry WHERE id=ANY($1::text[]) AND kind='reversal'", [entries]);
    await client.query("DELETE FROM bank_journal_entry WHERE id=ANY($1::text[])", [entries]);
    await client.query("DELETE FROM bank_movement_allocation WHERE movement_id=ANY($1::text[])", [movements]);
    await client.query("DELETE FROM bank_movement WHERE id=ANY($1::text[])", [movements]);
    await client.query("DELETE FROM bank_opening_item WHERE id=ANY($1::text[])", [items]);
    await client.query("DELETE FROM bank_opening_balance WHERE id=ANY($1::text[])", [openings]);
    await client.query("DELETE FROM bank_opening_evidence WHERE id=ANY($1::text[])", [openingEvidence]);
    await client.query("DELETE FROM bank_evidence_document WHERE id=ANY($1::text[])", [evidence]);
    // Parent-link updates queue deferred close/FK checks; drain them before any ALTER TABLE.
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    for (const [table, name] of guards) await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${name}`);
    assert.deepEqual((await client.query("SELECT tgname,tgenabled FROM pg_trigger WHERE tgname=ANY($1::text[]) ORDER BY tgname", [names])).rows, state);
    const entities = [...statements, ...openings, ...items, ...evidence, ...openingEvidence, ...movements, ...entries];
    await client.query(`DELETE FROM bank_review_event WHERE entity_id=ANY($1::text[]) OR starts_with(entity_id,$2)
      OR starts_with(transaction_id,$2) OR id=ANY($3::text[]) OR (entity_type='command' AND
        (result->'movement'->>'id'=ANY($1::text[]) OR result->'statement'->>'id'=ANY($1::text[]) OR result->'opening'->>'id'=ANY($1::text[]) OR result->'evidence'->>'id'=ANY($1::text[])))`,
    [entities, statementPrefix, setupEventIds]);
    for (const table of ["bank_transaction_review", "bank_review_attachment"]) await client.query(`DELETE FROM ${table} WHERE starts_with(transaction_id,$1)`, [statementPrefix]);
    for (const table of ["bank_transaction", "bank_account"]) await client.query(`DELETE FROM ${table} WHERE connection_id=$1`, [statementConnection]);
    await client.query("DELETE FROM bank_connection WHERE id=$1", [statementConnection]);
    if (ownSetup) await client.query("DELETE FROM bank_accounting_setup WHERE id='local-usd'");
    assert(!(await client.query(`SELECT 1 FROM bank_statement WHERE starts_with(payload->>'reference',$1)
      UNION ALL SELECT 1 FROM bank_connection WHERE id=$2 UNION ALL SELECT 1 FROM bank_review_event WHERE entity_id=ANY($3::text[])`,
    [statementPrefix, statementConnection, entities])).rowCount, "Owned statements residue zero");
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    assert.deepEqual(await fingerprints(client), protectedBefore, "Cleanup preserves every protected source inside its transaction");
    if (recovery) assert.deepEqual(await bankingFingerprint(client), recovery.bankingBaseline, "Recovery restores reviewed Banking baseline atomically");
  });
}
export async function recoverStatementFixtures(client: PoolClient, recovery: StatementRecovery) {
  const target = new URL(process.env.DATABASE_URL ?? "");
  assert(["localhost", "127.0.0.1"].includes(target.hostname) && target.port === "5499" && target.pathname === "/medusa");
  assert.equal((await client.query("SELECT current_database() name")).rows[0].name, "medusa");
  assert(recovery && typeof recovery.ownSetup === "boolean" && Object.keys(recovery.bankingBaseline).length > 0);
  await cleanStatementFixtures(client, recovery.ownSetup, recovery.setupEventIds, recovery);
}

/** One interrupted run, proven empty baseline and successful preceding suite cleanup. No DB writes outside exact cleanup. */
export async function recoverStatementFixturesFromEvidence(client: PoolClient, baselineFile: string, resultsFile: string) {
  assert.equal(baselineFile, `${completionDirectory}/preflight-1788963814199.json`);
  assert.equal(resultsFile, `${completionDirectory}/e2e-result-1788963814360.json`);
  const evidence = JSON.parse(readFileSync(baselineFile, "utf8")) as { target: string; captured_at: string; data: Record<string, { count: string; hash: string }> };
  const results = JSON.parse(readFileSync(resultsFile, "utf8")) as Record<string, { owned_residue: number; protected_unchanged: boolean }>;
  assert.equal(evidence.target, "localhost:5499/medusa");
  for (const phase of ["movements", "settlements"]) assert(results[phase]?.owned_residue === 0 && results[phase]?.protected_unchanged === true);
  const bankingBaseline = Object.fromEntries(Object.entries(evidence.data).filter(([table]) => table.startsWith("bank_")));
  assert(Object.keys(bankingBaseline).length === 32 && Object.values(bankingBaseline).every(row => row.count === "0" && row.hash === "d41d8cd98f00b204e9800998ecf8427e"));
  const actual = await bankingFingerprint(client);
  if (JSON.stringify(actual) === JSON.stringify(bankingBaseline)) return { recovered: false, already_clean: true };
  const setup = (await client.query<{ hash: string; actor_id: string }>(`SELECT md5(to_jsonb(s)::text) hash,s.actor_id FROM bank_accounting_setup s
    JOIN public.user u ON u.id=s.actor_id WHERE s.id='local-usd' AND s.revision=1 AND s.cut_date='2026-09-01'
    AND s.currency='USD' AND s.attested AND s.deleted_at IS NULL AND s.created_at>$1::timestamptz
    AND u.email='sandbox@test.com' AND u.deleted_at IS NULL`, [evidence.captured_at])).rows[0];
  assert(setup, "Only the proven V13-created setup may be recovered");
  const receipts = (await client.query<{ id: string }>(`SELECT e.id FROM bank_review_event e JOIN bank_accounting_setup s ON s.id=e.entity_id
    WHERE e.entity_type='command' AND e.entity_id='local-usd' AND e.action='receipt_setup' AND e.actor_id=$1
    AND e.created_at>$2::timestamptz AND ((e.result->'setup')-'frozen')=jsonb_build_object('id',s.id,'revision',s.revision,
      'cut_date',s.cut_date,'currency',s.currency,'ar_account',s.ar_account_snapshot,'clearing_account',s.clearing_account_snapshot,'attested',s.attested)`,
  [setup.actor_id, evidence.captured_at])).rows;
  assert.equal(receipts.length, 1, "Exactly one creation receipt must match the current setup fields and actor");
  assert.equal((await client.query("SELECT count(*)::int n FROM bank_review_event WHERE entity_id='local-usd'")).rows[0].n, 1);
  const recovery: StatementRecovery = { ownSetup: true, setupEventIds: receipts.map(row => row.id), expectedSetupHash: setup.hash, bankingBaseline };
  writeFileSync(`${completionDirectory}/statements-recovery-interrupted.json`, JSON.stringify({ baselineFile, resultsFile, ...recovery }, null, 2), { mode: 0o600 });
  await recoverStatementFixtures(client, recovery);
  return { recovered: true, owned_residue: 0, protected_unchanged: true };
}
