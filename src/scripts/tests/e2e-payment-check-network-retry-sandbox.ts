/**
 * e2e-payment-check-network-retry-sandbox
 *
 * Proves, against real Postgres, the 2026-09-11 fix in `resubmitByStep`'s catch
 * block: a network failure (dead bridge, ECONNREFUSED) while dispatching
 * `vendor_bill_payment_check` now lands as status='failed' WITH a backoff
 * `next_retry_at` (`failOrRetryPipelineRow`), instead of the old terminal
 * `failPipelineRow` dead-end only a human re-check could clear (12h until the
 * monitor re-elects the bill).
 *
 * Three parts:
 *   1. `vendor_bill_payment_check` against a closed port → retryable failure.
 *   2. CONTROL: `invoice_update` (reaches the bridge with only the row's own
 *      fields, but is NOT in the retry set) against the same closed port →
 *      terminal failure, next_retry_at NULL. Proves the routing is per STEP.
 *   3. Recovery: same R1 row, re-claimed like the dispatch pass would, now
 *      against a stub bridge that answers 200 → submitted.
 *
 * WHY invoice_update AS THE CONTROL
 * Of `resubmitByStep`'s 7 direct `bridgeFetch` call sites, 5 (vendor_bill_void,
 * vendor_credit_add/void, bill_payment_add/void) wrap the call in their OWN
 * local try/catch, so a network failure there never reaches the outer catch's
 * per-step routing — they cannot demonstrate it either way. Of the remaining
 * 2, `vendor_bill_mod` is itself IN the retry set, and `vendor_bill_payment_check`
 * is the row under test. So the control goes through `updateInvoiceInQb`,
 * which calls bridgeFetch and returns `{success:false, error}` — the
 * `invoice_update` case's own `else` then calls `failPipelineRow` directly.
 * Still only the row's own fields (reference_id, qb_txn_id), still no backoff
 * for a step outside the retry set — whether via the outer catch or the
 * case's own branch.
 *
 * SAFETY: refuses to run unless DATABASE_URL points at sandbox Postgres
 * (5499). Every fixture id is prefixed `e2e_pcnr_`, removed in a finally
 * block, and the removal is verified with a final count.
 *
 * Run (sandbox stack up):
 *   env DATABASE_URL=postgres://<user>:<password>@127.0.0.1:5499/<db> \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-payment-check-network-retry-sandbox.ts
 */
import { createServer, type Server } from "http";
import { Client } from "pg";

const PREFIX = "e2e_pcnr_";
// Port 1 (as suggested by the original spec) does NOT work: undici's fetch()
// treats it as a "forbidden port" and fails with a bare `cause: Error("bad
// port")` — no `.code`, so `describeDispatchError` can't append ECONNREFUSED.
// A closed ordinary high port gives a real refused TCP connect instead.
const CLOSED_BRIDGE_URL = "http://127.0.0.1:19999";

let failures = 0;
const assert = (ok: boolean, label: string, detail = ""): void => {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

type PipelineRow = {
  id: string;
  status: string;
  retry_count: number;
  next_retry_at: Date | null;
  error: string | null;
  failed_at: Date | null;
  bridge_op_id: string | null;
  submitted_at: Date | null;
};

async function fetchRow(client: Client, id: string): Promise<PipelineRow> {
  const { rows } = await client.query(
    `SELECT id, status, retry_count, next_retry_at, error, failed_at,
            bridge_op_id, submitted_at
       FROM qb_order_pipeline WHERE id = $1`,
    [id]
  );
  return rows[0];
}

function startStubBridge(port: number): Promise<Server> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/api/bills/query") {
        res.end(JSON.stringify({ success: true, operationId: "e2e-op-pcnr" }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: `stub bridge: unexpected ${req.method} ${req.url}` }));
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

async function seedBill(client: Client, billId: string, txnId: string): Promise<void> {
  await client.query(
    `INSERT INTO vendor_bill
       (id, status, qb_txn_id, qb_ref_number, vendor_name_snapshot,
        qb_amount_due_cents, qb_is_paid, qb_source, created_at, updated_at)
     VALUES ($1, 'synced', $2, 'E2E-PCNR-REF', 'E2E Vendor', 120000, false, 'adopted', NOW(), NOW())`,
    [billId, txnId]
  );
}

async function seedRow(
  client: Client,
  opts: {
    id: string;
    step: string;
    referenceId: string;
    referenceType: string;
    qbTxnId: string;
    payload: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO qb_order_pipeline
       (id, reference_id, reference_type, step, status, qb_txn_id,
        retry_count, payload, created_at, updated_at)
     VALUES ($1::uuid, $2::text, $3::text, $4::text, 'processing', $5::text,
             0, $6::jsonb, NOW(), NOW())`,
    [
      opts.id,
      opts.referenceId,
      opts.referenceType,
      opts.step,
      opts.qbTxnId,
      JSON.stringify(opts.payload),
    ]
  );
}

async function cleanup(client: Client): Promise<void> {
  await client.query(`DELETE FROM qb_order_pipeline WHERE reference_id LIKE $1`, [
    `${PREFIX}%`,
  ]);
  await client.query(`DELETE FROM vendor_bill WHERE id LIKE $1`, [`${PREFIX}%`]);
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  if (!connectionString.includes(":5499/")) {
    throw new Error(
      "Refusing to run: DATABASE_URL is not sandbox Postgres (expected :5499/)"
    );
  }

  process.env.QB_API_KEY = process.env.QB_API_KEY ?? "e2e-stub";

  const client = new Client({ connectionString });
  await client.connect();

  const { randomUUID } = await import("crypto");
  const r1Id = randomUUID();
  const r2Id = randomUUID();
  const billId = `${PREFIX}bill`;
  const txnId = "E2E-PCNR-TXN";
  const controlTxnId = "E2E-PCNR-CTRL-TXN";

  const logger = {
    info: (m: string) => console.log(`   [log] ${m}`),
    warn: (m: string) => console.log(`   [warn] ${m}`),
    error: (m: string) => console.log(`   [err] ${m}`),
  };
  // resubmitByStep resolves ORDER/CUSTOMER modules unconditionally before the
  // switch, but neither vendor_bill_payment_check nor invoice_update touches
  // them — a stub satisfying only `.resolve()` is enough, no real container.
  const stubContainer = { resolve: () => ({}) } as never;

  let server: Server | undefined;
  try {
    await cleanup(client);
    await seedBill(client, billId, txnId);
    await seedRow(client, {
      id: r1Id,
      step: "vendor_bill_payment_check",
      referenceId: billId,
      referenceType: "vendor_bill",
      qbTxnId: txnId,
      payload: { vendor_bill_id: billId, txn_id: txnId },
    });
    await seedRow(client, {
      id: r2Id,
      step: "invoice_update",
      referenceId: `${PREFIX}invoice`,
      referenceType: "invoice",
      qbTxnId: controlTxnId,
      payload: {},
    });
    console.log(`\nSeeded R1(vendor_bill_payment_check)=${r1Id}, R2(invoice_update)=${r2Id}`);

    // ── 1. vendor_bill_payment_check against a closed port ─────────────────
    console.log("\n── 1. vendor_bill_payment_check: bridge unreachable ──");
    process.env.QB_BRIDGE_URL = CLOSED_BRIDGE_URL;
    const { resubmitByStep } = await import(
      "../../lib/quickbooks/consolidator/resubmit-by-step"
    );
    const r1Before = await fetchRow(client, r1Id);
    await resubmitByStep(
      { id: r1Id, order_id: null, reference_id: billId, reference_type: "vendor_bill",
        step: "vendor_bill_payment_check", qb_txn_id: txnId, retry_count: 0,
        payload: { vendor_bill_id: billId, txn_id: txnId } },
      stubContainer,
      logger
    );
    const r1After = await fetchRow(client, r1Id);
    const now = Date.now();
    const nextRetryMs = r1After.next_retry_at ? new Date(r1After.next_retry_at).getTime() : null;
    assert(r1After.status === "failed", "R1.status='failed'", `got '${r1After.status}'`);
    assert(r1After.retry_count === 1, "R1.retry_count=1", `got ${r1After.retry_count}`);
    assert(
      nextRetryMs !== null && nextRetryMs >= now + 90_000 && nextRetryMs <= now + 150_000,
      "R1.next_retry_at within [now+90s, now+150s]",
      `now=${now}, next_retry_at=${nextRetryMs}`
    );
    assert(
      (r1After.error ?? "").startsWith("fetch failed") &&
        (r1After.error ?? "").includes("ECONNREFUSED"),
      "R1.error starts with 'fetch failed' and contains 'ECONNREFUSED'",
      r1After.error ?? "(null)"
    );
    assert(r1After.failed_at !== null, "R1.failed_at is set");
    void r1Before;

    // ── 2. CONTROL: invoice_update against the same closed port ────────────
    console.log("\n── 2. CONTROL invoice_update: bridge unreachable ──");
    await resubmitByStep(
      { id: r2Id, order_id: null, reference_id: `${PREFIX}invoice`, reference_type: "invoice",
        step: "invoice_update", qb_txn_id: controlTxnId, retry_count: 0, payload: {} },
      stubContainer,
      logger
    );
    const r2After = await fetchRow(client, r2Id);
    assert(r2After.status === "failed", "R2.status='failed'", `got '${r2After.status}'`);
    assert(
      r2After.next_retry_at === null,
      "R2.next_retry_at IS NULL — retry is per-step, not global"
    );
    assert(
      (r2After.error ?? "").includes("fetch failed"),
      "R2.error contains 'fetch failed'",
      r2After.error ?? "(null)"
    );

    // ── 3. Recovery: re-claim R1, dispatch against a healthy stub bridge ───
    console.log("\n── 3. Recovery: R1 re-claimed against a healthy bridge ──");
    const port = 9791;
    server = await startStubBridge(port);
    process.env.QB_BRIDGE_URL = `http://127.0.0.1:${port}`;
    await client.query(
      `UPDATE qb_order_pipeline
          SET status = 'processing', next_retry_at = NULL, updated_at = NOW()
        WHERE id = $1`,
      [r1Id]
    );
    await resubmitByStep(
      { id: r1Id, order_id: null, reference_id: billId, reference_type: "vendor_bill",
        step: "vendor_bill_payment_check", qb_txn_id: txnId, retry_count: 1,
        payload: { vendor_bill_id: billId, txn_id: txnId } },
      stubContainer,
      logger
    );
    const r1Recovered = await fetchRow(client, r1Id);
    assert(
      r1Recovered.status === "submitted",
      "R1.status='submitted'",
      `got '${r1Recovered.status}'`
    );
    assert(
      r1Recovered.bridge_op_id === "e2e-op-pcnr",
      "R1.bridge_op_id='e2e-op-pcnr'",
      `got '${r1Recovered.bridge_op_id}'`
    );
    assert(r1Recovered.submitted_at !== null, "R1.submitted_at is set");
  } finally {
    await cleanup(client);
    const { rows: left } = await client.query(
      `SELECT (SELECT COUNT(*) FROM vendor_bill WHERE id LIKE $1)
            + (SELECT COUNT(*) FROM qb_order_pipeline WHERE reference_id LIKE $1)
              AS n`,
      [`${PREFIX}%`]
    );
    assert(Number(left[0].n) === 0, "all fixtures removed", `left=${left[0].n}`);
    await client.end();
    server?.close();
  }

  console.log("");
  if (failures > 0) {
    console.error(`❌ FAIL — ${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("✅ PASS — per-step retry routing confirmed: retryable, terminal, recovered.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
