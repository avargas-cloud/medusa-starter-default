/** Invoked only by the root-owned v9 harness, after its snapshot/target/trigger preflight. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import type { PoolClient } from "pg";

import { POST as postRoute } from "../../api/admin/banking/accounting/receipts/[id]/post/route";
import { POST as previewRoute } from "../../api/admin/banking/accounting/receipts/[id]/preview/route";
import { POST as reverseRoute } from "../../api/admin/banking/accounting/receipts/[id]/reverse/route";
import { POS_USER_MODULE } from "../../modules/pos-user";
import {
  actor,
  account,
  rootPrefix,
  paymentPrefix,
  closeNote,
  seedReceiptPayment,
  seedReceiptMovement,
} from "../../scripts/tests/bank-receipts-fixtures";

import { periodBlockedSessions } from "./opening-sandbox-periods";
import { postReceiptAccounting } from "./receipts-core";
import type { ReceiptPostInput } from "./receipts-types";
import { withReviewLock } from "./review-common";
import { requireBankingSandbox } from "./security";
import { transaction } from "./store";

type Value = Record<string, unknown>;
type Input = {
  client: PoolClient;
  api: (
    path: string,
    body?: Value,
    status?: number,
    key?: string
  ) => Promise<Value>;
  check: (value: unknown, label: string) => void;
  receiptPaymentId: string;
  depositId: string;
};
const object = (value: unknown): Value => {
  assert(value && typeof value === "object" && !Array.isArray(value));
  return value as Value;
};
const base = (id: string): string => `/admin/banking/accounting/receipts/${id}`;

export async function runReceiptAdversarial({
  client,
  api,
  check,
  receiptPaymentId,
  depositId,
}: Input): Promise<void> {
  requireBankingSandbox();
  assert(receiptPaymentId.startsWith(paymentPrefix));
  assert(
    (
      await client.query(
        "SELECT 1 FROM bank_deposit WHERE id=$1 AND account_id=$2",
        [depositId, account]
      )
    ).rowCount
  );
  const original = (
    await client.query(
      `SELECT e.* FROM bank_journal_entry e JOIN bank_receipt_accounting a ON a.id=e.receipt_id
    WHERE a.payment_id=$1 AND e.kind='receipt' AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id)`,
      [receiptPaymentId]
    )
  ).rows[0];
  const deposited = (
    await client.query(
      `SELECT e.* FROM bank_journal_entry e WHERE e.deposit_id=$1 AND e.kind='deposit'
    AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id)`,
      [depositId]
    )
  ).rows[0];
  assert(
    original && deposited,
    "Adversarial input requires active receipt and deposit postings"
  );
  assert(
    (
      await client.query(
        "SELECT 1 FROM bank_receipt_consumption WHERE entry_id=$1 AND receipt_id=$2",
        [deposited.id, original.receipt_id]
      )
    ).rowCount
  );
  const postBody = async (id: string): Promise<ReceiptPostInput> => {
    const live = await api(base(id));
    const preview = await api(`${base(id)}/preview`, {
      expected_source_hash: live.source_hash,
    });
    return {
      expected_source_hash: String(live.source_hash),
      preview_hash: String(preview.preview_hash),
    };
  };
  // Roll back even when a broken constraint ACCEPTS invalid data. No invalid probe can commit.
  const probe = async (
    label: string,
    expected: RegExp | null,
    work: () => Promise<void>
  ): Promise<void> => {
    await client.query("BEGIN");
    let failure: unknown;
    try {
      await work();
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    } catch (error) {
      failure = error;
    } finally {
      await client.query("ROLLBACK");
    }
    if (expected)
      assert(
        failure instanceof Error && expected.test(failure.message),
        `${label}: expected ${expected}, got ${String(failure)}`
      );
    else if (failure) throw failure;
    check(true, label);
  };
  for (const [table, where, id, field] of [
    ["bank_journal_entry", "id", original.id, "reference"],
    ["bank_journal_line", "entry_id", original.id, "account_list_id"],
    ["bank_receipt_accounting", "id", original.receipt_id, "payment_id"],
    ["bank_receipt_consumption", "entry_id", deposited.id, "payment_id"],
  ] as const) {
    for (const verb of ["UPDATE", "DELETE"] as const)
      await probe(
        `${table} rejects ${verb} of recorded facts`,
        /BANKING_JOURNAL_IMMUTABLE/,
        async () => {
          await client.query(
            verb === "UPDATE"
              ? `UPDATE ${table} SET ${field}=${field} WHERE ${where}=$1`
              : `DELETE FROM ${table} WHERE ${where}=$1`,
            [id]
          );
        }
      );
  }
  const freshPayment = await seedReceiptPayment(
    client,
    "pg_probe",
    Number(original.amount_cents)
  );
  const probeEntry = rootPrefix + "pg_entry",
    probeAnchor = rootPrefix + "pg_anchor",
    probeDeposit = rootPrefix + "pg_deposit";
  const cloneReceipt = async (): Promise<void> => {
    await client.query(
      "INSERT INTO bank_receipt_accounting(id,payment_id,setup_id) VALUES($1,$2,'local-usd')",
      [probeAnchor, freshPayment]
    );
    await client.query(
      `INSERT INTO bank_journal_entry(id,receipt_id,kind,day,currency,amount_cents,source_hash,source_snapshot,reference,description,actor_id)
      SELECT $1,$2,'receipt',day,currency,amount_cents,source_hash,source_snapshot,reference,description,actor_id
      FROM bank_journal_entry WHERE id=$3`,
      [probeEntry, probeAnchor, original.id]
    );
  };
  const cloneReceiptLines = async (
    fault: "none" | "role" | "balance"
  ): Promise<void> => {
    await client.query(
      `INSERT INTO bank_journal_line(id,entry_id,role,account_list_id,account_snapshot,debit_cents,credit_cents)
      SELECT $1||role,$1,CASE WHEN $3='role' AND role='clearing' THEN 'bank' ELSE role END,
        account_list_id,account_snapshot,debit_cents,credit_cents+CASE WHEN $3='balance' AND credit_cents>0 THEN 1 ELSE 0 END
      FROM bank_journal_line WHERE entry_id=$2`,
      [probeEntry, original.id, fault]
    );
  };
  await probe(
    "Valid receipt clone satisfies all deferred constraints (rolled back)",
    null,
    async () => {
      await cloneReceipt();
      await cloneReceiptLines("none");
    }
  );
  for (const fault of ["role", "balance"] as const)
    await probe(
      `Receipt rejects ${fault} corruption`,
      /BANKING_JOURNAL_UNBALANCED/,
      async () => {
        await cloneReceipt();
        await cloneReceiptLines(fault);
      }
    );
  await probe(
    "Receipt header without lines cannot commit",
    /BANKING_JOURNAL_UNBALANCED/,
    cloneReceipt
  );
  await probe(
    "Consumed receipt cannot be reversed through direct SQL",
    /BANKING_RECEIPT_CONSUMED/,
    async () => {
      await client.query(
        `INSERT INTO bank_journal_entry(id,receipt_id,kind,day,currency,amount_cents,source_hash,source_snapshot,
      reference,description,actor_id,reverses_entry_id,reason) SELECT $1,receipt_id,'reversal',day,currency,amount_cents,
      source_hash,source_snapshot,reference,description,actor_id,id,'Owned invalid dependency probe'
      FROM bank_journal_entry WHERE id=$2`,
        [probeEntry, original.id]
      );
    }
  );
  const transfer = async (
    kind: "deposit" | "payment_match",
    origin: string,
    receipt: Value,
    amount: number,
    paymentId: string
  ): Promise<void> => {
    await client.query(
      `INSERT INTO bank_journal_entry(id,deposit_id,transaction_id,kind,day,currency,amount_cents,source_hash,
      source_snapshot,reference,description,actor_id) VALUES($1,$2,$3,$4,$5,'USD',$6,$7,'{}',$1,'Owned SQL probe',$8)`,
      [
        probeEntry,
        kind === "deposit" ? origin : null,
        kind === "payment_match" ? origin : null,
        kind,
        receipt.day,
        amount,
        "e".repeat(64),
        actor,
      ]
    );
    await client.query(
      `INSERT INTO bank_journal_line(id,entry_id,role,account_list_id,account_snapshot,debit_cents,credit_cents)
      SELECT $1||role,$1,role,account_list_id,account_snapshot,CASE WHEN role='bank' THEN $3::bigint ELSE 0 END,
        CASE WHEN role='clearing' THEN $3::bigint ELSE 0 END FROM bank_journal_line
      WHERE (entry_id=$2 AND role='bank') OR (entry_id=$4 AND role='clearing')`,
      [probeEntry, deposited.id, amount, receipt.id]
    );
    await client.query(
      `INSERT INTO bank_receipt_consumption(id,entry_id,receipt_id,payment_id,amount_cents,origin_kind,origin_id)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        rootPrefix + "pg_claim",
        probeEntry,
        receipt.receipt_id,
        paymentId,
        amount,
        kind,
        origin,
      ]
    );
  };
  await probe(
    "Another deposit cannot overconsume an allocated receipt",
    /BANKING_RECEIPT_OVERCONSUMED/,
    async () => {
      await client.query(
        `INSERT INTO bank_deposit(id,revision,status,account_id,currency,deposit_date,reference,memo,gross_amount,
      fee_amount,net_amount,created_by) SELECT $1,1,'ready',account_id,currency,deposit_date,$1,'Owned SQL probe',
      gross_amount,'0',gross_amount,created_by FROM bank_deposit WHERE id=$2`,
        [probeDeposit, depositId]
      );
      await transfer(
        "deposit",
        probeDeposit,
        original,
        Number(original.amount_cents),
        receiptPaymentId
      );
    }
  );

  // Exercise the actual route authorization, with only identity lookup supplied by the harness.
  const staff = actor + "_staff",
    permissionId = rootPrefix + "permission";
  const permittedPayment = await seedReceiptPayment(client, "permission", 257);
  await transaction(client, async () => {
    await withReviewLock(client);
    assert(
      (await client.query("SELECT count(*)::int n FROM bank_review_permission"))
        .rows[0].n < 25
    );
    await client.query(
      `INSERT INTO bank_review_permission(id,user_id,can_review,can_close,can_post,granted_by)
      VALUES($1,$2,true,true,false,$3)`,
      [permissionId, staff, actor]
    );
  });
  const routeCall = async (
    route: typeof postRoute,
    id: string,
    body: Value,
    expectedStatus: number
  ): Promise<Value> => {
    const req = {
      auth_context: { actor_id: staff },
      params: { id },
      body,
      headers: { "idempotency-key": randomUUID() },
      scope: {
        resolve: (name: string) => {
          if (name === "user")
            return {
              retrieveUser: async () => ({
                email: "receipts-v9-staff@example.invalid",
              }),
            };
          if (name === POS_USER_MODULE)
            return {
              listPosUsers: async () => [{ can_view_accounting: true }],
            };
          throw new Error(`Unexpected receipt route dependency ${name}`);
        },
      },
    } as unknown as AuthenticatedMedusaRequest;
    let status = 200,
      result: Value = {};
    const res = {
      status: (value: number) => {
        status = value;
        return res;
      },
      json: (value: Value) => {
        result = value;
        return res;
      },
    };
    await route(req, res as unknown as MedusaResponse);
    check(
      status === expectedStatus,
      `Receipt route status ${status}, expected ${expectedStatus} (${String(result.code ?? "ok")})`
    );
    return result;
  };
  for (const route of [previewRoute, postRoute, reverseRoute]) {
    const denial = await routeCall(route, permittedPayment, {}, 403);
    check(
      denial.code === "BANKING_ACCESS_DENIED",
      "Review/close permissions do not grant receipt posting"
    );
  }
  await client.query(
    "UPDATE bank_review_permission SET can_post=true WHERE id=$1",
    [permissionId]
  );
  const staffPosted = await routeCall(
    postRoute,
    permittedPayment,
    await postBody(permittedPayment),
    200
  );
  check(
    Boolean(object(staffPosted.posting).id),
    "Independent can_post permission executes real receipt posting"
  );
  const staffEntry = (
    await client.query("SELECT * FROM bank_journal_entry WHERE id=$1", [
      object(staffPosted.posting).id,
    ])
  ).rows[0];
  const matchMovement = await seedReceiptMovement(client, "pg_match", "-2.57");
  await probe(
    "Full direct transfer satisfies all constraints (rolled back)",
    null,
    () =>
      transfer(
        "payment_match",
        matchMovement,
        staffEntry,
        257,
        permittedPayment
      )
  );
  await probe(
    "Partial direct transfer fails instead of silently splitting Match",
    /BANKING_RECEIPT_CONSUMPTION_INVALID/,
    () =>
      transfer(
        "payment_match",
        matchMovement,
        staffEntry,
        256,
        permittedPayment
      )
  );
  check(
    !(
      await client.query(
        "SELECT 1 FROM bank_journal_entry WHERE id=$1 UNION ALL SELECT 1 FROM bank_receipt_accounting WHERE id=$2",
        [probeEntry, probeAnchor]
      )
    ).rowCount,
    "All direct SQL probes leave zero recorded residue"
  );

  const month = "2000-01";
  check(
    (
      await client.query(
        "SELECT cut_date FROM bank_accounting_setup WHERE id='local-usd'"
      )
    ).rows[0]?.cut_date === "2000-01-01",
    "Harness cut explicitly covers isolated historical month"
  );
  const readiness = await api(`/admin/accounting/month-close?month=${month}`);
  check(
    readiness.status === "open" && !object(readiness.readiness).has_blockers,
    "Owned ended month can be closed through the real API"
  );
  check(
    !(
      await client.query(
        "SELECT 1 FROM accounting_period_close WHERE period_start='2000-01-01'"
      )
    ).rowCount,
    "No unrelated January 2000 close history"
  );
  const counts = (
    await client.query(`SELECT count(*)::int n FROM inventory_level il JOIN inventory_item ii ON ii.id=il.inventory_item_id
    JOIN product_variant_inventory_item p ON p.inventory_item_id=ii.id JOIN product_variant v ON v.id=p.variant_id AND v.deleted_at IS NULL
    GROUP BY il.location_id`)
  ).rows;
  check(
    counts.length <= 40 && counts.every((row) => row.n <= 5000),
    "Real Month Close snapshots fit approved per-location and total caps"
  );
  const anchor = await seedReceiptPayment(
    client,
    "month_anchor",
    211,
    "2000-01-03"
  );
  const anchorPost = await api(`${base(anchor)}/post`, await postBody(anchor));
  const racing = await seedReceiptPayment(
    client,
    "month_race",
    317,
    "2000-01-17"
  );
  const racingBody = await postBody(racing);
  const blocked = await seedReceiptPayment(
    client,
    "month_blocked",
    419,
    "2000-01-18"
  );
  const blockedBody = await postBody(blocked);
  const waiters = async (expected: number): Promise<void> => {
    for (let attempt = 0; attempt < 60; attempt++) {
      if ((await periodBlockedSessions(client)) >= expected) return;
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error(
      `Expected ${expected} real sessions waiting on the owned period lock`
    );
  };
  await client.query("BEGIN");
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('accounting-period:2000-01',7242))"
  );
  let closeSettled = false,
    postSettled = false,
    lockFailure: unknown;
  const closing = api(
    "/admin/accounting/month-close",
    { month, acknowledge_warnings: true, note: closeNote },
    201
  ).finally(() => {
    closeSettled = true;
  });
  const posting = postReceiptAccounting(
    "receipt",
    racing,
    actor,
    randomUUID(),
    racingBody
  ).finally(() => {
    postSettled = true;
  });
  const outcomes = Promise.allSettled([closing, posting]);
  try {
    await waiters(2);
    check(
      !closeSettled && !postSettled,
      "Real close and receipt post wait on the same monthly lock"
    );
  } catch (error) {
    lockFailure = error;
  } finally {
    await client.query("COMMIT");
  }
  const results = await outcomes;
  if (lockFailure) throw lockFailure;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- `results` viene de Promise.allSettled sobre un array literal de 2 promesas (closing, posting); el índice 0 siempre existe
  const closeOutcome = results[0]!;
  assert(
    closeOutcome.status === "fulfilled",
    "Actual Month Close must complete"
  );
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- misma garantía: `results` tiene exactamente 2 elementos, el índice 1 siempre existe
  const postOutcome = results[1]!;
  if (postOutcome.status === "rejected")
    assert(
      (postOutcome.reason as { code?: string }).code ===
        "BANKING_ACCOUNTING_PERIOD_CLOSED"
    );
  check(
    true,
    "Close/post race either commits before close or rejects the closed accounting period"
  );
  const closedPost = await api(`${base(blocked)}/post`, blockedBody, 423);
  check(
    closedPost.code === "BANKING_ACCOUNTING_PERIOD_CLOSED",
    "Receipt posting cannot bypass a committed month close"
  );
  const reversed = {
    posting_id: object(anchorPost.posting).id,
    day: "2000-01-20",
    reason: "Owned closed-period reversal control",
  };
  const deniedReverse = await api(`${base(anchor)}/reverse`, reversed, 423);
  check(
    deniedReverse.code === "BANKING_ACCOUNTING_PERIOD_CLOSED",
    "Receipt reversal checks its chosen accounting period"
  );
  await api(`${base(anchor)}/reverse`, { ...reversed, day: "2000-02-01" });
  const preview = object(
    (await api(`/admin/accounting/month-close/reopen-preview?month=${month}`))
      .preview
  );
  await client.query("BEGIN");
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('accounting-period:2000-01',7242))"
  );
  let reopenSettled = false;
  lockFailure = undefined;
  const reopening = api("/admin/accounting/month-close/reopen", {
    month,
    input_hash: preview.input_hash,
    reason: "Owned v9 reopening",
  }).finally(() => {
    reopenSettled = true;
  });
  const reopenOutcome = Promise.allSettled([reopening]);
  try {
    await waiters(1);
    check(
      !reopenSettled,
      "Real month reopen also waits on the same monthly lock"
    );
  } catch (error) {
    lockFailure = error;
  } finally {
    await client.query("COMMIT");
  }
  const reopened = await reopenOutcome;
  if (lockFailure) throw lockFailure;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- `reopenOutcome` viene de Promise.allSettled sobre un array literal de 1 promesa (reopening); el índice 0 siempre existe
  assert(reopened[0]!.status === "fulfilled", "Actual reopen must complete");
  await api(`${base(blocked)}/post`, await postBody(blocked));
  check(
    Boolean((await api(base(blocked))).posting),
    "Reopened month permits its previously blocked receipt"
  );
}
