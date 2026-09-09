/** V10-only verification helpers; reuse the existing owned receipt fixture identities. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import { withReviewLock } from "../../lib/banking/review-common";
import { transaction } from "../../lib/banking/store";

import {
  fingerprints,
  bankingFingerprint,
  account,
  cleanReceiptFixtures,
} from "./bank-receipts-fixtures";

export {
  account,
  actor,
  connection,
  rootPrefix,
  paymentPrefix,
  day,
  laterDay,
  fingerprints,
  bankingFingerprint,
  seedReceiptAccount,
  seedReceiptPayment,
  seedReceiptMovement,
  cleanReceiptFixtures,
} from "./bank-receipts-fixtures";
export const openingPrefix = "bank_e2e_openings_v10_";
export const openingTables = [
  "bank_opening_balance",
  "bank_opening_item",
  "bank_opening_clear",
  "bank_opening_evidence",
] as const;
const caps: Record<string, number> = {
  // V11-V13 tables use the exact approved completionBankCaps; legacy limits stay unchanged.
  bank_movement: 150,
  bank_movement_allocation: 2000,
  bank_source_claim: 3000,
  bank_evidence_document: 100,
  bank_merchant_settlement: 100,
  bank_merchant_settlement_line: 2000,
  bank_statement: 36,
  bank_statement_line: 5000,
  bank_statement_match: 5000,
  bank_review_permission: 25,
  bank_review_event: 10000,
  bank_connection: 3,
  bank_account: 10,
  bank_transaction: 2000,
  bank_transaction_review: 2000,
  bank_review_rule: 100,
  bank_day_close: 62,
  bank_review_attachment: 25,
  bank_sync_run: 100,
  bank_webhook_event: 2000,
  bank_deposit: 100,
  bank_deposit_line: 2000,
  bank_journal_entry: 1000,
  bank_journal_line: 4000,
  bank_direct_expense: 200,
  bank_accounting_setup: 10,
  bank_receipt_accounting: 200,
  bank_receipt_consumption: 2000,
  bank_opening_balance: 20,
  bank_opening_item: 2000,
  bank_opening_clear: 2000,
  bank_opening_evidence: 50,
};

export async function openingPreflight(client: PoolClient) {
  const url = new URL(process.env.DATABASE_URL!);
  assert(
    ["localhost", "127.0.0.1"].includes(url.hostname) &&
      url.port === "5499" &&
      url.pathname === "/medusa"
  );
  assert.equal(
    (await client.query("SELECT current_database() db")).rows[0].db,
    "medusa"
  );
  const before = await bankingFingerprint(client);
  for (const [table, row] of Object.entries(before)) {
    const limit = caps[table];
    assert(
      limit !== undefined,
      `Bank table ${table} needs an explicit approved cap`
    );
    assert(
      Number((row as { count: string }).count) <= limit,
      `${table} exceeds approved cap ${limit}`
    );
  }
  const columns = (
    await client.query(`SELECT column_name,is_nullable FROM information_schema.columns
    WHERE table_schema='public' AND table_name='customer_payment' ORDER BY ordinal_position`)
  ).rows;
  const triggers = (
    await client.query(`SELECT t.tgname,t.tgenabled,pg_get_functiondef(p.oid) definition
    FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE t.tgrelid='customer_payment'::regclass AND NOT t.tgisinternal ORDER BY t.tgname`)
  ).rows;
  assert(
    columns.some(
      (row) => row.column_name === "raw_amount" && row.is_nullable === "NO"
    )
  );
  assert(
    triggers.length === 1 &&
      triggers[0].tgname === "trg_order_money_payment" &&
      triggers[0].tgenabled === "O"
  );
  assert(
    triggers[0].definition.includes("WHERE x IS NOT NULL"),
    "Orderless source fixtures cannot affect order projection"
  );
  console.log(
    "PASS v10 sandbox destination, table caps and orderless source trigger preflight",
    before
  );
}

export async function openingSnapshot(client: PoolClient) {
  const file = resolve(
    __dirname,
    "../../../../sandbox-artifacts/snapshots/pre-bank-openings-v10.dump"
  );
  const before = await fingerprints(client);
  if (!existsSync(file)) {
    assert(
      !(
        await client.query(
          "SELECT to_regclass('public.bank_opening_balance') name"
        )
      ).rows[0].name,
      "First v10 snapshot must precede the new migration"
    );
    const bytes = execFileSync(
      "sg",
      [
        "docker",
        "-c",
        "docker exec sb_postgres pg_dump -U postgres -d medusa -Fc",
      ],
      { maxBuffer: 256 * 1024 * 1024 }
    );
    assert(bytes.length > 1000);
    writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
    writeFileSync(
      file.replace(/dump$/, "fingerprints.json"),
      JSON.stringify(before, null, 2),
      { mode: 0o600, flag: "wx" }
    );
  }
  const toc = await new Promise<string>((done, reject) => {
    const child = spawn(
      "sg",
      ["docker", "-c", "docker exec -i sb_postgres pg_restore --list"],
      { stdio: ["pipe", "pipe", "ignore"] }
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.on("close", (code) =>
      code === 0
        ? done(Buffer.concat(chunks).toString())
        : reject(new Error("V10_SNAPSHOT_TOC_FAILED"))
    );
    child.stdin.end(readFileSync(file));
  });
  for (const table of [
    ...Object.keys(before),
    "bank_journal_entry",
    "bank_journal_line",
    "bank_receipt_consumption",
    "bank_deposit",
  ]) {
    assert(toc.includes(` ${table} `), `Snapshot includes ${table}`);
  }
  writeFileSync(file.replace(/dump$/, "toc"), toc, { mode: 0o600 });
  assert.deepEqual(
    await fingerprints(client),
    before,
    "Snapshot preserves protected financial documents"
  );
  console.log(
    `PASS v10 snapshot/TOC and ${Object.keys(before).length} protected table fingerprints`
  );
}

/** New opening FKs are removed before the reused receipt harness deletes its owned account/setup. */
export async function cleanOpeningFixtures(client: PoolClient) {
  await transaction(client, async () => {
    await withReviewLock(client);
    await client.query(`LOCK TABLE bank_journal_entry,bank_journal_line,bank_receipt_consumption,
      bank_opening_clear,bank_opening_item,bank_opening_balance,bank_opening_evidence IN ACCESS EXCLUSIVE MODE`);
    const openings = (
      await client.query(
        "SELECT id FROM bank_opening_balance WHERE starts_with(reference,$1)",
        [openingPrefix]
      )
    ).rows.map((row) => String(row.id));
    const evidence = (
      await client.query(
        "SELECT id FROM bank_opening_evidence WHERE starts_with(original_name,$1)",
        [openingPrefix]
      )
    ).rows.map((row) => String(row.id));
    const entries = (
      await client.query(
        "SELECT id FROM bank_journal_entry WHERE deposit_id IN (SELECT id FROM bank_deposit WHERE account_id=$1)",
        [account]
      )
    ).rows.map((row) => String(row.id));
    const deposits = (
      await client.query("SELECT id FROM bank_deposit WHERE account_id=$1", [
        account,
      ])
    ).rows.map((row) => String(row.id));
    assert(
      openings.length <= 20 &&
        evidence.length <= 50 &&
        entries.length <= 1000 &&
        deposits.length <= 100
    );
    const ownItems = (
      await client.query(
        "SELECT id FROM bank_opening_item WHERE opening_id=ANY($1::text[])",
        [openings]
      )
    ).rows.map((row) => String(row.id));
    assert(
      !(
        await client.query(
          `SELECT 1 FROM bank_receipt_consumption WHERE opening_item_id=ANY($1::text[]) AND NOT(entry_id=ANY($2::text[]))
      UNION ALL SELECT 1 FROM bank_deposit_line WHERE opening_item_id=ANY($1::text[]) AND NOT(deposit_id=ANY($3::text[]))`,
          [ownItems, entries, deposits]
        )
      ).rowCount,
      "Never delete an opening with foreign consuming document"
    );
    const guards = [
      ["bank_journal_line", "bank_journal_line_immutable"],
      ["bank_journal_entry", "bank_journal_entry_immutable"],
      ["bank_receipt_consumption", "bank_receipt_consumption_immutable"],
      ...openingTables.map((table) => [table, table + "_immutable"]),
    ] as const;
    const names = guards.map((row) => row[1]);
    const before = (
      await client.query(
        "SELECT tgname,tgenabled FROM pg_trigger WHERE tgname=ANY($1::text[]) ORDER BY tgname",
        [names]
      )
    ).rows;
    assert(
      before.length === guards.length &&
        before.every((row) => row.tgenabled === "O")
    );
    for (const [table, trigger] of guards)
      await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    await client.query(
      "DELETE FROM bank_receipt_consumption WHERE entry_id=ANY($1::text[])",
      [entries]
    );
    await client.query(
      "DELETE FROM bank_journal_line WHERE entry_id=ANY($1::text[])",
      [entries]
    );
    await client.query(
      "DELETE FROM bank_journal_entry WHERE id=ANY($1::text[]) AND kind='reversal'",
      [entries]
    );
    await client.query(
      "DELETE FROM bank_journal_entry WHERE id=ANY($1::text[])",
      [entries]
    );
    // Keep deposit headers for reused cleanup to identify their command receipts; only source FKs leave now.
    await client.query(
      "DELETE FROM bank_deposit_line WHERE deposit_id=ANY($1::text[])",
      [deposits]
    );
    await client.query(
      "DELETE FROM bank_opening_clear WHERE item_id=ANY($1::text[])",
      [ownItems]
    );
    await client.query(
      "DELETE FROM bank_opening_item WHERE opening_id=ANY($1::text[])",
      [openings]
    );
    await client.query(
      "DELETE FROM bank_opening_balance WHERE id=ANY($1::text[])",
      [openings]
    );
    await client.query(
      "DELETE FROM bank_opening_evidence WHERE id=ANY($1::text[])",
      [evidence]
    );
    await client.query(
      `DELETE FROM bank_review_event WHERE entity_id=ANY($1::text[]) OR entity_id=ANY($2::text[])
      OR entity_id=ANY($3::text[]) OR (entity_type='command' AND
        (result->'opening'->>'id'=ANY($1::text[]) OR result->'evidence'->>'id'=ANY($3::text[])
          OR (action='deposit_save' AND result->'deposit'->>'account_id'=$4
            AND starts_with(result->'deposit'->>'reference',$5))))`,
      [openings, ownItems, evidence, account, openingPrefix]
    );
    for (const [table, trigger] of guards)
      await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    assert.deepEqual(
      (
        await client.query(
          "SELECT tgname,tgenabled FROM pg_trigger WHERE tgname=ANY($1::text[]) ORDER BY tgname",
          [names]
        )
      ).rows,
      before
    );
  });
  await cleanReceiptFixtures(client);
}
