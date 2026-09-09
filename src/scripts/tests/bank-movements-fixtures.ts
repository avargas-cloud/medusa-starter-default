/** V11 fixtures. Source rows are isolated orderless refunds and one explicitly owned payroll month. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import {
  readReceiptSetup,
  saveReceiptSetup,
} from "../../lib/banking/receipts-setup";
import { withReviewLock } from "../../lib/banking/review-common";
import { transaction } from "../../lib/banking/store";

import { completionBankCaps } from "./bank-completion-fixtures";

export { fingerprints, bankingFingerprint } from "./bank-accounting-fixtures";
export const movementPrefix = "e2e_bank_completion_movements_";
export const movementConnection = movementPrefix + "connection";
export const movementActor = movementPrefix + "actor";
export const movementAccounts = [
  movementPrefix + "bank_a",
  movementPrefix + "bank_b",
] as const;
export const movementDay = "2026-09-02",
  movementLaterDay = "2026-09-08";
export const movementPayrollMonth = "2026-02",
  movementPayrollId = movementPrefix + "payroll_2026_02";

export async function seedMovementPayroll(client: PoolClient) {
  await transaction(client, async () => {
    await withReviewLock(client);
    await client.query(
      "LOCK TABLE pos_monthly_payroll IN SHARE ROW EXCLUSIVE MODE"
    );
    assert(
      !(
        await client.query(`SELECT 1 FROM pg_trigger WHERE tgrelid='pos_monthly_payroll'::regclass AND NOT tgisinternal
      UNION ALL SELECT 1 FROM pg_constraint WHERE contype='f' AND
      (conrelid='pos_monthly_payroll'::regclass OR confrelid='pos_monthly_payroll'::regclass)`)
      ).rowCount,
      "Payroll fixture closure remains free of triggers and foreign keys"
    );
    assert(
      !(
        await client.query(
          "SELECT 1 FROM pos_monthly_payroll WHERE month=$1 OR id=$2",
          [movementPayrollMonth, movementPayrollId]
        )
      ).rowCount,
      "Never overwrite an existing payroll month"
    );
    assert(
      Number(
        (
          await client.query(
            "SELECT count(*)::int n FROM pos_monthly_payroll WHERE starts_with(id,$1)",
            ["e2e_bank_completion_"]
          )
        ).rows[0].n
      ) < 3
    );
    const foreign = async () =>
      (
        await client.query(
          `SELECT count(*)::text n,md5(coalesce(string_agg(to_jsonb(p)::text,'' ORDER BY id),'')) hash
      FROM pos_monthly_payroll p WHERE id<>$1`,
          [movementPayrollId]
        )
      ).rows[0];
    const before = await foreign();
    await client.query(
      `INSERT INTO pos_monthly_payroll(id,month,amount_cents,note,updated_by_user_id)
      VALUES($1,$2,101,$3,$4)`,
      [
        movementPayrollId,
        movementPayrollMonth,
        movementPrefix + "isolated payroll installment fixture",
        movementActor,
      ]
    );
    assert.deepEqual(
      await foreign(),
      before,
      "Existing payroll rows unchanged while adding owned fixture"
    );
  });
}

export async function ensureMovementSetup() {
  const context = await readReceiptSetup();
  if (context.setup) return;
  const ar = context.ar_accounts[0],
    clearing = context.clearing_accounts[0];
  assert(ar && clearing, "Existing AR and clearing accounts required");
  await saveReceiptSetup(movementActor, randomUUID(), {
    expected_revision: 0,
    cut_date: "2000-01-01",
    ar_account_list_id: ar.id,
    clearing_account_list_id: clearing.id,
    local_usd_attested: true,
  });
}

export async function movementFixtureMutation(
  client: PoolClient,
  sql: string,
  values: unknown[]
) {
  await transaction(client, async () => {
    await withReviewLock(client);
    await client.query(sql, values);
  });
}
export async function seedMovementAccounts(client: PoolClient) {
  await transaction(client, async () => {
    await withReviewLock(client);
    for (const [table, extra] of [
      ["bank_connection", 1],
      ["bank_account", 2],
    ] as const) {
      assert(
        Number(
          (await client.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n
        ) +
          extra <=
          completionBankCaps[table]!
      );
    }
    const banks = (
      await client.query(`SELECT qb_list_id FROM qb_account WHERE is_active AND deleted_at IS NULL
      AND account_type='Bank' AND currency IN ('USD','US Dollar') ORDER BY qb_list_id LIMIT 2`)
    ).rows;
    assert.equal(
      banks.length,
      2,
      "Two existing typed USD bank accounts required; never synthesize qb_account"
    );
    await client.query(
      `INSERT INTO bank_connection(id,provider,environment,provider_item_id,status,
      initial_sync_complete,historical_sync_complete,last_successful_sync_at)
      VALUES($1,'plaid','sandbox',$1,'active',true,true,now())`,
      [movementConnection]
    );
    for (const [index, id] of movementAccounts.entries())
      await client.query(
        `INSERT INTO bank_account
      (id,connection_id,provider_account_id,name,type,currency,is_selected,qb_list_id,review_start_date,
       opening_bank_balance,opening_balance_date,opening_reference,setup_revision)
      VALUES($1,$2,$1,$1,'depository','USD',true,$3,'2000-01-01','0','1999-12-31',$4,1)`,
        [
          id,
          movementConnection,
          banks[index]!.qb_list_id,
          movementPrefix + "documented-opening",
        ]
      );
  });
}
export async function seedMovementTransaction(
  client: PoolClient,
  suffix: string,
  cents: number,
  account: string = movementAccounts[0],
  day = movementDay
) {
  assert(
    Number.isSafeInteger(cents) &&
      cents !== 0 &&
      movementAccounts.includes(account as (typeof movementAccounts)[number])
  );
  const id = movementPrefix + suffix;
  await transaction(client, async () => {
    await withReviewLock(client);
    assert(
      Number(
        (await client.query("SELECT count(*)::int n FROM bank_transaction"))
          .rows[0].n
      ) < completionBankCaps.bank_transaction!
    );
    await client.query(
      `INSERT INTO bank_transaction(id,connection_id,account_id,provider_transaction_id,amount,currency,
      status,transaction_date,name,source_data,first_seen_at,last_seen_at)
      VALUES($1,$2,$3,$1,$4::numeric,'USD','posted',$5,$1,'{}',now(),now())`,
      [id, movementConnection, account, (cents / 100).toFixed(2), day]
    );
  });
  return id;
}
export async function seedMovementRefund(
  client: PoolClient,
  suffix: string,
  cents = 1234
) {
  const id = movementPrefix + "refund_" + suffix;
  await transaction(client, async () => {
    await withReviewLock(client);
    const triggers = (
      await client.query(`SELECT t.tgname,t.tgenabled,pg_get_functiondef(p.oid) definition
      FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='customer_payment'::regclass
      AND NOT t.tgisinternal ORDER BY t.tgname`)
    ).rows;
    assert(
      triggers.length === 1 &&
        triggers[0].tgname === "trg_order_money_payment" &&
        triggers[0].tgenabled === "O" &&
        triggers[0].definition.includes("WHERE x IS NOT NULL"),
      "Orderless refund trigger closure changed"
    );
    assert(
      Number(
        (
          await client.query(
            "SELECT count(*)::int n FROM customer_payment WHERE starts_with(id,$1)",
            ["e2e_bank_completion_"]
          )
        ).rows[0].n
      ) < 60
    );
    const customer = (
      await client.query(
        "SELECT id FROM customer WHERE deleted_at IS NULL ORDER BY id LIMIT 1"
      )
    ).rows[0];
    assert(customer);
    await client.query(
      `INSERT INTO customer_payment(id,customer_id,source,type,amount,raw_amount,currency,method,status,
      received_at,batch_day,reference,metadata,created_by)
      VALUES($1,$2,'pos','refund',$3::numeric,jsonb_build_object('value',($3::numeric)::text,'precision',20),
        'usd','ach','available',$4::timestamptz,$5,$1,'{}',$6)`,
      [
        id,
        customer.id,
        cents,
        movementDay + "T16:00:00Z",
        movementDay,
        movementActor,
      ]
    );
  });
  return id;
}

/** Exact named immutable guards only, held under exclusive table locks until restored. */
export async function cleanMovementFixtures(client: PoolClient) {
  await transaction(client, async () => {
    await withReviewLock(client);
    const guards = [
      "bank_journal_entry",
      "bank_journal_line",
      "bank_source_claim",
      "bank_evidence_document",
      "bank_movement",
      "bank_movement_allocation",
      "bank_opening_clear",
      "bank_opening_item",
      "bank_opening_balance",
      "bank_opening_evidence",
    ].map((table) => [table, table + "_immutable"] as const);
    await client.query(
      `LOCK TABLE ${guards.map(([table]) => table).join(",")} IN ACCESS EXCLUSIVE MODE`
    );
    const movements = (
      await client.query(
        "SELECT id FROM bank_movement WHERE starts_with(reference,$1)",
        [movementPrefix]
      )
    ).rows.map((r) => String(r.id));
    const entries = (
      await client.query(
        `SELECT id FROM bank_journal_entry WHERE completion_id=ANY($1::text[])
      OR starts_with(transaction_id,$2)`,
        [movements, movementPrefix]
      )
    ).rows.map((r) => String(r.id));
    const evidence = (
      await client.query(
        "SELECT id FROM bank_evidence_document WHERE starts_with(original_name,$1)",
        [movementPrefix]
      )
    ).rows.map((r) => String(r.id));
    const openings = (
      await client.query(
        "SELECT id FROM bank_opening_balance WHERE starts_with(reference,$1)",
        [movementPrefix]
      )
    ).rows.map((r) => String(r.id));
    const items = (
      await client.query(
        "SELECT id FROM bank_opening_item WHERE opening_id=ANY($1::text[])",
        [openings]
      )
    ).rows.map((r) => String(r.id));
    const openingEvidence = (
      await client.query(
        "SELECT id FROM bank_opening_evidence WHERE starts_with(original_name,$1)",
        [movementPrefix]
      )
    ).rows.map((r) => String(r.id));
    assert(
      movements.length <= 150 &&
        entries.length <= 2000 &&
        evidence.length <= 100 &&
        openings.length <= 20 &&
        items.length <= 2000
    );
    assert(
      !(
        await client.query(
          `SELECT 1 FROM bank_receipt_consumption WHERE opening_item_id=ANY($1::text[])
      UNION ALL SELECT 1 FROM bank_deposit_line WHERE opening_item_id=ANY($1::text[])`,
          [items]
        )
      ).rowCount,
      "Never remove an opening consumed by another document"
    );
    const names = guards.map(([, trigger]) => trigger);
    const state = (
      await client.query(
        `SELECT c.relname,t.tgname,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      WHERE t.tgname=ANY($1::text[]) ORDER BY c.relname,t.tgname`,
        [names]
      )
    ).rows;
    assert(
      state.length === guards.length && state.every((r) => r.tgenabled === "O")
    );
    for (const [table, trigger] of guards)
      await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    await client.query(
      "DELETE FROM bank_source_claim WHERE entry_id=ANY($1::text[])",
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
    await client.query(
      "DELETE FROM bank_movement_allocation WHERE movement_id=ANY($1::text[])",
      [movements]
    );
    await client.query("DELETE FROM bank_movement WHERE id=ANY($1::text[])", [
      movements,
    ]);
    await client.query(
      "DELETE FROM bank_evidence_document WHERE id=ANY($1::text[])",
      [evidence]
    );
    await client.query(
      "DELETE FROM bank_opening_clear WHERE item_id=ANY($1::text[])",
      [items]
    );
    await client.query(
      "DELETE FROM bank_opening_item WHERE id=ANY($1::text[])",
      [items]
    );
    await client.query(
      "DELETE FROM bank_opening_balance WHERE id=ANY($1::text[])",
      [openings]
    );
    await client.query(
      "DELETE FROM bank_opening_evidence WHERE id=ANY($1::text[])",
      [openingEvidence]
    );
    for (const [table, trigger] of guards)
      await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    assert.deepEqual(
      (
        await client.query(
          `SELECT c.relname,t.tgname,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      WHERE t.tgname=ANY($1::text[]) ORDER BY c.relname,t.tgname`,
          [names]
        )
      ).rows,
      state
    );
    if (
      (
        await client.query(
          "SELECT 1 FROM bank_accounting_setup WHERE id='local-usd' AND actor_id=$1",
          [movementActor]
        )
      ).rowCount
    ) {
      assert(
        !(
          await client.query(`SELECT 1 FROM bank_receipt_accounting UNION ALL SELECT 1 FROM bank_opening_balance
        UNION ALL SELECT 1 FROM bank_journal_entry WHERE completion_id IS NOT NULL`)
        ).rowCount,
        "Owned setup cannot be removed after another consumer depends on it"
      );
      await client.query(
        "DELETE FROM bank_accounting_setup WHERE id='local-usd' AND actor_id=$1",
        [movementActor]
      );
    }
    const entities = [
      ...movements,
      ...entries,
      ...evidence,
      ...openings,
      ...items,
      ...openingEvidence,
    ];
    await client.query(
      `DELETE FROM bank_review_event WHERE starts_with(entity_id,$1) OR starts_with(transaction_id,$1)
      OR starts_with(actor_id,$1) OR entity_id=ANY($2::text[]) OR (entity_type='command' AND
        (result->'movement'->>'id'=ANY($2::text[]) OR result->'evidence'->>'id'=ANY($2::text[])
         OR result->'opening'->>'id'=ANY($2::text[])))`,
      [movementPrefix, entities]
    );
    await client.query(
      "DELETE FROM bank_direct_expense WHERE starts_with(transaction_id,$1)",
      [movementPrefix]
    );
    for (const table of ["bank_review_attachment", "bank_transaction_review"])
      await client.query(
        `DELETE FROM ${table} WHERE starts_with(transaction_id,$1)`,
        [movementPrefix]
      );
    await client.query(
      "DELETE FROM bank_review_permission WHERE starts_with(id,$1)",
      [movementPrefix]
    );
    for (const table of [
      "bank_webhook_event",
      "bank_sync_run",
      "bank_transaction",
      "bank_account",
    ])
      await client.query(`DELETE FROM ${table} WHERE connection_id=$1`, [
        movementConnection,
      ]);
    await client.query("DELETE FROM bank_connection WHERE id=$1", [
      movementConnection,
    ]);
    await client.query(
      "DELETE FROM customer_payment WHERE starts_with(id,$1)",
      [movementPrefix]
    );
    await client.query(
      `DELETE FROM pos_monthly_payroll WHERE id=$1 AND month=$2 AND updated_by_user_id=$3
      AND starts_with(note,$4)`,
      [movementPayrollId, movementPayrollMonth, movementActor, movementPrefix]
    );
    assert(
      !(
        await client.query("SELECT 1 FROM pos_monthly_payroll WHERE id=$1", [
          movementPayrollId,
        ])
      ).rowCount,
      "Only the exact owned payroll fixture was removed"
    );
    assert(
      !(
        await client.query(
          `SELECT 1 FROM bank_movement WHERE starts_with(reference,$1) UNION ALL
      SELECT 1 FROM bank_connection WHERE id=$2 UNION ALL SELECT 1 FROM customer_payment WHERE starts_with(id,$1)
      UNION ALL SELECT 1 FROM bank_review_event WHERE entity_id=ANY($3::text[]) OR starts_with(entity_id,$1)
      OR starts_with(actor_id,$1)`,
          [movementPrefix, movementConnection, entities]
        )
      ).rowCount,
      "Owned fixture residue is zero"
    );
  });
}
