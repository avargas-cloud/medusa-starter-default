/**
 * e2e-bill-payment-check-leak-sandbox
 *
 * End-to-end proof, against real Postgres, that a Vendor Bill whose QuickBooks
 * document was deleted produces ONE settled pipeline row instead of one dead row
 * per hour forever.
 *
 * WHY AN E2E AND NOT UNIT TESTS
 * The unit tests for this area pass a fake pool, so their SQL never executes. Both
 * halves of this change live in SQL — a transactional two-table settle and a
 * candidate query with two NOT EXISTS layers — so a unit test could not have caught
 * a bad cast or a predicate that never matches. This project has already shipped a
 * gate that was silently disabled by exactly that gap.
 *
 * It also drives the REAL consolidator (`pollSubmittedRows`), not a re-implementation:
 * a stub HTTP server impersonates the QB bridge and returns the verbatim not-found
 * envelope the live bridge produced for the deleted bill FTL - 1573151.
 *
 * SAFETY
 * Refuses to run unless DATABASE_URL points at sandbox Postgres (5499). Every
 * fixture id is prefixed `vb_e2eleak_` / cleaned up in a finally block, and the
 * script asserts the cleanup actually happened.
 *
 * Run (sandbox stack up):
 *   env DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5499/ecopowertech \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-bill-payment-check-leak-sandbox.ts
 */
import { createServer, type Server } from "http";

import { Client } from "pg";

const BILL_PREFIX = "vb_e2eleak_";
const FAKE_TXN_ID = "1CAB66-0000000000";

let failures = 0;
const assert = (ok: boolean, label: string, detail = ""): void => {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/** Verbatim shape the live bridge returned for a Bill deleted inside QuickBooks. */
const NOT_FOUND_OPERATION = {
  operation: {
    id: "e2e-op",
    status: "completed",
    error: null,
    result: {
      QBXML: {
        QBXMLMsgsRs: {
          BillQueryRs: {
            $: {
              statusCode: "500",
              statusSeverity: "Warn",
              statusMessage: `The query request has not been fully completed. There was a required element ("${FAKE_TXN_ID}") that could not be found in QuickBooks.`,
            },
          },
        },
      },
    },
  },
};

function startStubBridge(port: number): Promise<Server> {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if ((req.url ?? "").startsWith("/api/sync/status/")) {
      res.end(JSON.stringify(NOT_FOUND_OPERATION));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "stub bridge: unexpected path" }));
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

async function seed(client: Client): Promise<{ billId: string; rowId: string }> {
  const billId = `${BILL_PREFIX}gone`;
  await client.query(
    `INSERT INTO vendor_bill
       (id, status, qb_txn_id, qb_ref_number, vendor_name_snapshot,
        qb_amount_due_cents, qb_is_paid, qb_source, created_at, updated_at)
     VALUES ($1, 'synced', $2, 'E2E-REF-GONE', 'E2E Vendor',
             180700, false, 'adopted', NOW(), NOW())`,
    [billId, FAKE_TXN_ID]
  );
  const { rows } = await client.query(
    `INSERT INTO qb_order_pipeline
       (id, reference_id, reference_type, step, status, qb_txn_id,
        bridge_op_id, retry_count, payload, submitted_at, created_at, updated_at)
     VALUES (gen_random_uuid(), $1::text, 'vendor_bill', 'vendor_bill_payment_check',
             'submitted', $2::text, 'e2e-op', 0,
             -- Casts are load-bearing: inside jsonb_build_object Postgres cannot
             -- infer a bare placeholder's type and rejects the whole statement with
             -- 42P08 "could not determine data type of parameter $1".
             jsonb_build_object('vendor_bill_id', $1::text, 'txn_id', $2::text),
             NOW(), NOW(), NOW())
     RETURNING id`,
    [billId, FAKE_TXN_ID]
  );
  return { billId, rowId: rows[0].id };
}

async function cleanup(client: Client): Promise<void> {
  await client.query(
    `DELETE FROM qb_order_pipeline WHERE reference_id LIKE $1`,
    [`${BILL_PREFIX}%`]
  );
  await client.query(`DELETE FROM vendor_bill WHERE id LIKE $1`, [
    `${BILL_PREFIX}%`,
  ]);
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  if (!/:5499\b/.test(connectionString)) {
    throw new Error(
      "Refusing to run: DATABASE_URL is not sandbox Postgres (expected port 5499)"
    );
  }

  const port = 9788;
  process.env.QB_BRIDGE_URL = `http://127.0.0.1:${port}`;
  process.env.QB_API_KEY = process.env.QB_API_KEY ?? "e2e-stub";
  process.env.QB_ORDER_FLOW_ENABLED = "true";

  const server = await startStubBridge(port);
  const client = new Client({ connectionString });
  await client.connect();

  // Imported AFTER QB_BRIDGE_URL is set: the bridge client reads env at call
  // time, but importing late also keeps this honest if that ever changes.
  const { pollSubmittedRows } = await import(
    "../../lib/quickbooks/consolidator/poll-submitted-rows"
  );

  const logger = {
    info: (m: string) => console.log(`   [log] ${m}`),
    warn: (m: string) => console.log(`   [warn] ${m}`),
    error: (m: string) => console.log(`   [err] ${m}`),
  };

  try {
    await cleanup(client);
    const { billId, rowId } = await seed(client);
    console.log(`\nSeeded bill ${billId} pointing at a QB TxnID that does not exist.`);

    // ── 1. The real poller settles the row and marks the bill ──────────────
    console.log("\n── 1. Real consolidator poll against the not-found response ──");
    const { rows: submitted } = await client.query(
      `SELECT id, step, status, reference_id, reference_type, qb_txn_id,
              bridge_op_id, retry_count, payload, order_id
         FROM qb_order_pipeline WHERE id = $1`,
      [rowId]
    );
    await pollSubmittedRows(
      submitted as never,
      { resolve: () => undefined } as never,
      logger
    );

    const { rows: after } = await client.query(
      `SELECT status, error, next_retry_at FROM qb_order_pipeline WHERE id = $1`,
      [rowId]
    );
    assert(
      after[0].status === "skipped",
      "row settled as 'skipped' (terminal, not a red Failed nobody can clear)",
      `got '${after[0].status}'`
    );
    assert(
      after[0].next_retry_at === null,
      "no retry scheduled — a deleted document never comes back"
    );
    assert(
      String(after[0].error ?? "").includes("no longer exists in QuickBooks"),
      "the row error names the actual cause",
      String(after[0].error ?? "").slice(0, 80)
    );

    const { rows: bill } = await client.query(
      `SELECT qb_missing_in_qb_at, qb_payment_checked_at
         FROM vendor_bill WHERE id = $1`,
      [billId]
    );
    assert(
      bill[0].qb_missing_in_qb_at != null,
      "the bill is stamped as missing in QuickBooks"
    );
    assert(
      bill[0].qb_payment_checked_at != null,
      "the check is recorded as having happened"
    );

    // ── 2. The monitor does not clone the dead row, twice over ─────────────
    console.log("\n── 2. Two more hourly ticks must not queue anything ──");

    // POSITIVE CONTROL, and it is not optional. `isScheduledJobsDisabled` makes
    // the whole job a no-op when DISABLE_SCHEDULED_JOBS=true — which `dev.sh`
    // exports — so "zero new rows" would pass for a monitor that never ran at all.
    // This healthy bill MUST get a row on the same tick; if it does not, the tick
    // was inert and the assertion below proves nothing.
    // AGE THE FIXTURE PAST THE 12 h WINDOW. Without this the test is VACUOUS and
    // it took a mutation run to notice: `settleBillMissingInQb` stamps
    // `qb_payment_checked_at = NOW()`, and the candidate query already requires
    // that stamp to be older than 12 h — so the bill was ineligible for reasons
    // that had nothing to do with the two guard layers, and the assertion below
    // passed even with BOTH layers deleted from the job.
    //
    // Winding the stamp back is what makes the tick genuinely want this bill
    // again, which is the only state in which "zero new rows" says anything. It is
    // also the real-world state: the leak fired hourly precisely because a failed
    // check never advanced that stamp at all.
    await client.query(
      `UPDATE vendor_bill
          SET qb_payment_checked_at = NOW() - INTERVAL '30 hours'
        WHERE id = $1`,
      [billId]
    );

    const controlBill = `${BILL_PREFIX}healthy`;
    await client.query(
      `INSERT INTO vendor_bill
         (id, status, qb_txn_id, qb_ref_number, vendor_name_snapshot,
          qb_amount_due_cents, qb_is_paid, created_at, updated_at)
       VALUES ($1, 'synced', 'E2E-TXN-HEALTHY', 'E2E-REF-OK', 'E2E Vendor',
               5000, false, NOW(), NOW())`,
      [controlBill]
    );
    const monitorModule = await import(
      "../../jobs/qb-vendor-bill-payment-monitor"
    );
    const monitor = monitorModule.default;
    const fakeContainer = {
      resolve: (key: string) =>
        key === "logger" ? logger : { info: logger.info, warn: logger.warn },
    };
    const countRows = async (): Promise<number> => {
      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM qb_order_pipeline WHERE reference_id = $1`,
        [billId]
      );
      return rows[0].n;
    };
    const countControlRows = async (): Promise<number> => {
      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM qb_order_pipeline WHERE reference_id = $1`,
        [controlBill]
      );
      return rows[0].n;
    };
    const before = await countRows();
    await monitor(fakeContainer as never);
    await monitor(fakeContainer as never);
    const afterTicks = await countRows();
    const controlAfter = await countControlRows();

    assert(
      controlAfter > 0,
      "CONTROL: the healthy bill DID get queued — so the tick really ran",
      `${controlAfter} row(s)`
    );
    assert(
      afterTicks === before,
      "two ticks queued ZERO new rows for the missing bill",
      `${before} → ${afterTicks}`
    );
    assert(before === 1, "exactly one row exists for the whole episode", `${before}`);

    // ── 3. A human re-check clears the marker ──────────────────────────────
    console.log("\n── 3. The human escape hatch reopens it ──");
    const { clearBillMissingInQb } = await import(
      "../../lib/quickbooks/pipeline/vendor-bill-missing"
    );
    await clearBillMissingInQb(billId);
    const { rows: cleared } = await client.query(
      `SELECT qb_missing_in_qb_at FROM vendor_bill WHERE id = $1`,
      [billId]
    );
    assert(
      cleared[0].qb_missing_in_qb_at === null,
      "an explicit re-check clears the missing marker"
    );

    // ── 4. Deterministic pagination over tied created_at ───────────────────
    console.log("\n── 4. Pagination is a total order over tied created_at ──");
    const pageSql = (offset: number): string => `
      SELECT p.id FROM qb_order_pipeline p
       ORDER BY p.created_at DESC, p.seq DESC
       LIMIT 12 OFFSET ${offset}`;
    const p1 = (await client.query(pageSql(0))).rows.map((r) => r.id);
    const p2 = (await client.query(pageSql(12))).rows.map((r) => r.id);
    const overlap = p1.filter((id) => p2.includes(id));
    assert(
      overlap.length === 0,
      "page 1 and page 2 share no row",
      `overlap=${overlap.length}`
    );
    const p1again = (await client.query(pageSql(0))).rows.map((r) => r.id);
    assert(
      JSON.stringify(p1) === JSON.stringify(p1again),
      "the same page is byte-identical across two queries"
    );
    const tiedSql = `
      SELECT COUNT(*)::int AS n FROM qb_order_pipeline p
       WHERE p.created_at IN (
         SELECT created_at FROM qb_order_pipeline
          GROUP BY created_at HAVING COUNT(*) > 1)`;
    const tied = (await client.query(tiedSql)).rows[0].n;
    console.log(
      `   (${tied} rows in this database share a created_at with another — the condition that made the old order non-deterministic)`
    );
  } finally {
    await cleanup(client);
    const { rows: left } = await client.query(
      `SELECT (SELECT COUNT(*) FROM vendor_bill WHERE id LIKE $1)
            + (SELECT COUNT(*) FROM qb_order_pipeline WHERE reference_id LIKE $1)
              AS n`,
      [`${BILL_PREFIX}%`]
    );
    assert(Number(left[0].n) === 0, "all fixtures removed", `left=${left[0].n}`);
    await client.end();
    server.close();
  }

  console.log("");
  if (failures > 0) {
    console.error(`❌ FAIL — ${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("✅ PASS — one settled row, zero clones, escape hatch works, order total.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
