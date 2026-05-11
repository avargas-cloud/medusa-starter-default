/**
 * Sandbox Smoke Test — Credit Memo MOD refactor (replaces void+recreate)
 *
 * Validates the new credit_memo_mod flow end-to-end without hitting QB:
 *   - /edit route enqueues a SINGLE 'credit_memo_mod' row (no void+create)
 *   - bridge builder emits <CreditMemoLineMod> with TxnLineID per item
 *   - bridge PUT /api/credit-memos/:txnId accepts items + customer + date
 *   - client updateCreditMemoInQb forwards items in body
 *   - consolidator credit_memo_mod case passes items through
 *   - poll-submitted-rows extracts TxnLineIDs from CreditMemoAddRs / ModRs
 *   - pos_credit_memo_item.qb_txn_line_id column exists in sandbox DB
 *
 * Run:
 *   DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *   npx ts-node backend/src/scripts/test/sandbox-smoke-credit-memo-mod.ts
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:sandbox@localhost:5499/medusa";

import { Client } from "pg";
import * as fs from "fs";

const SANDBOX_DB = process.env.DATABASE_URL!;

let pass = 0;
let fail = 0;

function assert(cond: boolean, label: string, detail?: string) {
  if (cond) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

const BACKEND = "/home/alejo/webapps/ecopowertech-workspace/backend";
const BRIDGE = "/home/alejo/webapps/ecopowertech-workspace/quickbooks-bridge";

const PATHS = {
  editRoute: `${BACKEND}/src/api/admin/pos/credit_memos/[id]/edit/route.ts`,
  cmClient: `${BACKEND}/src/lib/quickbooks/client/credit-memos.ts`,
  cmTypes: `${BACKEND}/src/lib/quickbooks/client/types.ts`,
  consolidator: `${BACKEND}/src/lib/quickbooks/consolidator/resubmit-by-step.ts`,
  poller: `${BACKEND}/src/lib/quickbooks/consolidator/poll-submitted-rows.ts`,
  bridgeRoute: `${BRIDGE}/src/rest/routes/credit-memos.ts`,
  bridgeBuilder: `${BRIDGE}/src/qbxml/builders/creditMemo.ts`,
  cmItemModel: `${BACKEND}/src/modules/credit_memos/models/pos-credit-memo-item.ts`,
  migration: `${BACKEND}/src/modules/credit_memos/migrations/Migration20260511190000.ts`,
};

function read(p: string): string {
  return fs.readFileSync(p, "utf-8");
}

function staticChecks() {
  console.log("\n=== TEST 1 — /edit enqueues credit_memo_mod (not void+create) ===");
  const edit = read(PATHS.editRoute);
  assert(
    !/step:\s*"void_credit_memo"/.test(edit),
    "edit route does NOT enqueue void_credit_memo"
  );
  assert(
    !/step:\s*"credit_memo"(?!_)/.test(edit),
    "edit route does NOT enqueue plain 'credit_memo' (only 'credit_memo_mod')"
  );
  assert(
    /step:\s*"credit_memo_mod"/.test(edit),
    "edit route enqueues credit_memo_mod"
  );
  assert(
    /TxnLineID:\s*reusedTxnLineId\s*\?\?\s*"-1"/.test(edit),
    "edit route sets TxnLineID per line (preserved or -1)"
  );
  assert(
    /qb_txn_line_id:\s*reusedTxnLineId/.test(edit),
    "edit route persists reused qb_txn_line_id on recreated items"
  );
  assert(
    !/qb_txn_id:\s*null/.test(edit),
    "edit route does NOT clear qb_txn_id (kept for MOD)"
  );

  console.log("\n=== TEST 2 — bridge builder emits CreditMemoLineMod ===");
  const builder = read(PATHS.bridgeBuilder);
  assert(
    /<CreditMemoLineMod>/.test(builder),
    "buildCreditMemoMod emits <CreditMemoLineMod> elements"
  );
  assert(
    /<TxnLineID>\$\{item\.TxnLineID \|\| '-1'\}<\/TxnLineID>/.test(builder),
    "builder emits TxnLineID (existing or -1) per line"
  );
  assert(
    /CreditMemoMod requires TxnID/.test(builder) &&
      /CreditMemoMod requires EditSequence/.test(builder),
    "builder validates TxnID + EditSequence"
  );
  const modBody =
    builder.match(/function buildCreditMemoMod[\s\S]+?\n}/)?.[0] ?? "";
  assert(
    /CustomerRef/.test(modBody),
    "buildCreditMemoMod emits CustomerRef when provided"
  );

  console.log("\n=== TEST 3 — bridge PUT accepts items + customer + date ===");
  const bridgeRoute = read(PATHS.bridgeRoute);
  const putBlock =
    bridgeRoute.split("creditMemosRouter.put")[1]?.split("creditMemosRouter")[0] ?? "";
  assert(/items/.test(putBlock), "PUT destructures 'items' from body");
  assert(/customerId/.test(putBlock), "PUT destructures 'customerId'");
  assert(/date/.test(putBlock), "PUT destructures 'date'");
  assert(/refNumber/.test(putBlock), "PUT destructures 'refNumber'");
  assert(
    /action:\s*'mod'[\s\S]+items/.test(putBlock),
    "PUT forwards items in queueOperation data"
  );

  console.log("\n=== TEST 4 — updateCreditMemoInQb forwards items ===");
  const client = read(PATHS.cmClient);
  assert(
    /payload\.items\s*&&\s*payload\.items\.length\s*>\s*0/.test(client),
    "client forwards items only when non-empty"
  );
  assert(
    /payload\.customerId\s*\?\s*{\s*customerId:/.test(client),
    "client forwards customerId when present"
  );
  assert(
    /payload\.date\s*\?\s*{\s*date:/.test(client),
    "client forwards date when present"
  );

  console.log("\n=== TEST 5 — payload type includes items + customer + date ===");
  const types = read(PATHS.cmTypes);
  const cmType =
    types.split("QbUpdateCreditMemoPayload")[1]?.split("export interface")[0] ?? "";
  assert(/items\?:/.test(cmType), "QbUpdateCreditMemoPayload.items?");
  assert(/customerId\?:/.test(cmType), "QbUpdateCreditMemoPayload.customerId?");
  assert(/date\?:/.test(cmType), "QbUpdateCreditMemoPayload.date?");
  assert(/refNumber\?:/.test(cmType), "QbUpdateCreditMemoPayload.refNumber?");

  console.log("\n=== TEST 6 — consolidator credit_memo_mod forwards items ===");
  const cons = read(PATHS.consolidator);
  const cmModCase =
    cons.split('case "credit_memo_mod"')[1]?.split('case "')[0] ?? "";
  assert(/items:\s*modPayload\.items/.test(cmModCase), "consolidator forwards items");
  assert(/customerId:\s*modPayload\.customerId/.test(cmModCase), "consolidator forwards customerId");
  assert(/date:\s*modPayload\.date/.test(cmModCase), "consolidator forwards date");

  console.log("\n=== TEST 7 — poller extracts CreditMemoLineRet TxnLineIDs ===");
  const poll = read(PATHS.poller);
  assert(
    /CreditMemoAddRs\?\.CreditMemoRet\?\.CreditMemoLineRet/.test(poll),
    "poller extracts lineIds from CreditMemoAddRs"
  );
  assert(
    /CreditMemoModRs\?\.CreditMemoRet\?\.CreditMemoLineRet/.test(poll),
    "poller extracts lineIds from CreditMemoModRs"
  );
  assert(
    /UPDATE pos_credit_memo_item[\s\S]+SET qb_txn_line_id/.test(poll),
    "poller persists qb_txn_line_id on pos_credit_memo_item"
  );
  assert(
    /quickbooks_id/.test(
      poll.split("UPDATE pos_credit_memo_item")[1]?.slice(0, 800) ?? ""
    ),
    "poller matches by variant.metadata.quickbooks_id"
  );

  console.log("\n=== TEST 8 — model has qb_txn_line_id ===");
  const model = read(PATHS.cmItemModel);
  assert(/qb_txn_line_id:\s*model\.text\(\)\.nullable\(\)/.test(model),
    "pos-credit-memo-item model declares qb_txn_line_id");

  console.log("\n=== TEST 9 — migration adds qb_txn_line_id column ===");
  const mig = read(PATHS.migration);
  assert(
    /add column if not exists "qb_txn_line_id" text/.test(mig),
    "migration adds qb_txn_line_id text column"
  );
}

async function dbChecks() {
  console.log("\n=== TEST 10 — sandbox DB has qb_txn_line_id column ===");
  const client = new Client({ connectionString: SANDBOX_DB });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'pos_credit_memo_item'
          AND column_name = 'qb_txn_line_id'`
    );
    assert(rows.length === 1, "qb_txn_line_id column present");
    if (rows.length === 1) {
      assert(rows[0].data_type === "text", `column is text (got ${rows[0].data_type})`);
      assert(rows[0].is_nullable === "YES", "column is nullable");
    }

    const { rows: idxRows } = await client.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'pos_credit_memo_item'
          AND indexname = 'IDX_pos_credit_memo_item_qb_txn_line_id'`
    );
    assert(idxRows.length === 1, "index IDX_pos_credit_memo_item_qb_txn_line_id present");

    console.log("\n=== TEST 11 — pipeline step constraint allows credit_memo_mod ===");
    const { rows: cstRows } = await client.query(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'qb_order_pipeline'
          AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) ILIKE '%credit_memo%'`
    );
    const def = cstRows.map((r: any) => r.def).join(" | ");
    assert(
      def.includes("credit_memo_mod") || def === "",
      `qb_order_pipeline step check accepts 'credit_memo_mod' (def: ${def || "no constraint"})`
    );
  } finally {
    await client.end();
  }
}

async function main() {
  console.log("=".repeat(70));
  console.log("Sandbox Smoke — Credit Memo MOD refactor");
  console.log("DB:", SANDBOX_DB);
  console.log("=".repeat(70));

  staticChecks();
  await dbChecks();

  console.log("\n" + "=".repeat(70));
  console.log(`Result: ${pass} passed, ${fail} failed`);
  console.log("=".repeat(70));

  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(2);
});
