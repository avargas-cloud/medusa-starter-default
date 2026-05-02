/**
 * Regression e2e test (sandbox) — pos.invoice.created guard
 *
 * Reproduces the bug fixed on 2026-05-02 where qb-order-subscriber would
 * blindly enqueue an `invoice` pipeline row on every pos.invoice.created
 * event, even when the route had already enqueued the `sales_receipt`
 * row upfront. That dual emission produced ghost QB Invoices like #19480
 * (memo "Invoice 1651") for order 1651 / pos_invoice 20245.
 *
 * Verifies:
 *   1. is_sales_receipt=true  → subscriber SKIPS (no invoice row)
 *   2. is_sales_receipt=false → subscriber enqueues invoice row (legacy path)
 *   3. is_sales_receipt missing → subscriber enqueues (back-compat default)
 *
 * Runs the real subscriber code against sandbox DB. No bridge/HTTP mocks
 * needed — the subscriber's only side effect is INSERT into qb_order_pipeline.
 */

process.env.DATABASE_URL =
  "postgresql://postgres:sandbox@localhost:5499/medusa";
process.env.QB_ORDER_FLOW_ENABLED = "true";
process.env.QB_DRY_RUN = "true";

import { Client } from "pg";

const SANDBOX_DB = process.env.DATABASE_URL!;
const TEST_RUN_ID = `e2eGuard-${Date.now()}`;

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

const mockLogger = {
  info: (m: string) => console.log(`    [logger] ${m}`),
  warn: (m: string) => console.warn(`    [logger] ${m}`),
  error: (m: string) => console.error(`    [logger] ${m}`),
  debug: (_: string) => {},
};

// Subscriber resolves order/customer/logger upfront. Only logger is used
// in the pos.invoice.created branch — others are returned as empty stubs
// so the upfront destructure doesn't blow up.
const stub = new Proxy(
  {},
  {
    get: () => () => undefined,
  }
);
const mockContainer = {
  resolve: (key: string) => {
    if (key === "logger") return mockLogger;
    return stub;
  },
};

async function main() {
  console.log("\n╭─ E2E — pos.invoice.created Guard Regression ─╮");
  console.log(`│  Run: ${TEST_RUN_ID}`);
  console.log(`│  DB: ${SANDBOX_DB}`);
  console.log("╰────────────────────────────────────────────────╯\n");

  const client = new Client({ connectionString: SANDBOX_DB });
  await client.connect();

  // Lazy import — DATABASE_URL must be set first so qb-pipeline picks up sandbox.
  const subscriberMod = await import(
    "../../subscribers/qb-order-subscriber"
  );
  const qbOrderSubscriber = subscriberMod.default;

  const ORDER_ID_A = `order_${TEST_RUN_ID}_A`;
  const ORDER_ID_B = `order_${TEST_RUN_ID}_B`;
  const ORDER_ID_C = `order_${TEST_RUN_ID}_C`;
  const INVOICE_ID = `pinv_${TEST_RUN_ID}`;

  try {
    // ─── 1. is_sales_receipt=true → no invoice row ────────────────────────
    console.log("\n── 1. is_sales_receipt=true (post-fix expected: SKIP) ──");
    await qbOrderSubscriber({
      event: {
        name: "pos.invoice.created",
        data: {
          id: INVOICE_ID,
          invoice_id: INVOICE_ID,
          order_id: ORDER_ID_A,
          is_sales_receipt: true,
        },
      },
      container: mockContainer,
    } as any);

    const rowsA = await client.query(
      `SELECT step, reference_type, reference_id FROM qb_order_pipeline WHERE order_id = $1`,
      [ORDER_ID_A]
    );
    check(
      "no invoice row enqueued when is_sales_receipt=true",
      rowsA.rowCount === 0,
      `got ${rowsA.rowCount} row(s): ${JSON.stringify(rowsA.rows)}`
    );

    // ─── 2. is_sales_receipt=false → invoice row enqueued (legacy) ────────
    console.log("\n── 2. is_sales_receipt=false (legacy path: ENQUEUE) ──");
    await qbOrderSubscriber({
      event: {
        name: "pos.invoice.created",
        data: {
          id: INVOICE_ID,
          invoice_id: INVOICE_ID,
          order_id: ORDER_ID_B,
          is_sales_receipt: false,
        },
      },
      container: mockContainer,
    } as any);

    const rowsB = await client.query(
      `SELECT step, reference_type, reference_id FROM qb_order_pipeline WHERE order_id = $1`,
      [ORDER_ID_B]
    );
    check(
      "exactly 1 invoice row enqueued when is_sales_receipt=false",
      rowsB.rowCount === 1 &&
        rowsB.rows[0].step === "invoice" &&
        rowsB.rows[0].reference_type === "invoice" &&
        rowsB.rows[0].reference_id === INVOICE_ID,
      JSON.stringify(rowsB.rows)
    );

    // ─── 3. is_sales_receipt missing → enqueue (back-compat) ──────────────
    console.log("\n── 3. is_sales_receipt missing (back-compat: ENQUEUE) ──");
    await qbOrderSubscriber({
      event: {
        name: "pos.invoice.created",
        data: {
          id: INVOICE_ID,
          invoice_id: INVOICE_ID,
          order_id: ORDER_ID_C,
          // no is_sales_receipt key
        },
      },
      container: mockContainer,
    } as any);

    const rowsC = await client.query(
      `SELECT step FROM qb_order_pipeline WHERE order_id = $1`,
      [ORDER_ID_C]
    );
    check(
      "1 invoice row enqueued when is_sales_receipt is missing",
      rowsC.rowCount === 1 && rowsC.rows[0].step === "invoice",
      JSON.stringify(rowsC.rows)
    );

    // ─── 4. Production scenario replay (DARIO'S 1651) ─────────────────────
    console.log("\n── 4. Replay DARIO'S scenario: SR upfront + event ──");
    const { writePipelineRow } = require("../../lib/quickbooks/qb-pipeline");
    const ORDER_ID_D = `order_${TEST_RUN_ID}_D`;
    const POS_INVOICE_ID = `pinv_${TEST_RUN_ID}_D`;

    // Step 1: route writes upfront sales_receipt row (mirrors POST /admin/invoices)
    await writePipelineRow({
      orderId: ORDER_ID_D,
      referenceId: POS_INVOICE_ID,
      referenceType: "pos_invoice",
      step: "sales_receipt",
      status: "waiting",
      medusaRefNumber: "INV-SANDBOX-TEST",
    });

    // Step 2: route emits pos.invoice.created (with new is_sales_receipt flag)
    await qbOrderSubscriber({
      event: {
        name: "pos.invoice.created",
        data: {
          id: POS_INVOICE_ID,
          invoice_id: POS_INVOICE_ID,
          order_id: ORDER_ID_D,
          is_sales_receipt: true,
        },
      },
      container: mockContainer,
    } as any);

    const rowsD = await client.query(
      `SELECT step, reference_type FROM qb_order_pipeline WHERE order_id = $1 ORDER BY seq`,
      [ORDER_ID_D]
    );
    check(
      "SR-upfront + event yields exactly 1 sales_receipt row, 0 invoice rows",
      rowsD.rowCount === 1 &&
        rowsD.rows[0].step === "sales_receipt" &&
        rowsD.rows[0].reference_type === "pos_invoice",
      JSON.stringify(rowsD.rows)
    );
  } finally {
    // Cleanup
    await client.query(
      `DELETE FROM qb_order_pipeline WHERE order_id LIKE $1`,
      [`order_${TEST_RUN_ID}_%`]
    );
    await client.end();
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\n💥 Test crashed:", e);
  process.exit(1);
});
