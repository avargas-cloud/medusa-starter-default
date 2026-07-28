/**
 * Sandbox-only verifier for the DB-only legacy Vendor Bill adapter.
 *
 * Proves that old waiting and already-submitted qb_vendor_bill_pipeline rows
 * become universal purchase-chain rows without issuing a bridge request.
 */

import { Client } from "pg";

import {
  adoptLegacyVendorBillRow,
  type KnexRaw,
  type LegacyBillRow,
} from "../../jobs/qb-vendor-bill-poller";

const SANDBOX_DEFAULT_URL =
  "postgresql://postgres:sandbox@localhost:5499/medusa";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${label}`);
    return;
  }
  failed += 1;
  console.log(
    `  ❌ ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`
  );
}

function asKnexRaw(client: Client): KnexRaw {
  const adapter: KnexRaw = {
    raw: async (sql: string, bindings: unknown[] = []) => {
      let index = 0;
      const pgSql = sql.replace(/\?/g, () => `$${++index}`);
      const result = await client.query(pgSql, bindings as never[]);
      return {
        rows: result.rows,
        rowCount: result.rowCount ?? undefined,
      };
    },
    transaction: async <T>(handler: (trx: KnexRaw) => Promise<T>) =>
      handler(adapter),
  };
  return adapter;
}

function candidate(input: {
  id: string;
  billId: string;
  poId: string;
  status: "waiting" | "submitted";
  operationId?: string;
}): LegacyBillRow {
  return {
    id: input.id,
    vendor_bill_id: input.billId,
    purchase_order_id: input.poId,
    status: input.status,
    qb_operation_id: input.operationId ?? null,
    retries: 0,
    next_retry_at: null,
    last_error: null,
    rebuild_generation: 0,
    payload: {
      vendor_bill_id: input.billId,
      po_id: input.poId,
      item_lines: [{ sku: "VERIFY-SKU", quantity: 1 }],
    },
  };
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL || SANDBOX_DEFAULT_URL;
  if (!/localhost:5499|127\.0\.0\.1:5499/.test(connectionString)) {
    throw new Error(
      "Refusing to run: verify-vendor-bill-legacy-adoption is sandbox-only"
    );
  }
  const client = new Client({ connectionString });
  await client.connect();
  await client.query("BEGIN");
  try {
    const stamp = Date.now();
    const waiting = candidate({
      id: `qbvbpipe_verify_waiting_${stamp}`,
      billId: `vb_verify_waiting_${stamp}`,
      poId: `po_verify_waiting_${stamp}`,
      status: "waiting",
    });
    const submitted = candidate({
      id: `qbvbpipe_verify_submitted_${stamp}`,
      billId: `vb_verify_submitted_${stamp}`,
      poId: `po_verify_submitted_${stamp}`,
      status: "submitted",
      operationId: `bridge-op-verify-${stamp}`,
    });
    for (const row of [waiting, submitted]) {
      await client.query(
        `INSERT INTO vendor_bill
           (id, status, bill_type, purchase_order_id)
         VALUES ($1, 'confirmed', 'regular', $2)`,
        [row.vendor_bill_id, row.purchase_order_id]
      );
      await client.query(
        `INSERT INTO qb_vendor_bill_pipeline
           (id, vendor_bill_id, purchase_order_id, status, intent,
            qb_operation_id, retries, payload, rebuild_generation)
         VALUES ($1, $2, $3, $4, 'add', $5, 0, $6::jsonb, 0)`,
        [
          row.id,
          row.vendor_bill_id,
          row.purchase_order_id,
          row.status,
          row.qb_operation_id,
          JSON.stringify(row.payload),
        ]
      );
    }

    const knex = asKnexRaw(client);
    const waitingOperationId = await adoptLegacyVendorBillRow(knex, waiting);
    const submittedOperationId = await adoptLegacyVendorBillRow(
      knex,
      submitted
    );
    const state = await client.query(
      `SELECT qvb.id AS legacy_id, qvb.order_pipeline_id::text,
              qvb.payload->>'delegated_to_consolidator' AS delegated,
              qop.status, qop.bridge_op_id, qop.step
         FROM qb_vendor_bill_pipeline qvb
         JOIN qb_order_pipeline qop ON qop.id = qvb.order_pipeline_id
        WHERE qvb.id = ANY($1::text[])
        ORDER BY qvb.id`,
      [[waiting.id, submitted.id]]
    );
    const byId = new Map(
      state.rows.map((row) => [String(row.legacy_id), row])
    );
    const waitingState = byId.get(waiting.id);
    const submittedState = byId.get(submitted.id);

    assert(
      "waiting legacy row becomes a universal vendor_bill_add",
      waitingOperationId != null &&
        waitingState?.order_pipeline_id === waitingOperationId &&
        waitingState?.step === "vendor_bill_add" &&
        waitingState?.status === "pending",
      waitingState
    );
    assert(
      "legacy payload is permanently marked delegated",
      waitingState?.delegated === "true",
      waitingState
    );
    assert(
      "already-submitted bridge operation is adopted, not re-submitted",
      submittedOperationId != null &&
        submittedState?.order_pipeline_id === submittedOperationId &&
        submittedState?.status === "submitted" &&
        submittedState?.bridge_op_id === submitted.qb_operation_id,
      submittedState
    );

    console.log(
      `\n=== RESULT: ${passed} passed, ${failed} failed ===${
        failed ? " ❌" : " ✅"
      }\n`
    );
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
