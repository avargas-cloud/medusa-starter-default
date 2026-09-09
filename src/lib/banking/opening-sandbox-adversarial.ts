/** Independent money and SQL oracles for the snapshot-protected v10 harness. */
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { OpeningSandboxApi, openingApiBase, openingItem } from "./opening-sandbox-api";
import type { OpeningContext } from "./opening-types";
import { account, openingPrefix, seedReceiptAccount, seedReceiptMovement } from "../../scripts/tests/bank-openings-fixtures";

export async function openingBoundaryCases(test: OpeningSandboxApi, evidenceId: string) {
  // These independent openings are adopted/revoked BEFORE any dependent posting exists.
  for (const amount of [-10000, 0]) {
    const context = await test.save({ expected_revision: 0, kind: "bank", bank_account_id: account,
      book_balance_cents: amount, statement_balance_cents: amount, books_evidence_id: evidenceId,
      statement_evidence_id: evidenceId, reference: openingPrefix + "boundary" + amount, items: [] });
    const adopted = await test.adopt(context.opening.id);
    test.check(adopted.current_book_balance_cents === amount, `Real API accepts evidenced ${amount === 0 ? "zero" : "overdraft"}`);
    await test.api(`${openingApiBase}/${adopted.opening.id}/revoke`, { expected_revision: adopted.opening.revision, reason: "Owned boundary case completed without dependencies" });
  }
  const transit = await test.save({ expected_revision: 0, kind: "bank", bank_account_id: account,
    book_balance_cents: 11800, statement_balance_cents: 0, books_evidence_id: evidenceId, statement_evidence_id: evidenceId,
    reference: openingPrefix + "old-net118", items: [openingItem("deposit_in_transit", 11800, openingPrefix + "old-deposit-gross120-fee2", evidenceId)] });
  const preview = await test.preview(transit.opening.id);
  test.check(preview.difference_cents === 0 && preview.zero_gl, "Old net118 deposit with historical fee2 balances without new expense");
  // Keep as draft for the adopted-parent mutation probe; it creates no balance/capacity.
  return transit;
}

export async function openingSqlProbes(client: PoolClient, test: OpeningSandboxApi, bank: OpeningContext, uf: OpeningContext, draft: OpeningContext) {
  const probe = async (label: string, expected: RegExp, work: () => Promise<void>) => {
    await client.query("BEGIN"); let failure: unknown;
    try { await work(); await client.query("SET CONSTRAINTS ALL IMMEDIATE"); }
    catch (error) { failure = error; }
    finally { await client.query("ROLLBACK"); }
    assert(failure instanceof Error && expected.test(failure.message), `${label}: expected ${expected}, got ${String(failure)}`);
    test.check(true, label);
  };
  for (const [table, id, field, code] of [
    ["bank_opening_balance", bank.opening.id, "reference", /BANKING_OPENING_IMMUTABLE/],
    ["bank_opening_item", uf.items[0]!.id, "reference", /BANKING_OPENING_IMMUTABLE/],
    ["bank_opening_evidence", bank.opening.books_evidence_id!, "original_name", /BANKING_JOURNAL_IMMUTABLE/],
  ] as const) {
    for (const verb of ["UPDATE", "DELETE"]) await probe(`${table} ${verb} cannot alter approved facts`, code,
      async () => { await client.query(verb === "UPDATE" ? `UPDATE ${table} SET ${field}=${field} WHERE id=$1`
        : `DELETE FROM ${table} WHERE id=$1`, [id]); });
  }
  const copy = `INSERT INTO bank_opening_item(id,opening_id,kind,original_day,amount_cents,external_key,
    reference,description,payment_id,evidence_id,source_snapshot,source_hash)
    SELECT $1,$2,kind,original_day,amount_cents,$1,reference,description,NULL,evidence_id,source_snapshot,source_hash
    FROM bank_opening_item WHERE id=$3`;
  await probe("Cannot append an item after baseline adoption", /BANKING_OPENING_IMMUTABLE/,
    async () => { await client.query(copy, [openingPrefix + "sql_append", bank.opening.id, draft.items[0]!.id]); });
  await probe("Cannot move a draft item under an adopted parent", /BANKING_OPENING_IMMUTABLE/,
    async () => { await client.query("UPDATE bank_opening_item SET opening_id=$1 WHERE id=$2", [bank.opening.id, draft.items[0]!.id]); });
  await probe("Typed deposit line rejects simultaneous normal and opening sources", /bank_deposit_funding_source/,
    async () => {
      const external = uf.items.find(item => !item.payment_id); assert(external);
      const line = (await client.query("SELECT id FROM bank_deposit_line WHERE opening_item_id=$1 ORDER BY id LIMIT 1", [external.id])).rows[0];
      assert(line, "Probe must hit a real opening-funded line");
      await client.query("UPDATE bank_deposit_line SET payment_id=$2 WHERE id=$1", [line.id, openingPrefix + "probe-normal-payment"]);
    });
  const linked = uf.items.find(item => item.payment_id); assert(linked);
  const current = (await client.query(`SELECT e.id,e.deposit_id FROM bank_receipt_consumption c JOIN bank_journal_entry e ON e.id=c.entry_id
    WHERE c.opening_item_id=$1 AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id)
    ORDER BY e.id LIMIT 1`, [linked.id])).rows[0]; assert(current);
  // V11's immediate shared-capacity guard may reject before the legacy deferred receipt guard.
  await probe("Direct SQL cannot spend one cent from exhausted initial UF", /^BANKING_(?:RECEIPT|SOURCE)_OVERCONSUMED$/, async () => {
    const id = openingPrefix + "sql_overfund";
    await client.query(`INSERT INTO bank_deposit(id,revision,status,account_id,currency,deposit_date,reference,memo,gross_amount,fee_amount,net_amount,created_by)
      SELECT $1,1,'ready',account_id,currency,deposit_date,$1,'Owned invalid funding probe','0.01','0','0.01',created_by
      FROM bank_deposit WHERE id=$2`, [id, current.deposit_id]);
    await client.query(`INSERT INTO bank_journal_entry(id,deposit_id,kind,day,currency,amount_cents,source_hash,source_snapshot,reference,description,actor_id)
      SELECT $1,$1,'deposit',day,currency,1,source_hash,'{}',$1,'Owned invalid funding probe',actor_id
      FROM bank_journal_entry WHERE id=$2`, [id, current.id]);
    await client.query(`INSERT INTO bank_journal_line(id,entry_id,role,account_list_id,account_snapshot,debit_cents,credit_cents)
      SELECT $1||role,$1,role,account_list_id,account_snapshot,CASE WHEN role='bank' THEN 1 ELSE 0 END,
        CASE WHEN role='clearing' THEN 1 ELSE 0 END FROM bank_journal_line WHERE entry_id=$2 AND role IN ('bank','clearing')`, [id, current.id]);
    await client.query(`INSERT INTO bank_receipt_consumption(id,entry_id,opening_item_id,amount_cents,origin_kind,origin_id)
      VALUES($1,$1,$2,1,'deposit',$1)`, [id, linked.id]);
  });
}

/** Runs after the first case's complete cleanup so it can adopt a different Bank baseline honestly. */
export async function openingTransitCase(client: PoolClient, test: OpeningSandboxApi) {
  await seedReceiptAccount(client); await test.setup("2000-01-01");
  const evidence = await test.evidence(openingPrefix + "historical-transit.pdf");
  const draft = await test.save({ expected_revision: 0, kind: "bank", bank_account_id: account,
    book_balance_cents: 11800, statement_balance_cents: 0, books_evidence_id: evidence, statement_evidence_id: evidence,
    reference: openingPrefix + "old118-clearing", items: [openingItem("deposit_in_transit", 11800, openingPrefix + "old120-less2", evidence)] });
  const bank = await test.adopt(draft.opening.id), item = bank.items[0]!;
  const movement = await seedReceiptMovement(client, "opening_transit", "-118.00", "2000-01-05");
  const wrong = await seedReceiptMovement(client, "opening_transit_wrong", "118.00", "2000-01-05");
  const clear = (id: string) => ({ transaction_id: id, expected_source_version: 1, expected_item_hash: item.source_hash });
  await test.api(`${openingApiBase}/items/${item.id}/clear`, clear(wrong), 409);
  const before = Number((await client.query("SELECT count(*)::int n FROM bank_journal_entry")).rows[0].n);
  const results = await Promise.all([
    test.api(`${openingApiBase}/items/${item.id}/clear`, clear(movement), [200, 409]),
    test.api(`${openingApiBase}/items/${item.id}/clear`, clear(movement), [200, 409]),
  ]);
  test.check(results.filter(row => Boolean(row.opening)).length === 1, "Concurrent independent commands create one historical clear");
  const after = await test.opening(bank.opening.id);
  test.check(after.current_book_balance_cents === 11800 && after.items[0]!.transaction_id === movement,
    "Old deposit gross120/net118 remains Bank118 when it reaches the statement");
  test.check(Number((await client.query("SELECT count(*)::int n FROM bank_journal_entry")).rows[0].n) === before,
    "Historical transit clearing creates no new Bank, UF or expense journal including old fee2");
}
