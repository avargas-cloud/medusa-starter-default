/** Own v9 sandbox fixtures. Existing Finance documents are protected by fingerprints. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { transaction } from "../../lib/banking/store";
import { withReviewLock } from "../../lib/banking/review-common";
import { fingerprints, bankingFingerprint } from "./bank-accounting-fixtures";

export { fingerprints, bankingFingerprint };
export const rootPrefix = "bank_e2e_receipts_v9_";
export const paymentPrefix = "cpay_e2e_receipts_v9_";
export const connection = rootPrefix + "connection";
export const account = rootPrefix + "account";
export const actor = rootPrefix + "actor";
export const day = "2026-09-02";
export const laterDay = "2026-09-08";
export const closeNote = "EPT owned banking receipts v9 month verification";

export async function seedReceiptAccount(client: PoolClient) {
  await transaction(client, async () => {
    await withReviewLock(client);
    assert(!(await client.query("SELECT 1 FROM bank_connection WHERE id=$1", [connection])).rowCount);
    const caps = (await client.query(`SELECT (SELECT count(*) FROM bank_connection)::int c,
      (SELECT count(*) FROM bank_account)::int a`)).rows[0];
    assert(caps.c < 3 && caps.a < 10);
    const bank = (await client.query(`SELECT qb_list_id FROM qb_account WHERE is_active AND deleted_at IS NULL
      AND account_type='Bank' AND currency IN ('USD','US Dollar') ORDER BY qb_list_id LIMIT 1`)).rows[0];
    assert(bank);
    await client.query(`INSERT INTO bank_connection(id,provider,environment,provider_item_id,status,
      initial_sync_complete,historical_sync_complete,last_successful_sync_at)
      VALUES($1,'plaid','sandbox',$1,'active',true,true,now())`, [connection]);
    await client.query(`INSERT INTO bank_account(id,connection_id,provider_account_id,name,type,currency,is_selected,qb_list_id,
      review_start_date,opening_bank_balance,opening_balance_date,opening_reference,setup_revision)
      VALUES($1,$2,$1,'EPT owned receipts v9 test','depository','USD',true,$3,'2000-01-01','0','1999-12-31',
        'Synthetic opening for isolated v9 fixture only',1)`, [account, connection, bank.qb_list_id]);
  });
}

export async function seedReceiptPayment(client: PoolClient, suffix: string, cents = 12001, date = day, method = "check") {
  const id = paymentPrefix + suffix;
  assert(Number.isSafeInteger(cents) && cents > 0);
  await transaction(client, async () => {
    await withReviewLock(client);
    assert((await client.query("SELECT count(*)::int n FROM customer_payment WHERE starts_with(id,$1)", [paymentPrefix])).rows[0].n < 40);
    const customer = (await client.query("SELECT id FROM customer WHERE deleted_at IS NULL ORDER BY id LIMIT 1")).rows[0];
    assert(customer);
    // No order pointers: the existing money-projection trigger has no target and cannot mutate an order.
    await client.query(`INSERT INTO customer_payment(id,customer_id,source,type,amount,raw_amount,currency,method,
      status,received_at,batch_day,reference,metadata,created_by)
      VALUES($1,$2,'pos','payment',$3::numeric,jsonb_build_object('value',($3::numeric)::text,'precision',20),'usd',$4,'available',
        $5::timestamptz,$6,$7,'{}',$8)`, [id, customer.id, cents, method, date + "T16:00:00Z", date, rootPrefix + suffix, actor]);
  });
  return id;
}

export async function seedReceiptMovement(client: PoolClient, suffix: string, amount = "-120.01", date = day) {
  const id = rootPrefix + suffix;
  await transaction(client, async () => {
    await withReviewLock(client);
    assert((await client.query("SELECT count(*)::int n FROM bank_transaction")).rows[0].n < 2000);
    await client.query(`INSERT INTO bank_transaction(id,connection_id,account_id,provider_transaction_id,amount,currency,status,
      transaction_date,name,source_data,first_seen_at,last_seen_at) VALUES($1,$2,$3,$1,$4::numeric,'USD','posted',$5,
      'EPT synthetic receipts v9 bank evidence','{}',now(),now())`, [id, connection, account, amount, date]);
  });
  return id;
}

/** A valid v8 journal exists before ALTER, so migration preservation is not tested on an empty ledger. */
export async function seedLegacyJournal(client: PoolClient) {
  await seedReceiptAccount(client);
  const transactionId = await seedReceiptMovement(client, "legacy", "8.73", "2000-01-03");
  const entryId = rootPrefix + "legacy_entry";
  await transaction(client, async () => {
    await withReviewLock(client);
    const bank = (await client.query(`SELECT q.qb_list_id id,q.full_name name,q.account_type,'USD' currency
      FROM qb_account q JOIN bank_account a ON a.qb_list_id=q.qb_list_id WHERE a.id=$1`, [account])).rows[0];
    const expense = (await client.query(`SELECT qb_list_id id,full_name name,account_type,'USD' currency FROM qb_account
      WHERE is_active AND deleted_at IS NULL AND account_type='Expense' AND (currency IS NULL OR currency IN ('USD','US Dollar'))
      ORDER BY qb_list_id LIMIT 1`)).rows[0];
    assert(bank && expense);
    const expenseId = rootPrefix + "legacy_expense";
    await client.query(`INSERT INTO bank_direct_expense(id,transaction_id,revision,nature,reference,description,attested,
      source_hash,created_by,updated_by) VALUES($1,$2,1,'new_direct_expense',$1,'Owned legacy v8 migration probe',true,$3,$4,$4)`,
    [expenseId, transactionId, "f".repeat(64), actor]);
    await client.query(`INSERT INTO bank_journal_entry(id,expense_id,transaction_id,kind,day,currency,amount_cents,
      source_hash,source_snapshot,reference,description,actor_id) VALUES($1,$2,$3,'expense','2000-01-03','USD',873,$4,
      '{"source":{"name":"Owned legacy v8 migration probe"}}',$1,'Owned legacy v8 migration probe',$5)`,
    [entryId, expenseId, transactionId, "f".repeat(64), actor]);
    for (const [role, source, debit, credit] of [["bank", bank, 0, 873], ["expense", expense, 873, 0]] as const) {
      await client.query(`INSERT INTO bank_journal_line(id,entry_id,role,account_list_id,account_snapshot,debit_cents,credit_cents)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`, [entryId + "_" + role, entryId, role, source.id, JSON.stringify(source), debit, credit]);
    }
  });
  return entryId;
}

export async function cleanReceiptFixtures(client: PoolClient) {
  await transaction(client, async () => {
    await withReviewLock(client);
    await client.query("LOCK TABLE bank_journal_entry,bank_journal_line,bank_receipt_consumption,bank_receipt_accounting IN ACCESS EXCLUSIVE MODE");
    const entries = (await client.query(`SELECT e.id FROM bank_journal_entry e WHERE starts_with(e.transaction_id,$1)
      OR e.receipt_id IN (SELECT id FROM bank_receipt_accounting WHERE starts_with(payment_id,$2))
      OR e.deposit_id IN (SELECT id FROM bank_deposit WHERE account_id=$3)`, [rootPrefix, paymentPrefix, account])).rows.map(row => row.id as string);
    const deposits = (await client.query("SELECT id FROM bank_deposit WHERE account_id=$1", [account])).rows.map(row => row.id as string);
    const entities = [...entries, ...deposits, ...(await client.query("SELECT id FROM customer_payment WHERE starts_with(id,$1)", [paymentPrefix])).rows.map(row => row.id as string)];
    const foreign = async () => (await client.query(`SELECT md5(COALESCE(string_agg(to_jsonb(e)::text,'' ORDER BY e.id),'')) h
      FROM (SELECT e.id,to_jsonb(e) header,(SELECT jsonb_agg(l ORDER BY l.id) FROM bank_journal_line l WHERE l.entry_id=e.id) lines,
        (SELECT jsonb_agg(c ORDER BY c.id) FROM bank_receipt_consumption c WHERE c.entry_id=e.id) consumption
        FROM bank_journal_entry e WHERE NOT(e.id=ANY($1::text[]))) e`, [entries])).rows;
    const before = await foreign();
    const guards = [["bank_journal_line", "bank_journal_line_immutable"], ["bank_journal_entry", "bank_journal_entry_immutable"],
      ["bank_receipt_consumption", "bank_receipt_consumption_immutable"], ["bank_receipt_accounting", "bank_receipt_accounting_immutable"]] as const;
    const state = (await client.query("SELECT tgname,tgenabled FROM pg_trigger WHERE tgname=ANY($1::text[]) ORDER BY tgname", [guards.map(row => row[1])])).rows;
    assert(state.length === 4 && state.every(row => row.tgenabled === "O"));
    for (const [table, name] of guards) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${name}`);
    await client.query("DELETE FROM bank_receipt_consumption WHERE entry_id=ANY($1::text[])", [entries]);
    await client.query("DELETE FROM bank_journal_line WHERE entry_id=ANY($1::text[])", [entries]);
    await client.query("DELETE FROM bank_journal_entry WHERE id=ANY($1::text[]) AND kind='reversal'", [entries]);
    await client.query("DELETE FROM bank_journal_entry WHERE id=ANY($1::text[])", [entries]);
    await client.query("DELETE FROM bank_receipt_accounting WHERE starts_with(payment_id,$1)", [paymentPrefix]);
    for (const [table, name] of guards) await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${name}`);
    assert.deepEqual((await client.query("SELECT tgname,tgenabled FROM pg_trigger WHERE tgname=ANY($1::text[]) ORDER BY tgname", [guards.map(row => row[1])])).rows, state);
    assert.deepEqual(await foreign(), before, "Scoped immutable cleanup preserves all foreign journal/consumption data");
    assert(!(await client.query("SELECT 1 FROM bank_receipt_accounting LIMIT 1")).rowCount,
      "Never delete shared accounting setup if another operator created a receipt");
    await client.query("DELETE FROM bank_accounting_setup WHERE id='local-usd'");
    await client.query("DELETE FROM bank_direct_expense WHERE starts_with(transaction_id,$1)", [rootPrefix]);
    const closes = (await client.query("SELECT id,inventory_snapshots FROM accounting_period_close WHERE close_note=$1", [closeNote])).rows;
    assert(closes.length <= 20);
    const snapshots = closes.flatMap(row => (row.inventory_snapshots as { snapshotId: string }[]).map(item => item.snapshotId));
    assert(snapshots.length <= 40);
    await client.query("DELETE FROM inventory_valuation_snapshot_line WHERE snapshot_id=ANY($1::text[])", [snapshots]);
    await client.query("DELETE FROM inventory_valuation_snapshot WHERE id=ANY($1::text[])", [snapshots]);
    await client.query("DELETE FROM accounting_period_close WHERE id=ANY($1::text[])", [closes.map(row => row.id)]);
    await client.query(`DELETE FROM bank_review_event WHERE starts_with(transaction_id,$1) OR starts_with(entity_id,$1)
      OR starts_with(entity_id,$2) OR starts_with(actor_id,$1) OR entity_id=ANY($3::text[]) OR entity_id='local-usd'
      OR (entity_type='command' AND action='deposit_save' AND result->'deposit'->>'account_id'=$4
        AND starts_with(result->'deposit'->>'reference',$1))`, [rootPrefix, paymentPrefix, entities, account]);
    for (const table of ["bank_review_attachment", "bank_transaction_review"]) {
      await client.query(`DELETE FROM ${table} WHERE starts_with(transaction_id,$1)`, [rootPrefix]);
    }
    await client.query("DELETE FROM bank_review_permission WHERE starts_with(id,$1)", [rootPrefix]);
    await client.query("DELETE FROM bank_deposit_line WHERE deposit_id=ANY($1::text[])", [deposits]);
    await client.query("DELETE FROM bank_deposit WHERE id=ANY($1::text[])", [deposits]);
    for (const table of ["bank_webhook_event", "bank_sync_run", "bank_transaction", "bank_account"]) {
      await client.query(`DELETE FROM ${table} WHERE connection_id=$1`, [connection]);
    }
    await client.query("DELETE FROM bank_connection WHERE id=$1", [connection]);
    await client.query("DELETE FROM customer_payment WHERE starts_with(id,$1)", [paymentPrefix]);
    assert(!(await client.query(`SELECT 1 FROM customer_payment WHERE starts_with(id,$1) UNION ALL
      SELECT 1 FROM bank_connection WHERE id=$2 UNION ALL SELECT 1 FROM bank_review_event WHERE starts_with(entity_id,$1)
      OR starts_with(entity_id,$3) OR entity_id='local-usd'`, [paymentPrefix, connection, rootPrefix])).rowCount);
  });
}

/** Failure recovery before the v9 schema exists; only the owned legacy migration probe. */
export async function cleanLegacyProbe(client: PoolClient) {
  await transaction(client, async () => {
    await withReviewLock(client);
    await client.query("LOCK TABLE bank_journal_entry,bank_journal_line IN ACCESS EXCLUSIVE MODE");
    const names = ["bank_journal_entry_immutable", "bank_journal_line_immutable"];
    const guards = (await client.query("SELECT tgname,tgenabled FROM pg_trigger WHERE tgname=ANY($1::text[]) ORDER BY tgname", [names])).rows;
    assert(guards.length === 2 && guards.every(row => row.tgenabled === "O"));
    await client.query("ALTER TABLE bank_journal_line DISABLE TRIGGER bank_journal_line_immutable");
    await client.query("ALTER TABLE bank_journal_entry DISABLE TRIGGER bank_journal_entry_immutable");
    await client.query("DELETE FROM bank_journal_line WHERE entry_id IN (SELECT id FROM bank_journal_entry WHERE starts_with(transaction_id,$1))", [rootPrefix]);
    await client.query("DELETE FROM bank_journal_entry WHERE starts_with(transaction_id,$1) AND kind='reversal'", [rootPrefix]);
    await client.query("DELETE FROM bank_journal_entry WHERE starts_with(transaction_id,$1)", [rootPrefix]);
    await client.query("ALTER TABLE bank_journal_entry ENABLE TRIGGER bank_journal_entry_immutable");
    await client.query("ALTER TABLE bank_journal_line ENABLE TRIGGER bank_journal_line_immutable");
    await client.query("DELETE FROM bank_direct_expense WHERE starts_with(transaction_id,$1)", [rootPrefix]);
    await client.query("DELETE FROM bank_transaction WHERE connection_id=$1", [connection]);
    await client.query("DELETE FROM bank_account WHERE connection_id=$1", [connection]);
    await client.query("DELETE FROM bank_connection WHERE id=$1", [connection]);
  });
}

export async function receiptSnapshot(client: PoolClient) {
  const file = resolve(__dirname, "../../../../sandbox-artifacts/snapshots/pre-bank-receipts-v9.dump");
  const before = await fingerprints(client);
  if (!existsSync(file)) {
    assert(!(await client.query("SELECT to_regclass('public.bank_accounting_setup') AS name")).rows[0].name,
      "First v9 snapshot must precede the new migration");
    const bytes = execFileSync("sg", ["docker", "-c", "docker exec sb_postgres pg_dump -U postgres -d medusa -Fc"],
      { maxBuffer: 256 * 1024 * 1024 });
    assert(bytes.length > 1000);
    writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
    writeFileSync(file.replace(/dump$/, "fingerprints.json"), JSON.stringify(before, null, 2), { mode: 0o600, flag: "wx" });
  }
  const toc = await new Promise<string>((done, reject) => {
    const child = spawn("sg", ["docker", "-c", "docker exec -i sb_postgres pg_restore --list"], { stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = []; child.stdout.on("data", chunk => chunks.push(Buffer.from(chunk)));
    child.on("error", reject); child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") reject(error); });
    child.on("close", code => code === 0 ? done(Buffer.concat(chunks).toString()) : reject(new Error("V9_SNAPSHOT_TOC_FAILED")));
    child.stdin.end(readFileSync(file));
  });
  for (const table of [...Object.keys(before), "bank_journal_entry", "bank_journal_line", "bank_deposit"]) {
    assert(toc.includes(` ${table} `), `Snapshot includes ${table}`);
  }
  writeFileSync(file.replace(/dump$/, "toc"), toc, { mode: 0o600 });
  assert.deepEqual(await fingerprints(client), before, "Snapshot preserves protected documents");
  console.log(`PASS v9 snapshot/TOC and ${Object.keys(before).length} protected table fingerprints`);
}
