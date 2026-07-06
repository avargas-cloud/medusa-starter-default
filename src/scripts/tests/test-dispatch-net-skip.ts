/**
 * test-dispatch-net-skip.ts
 *
 * Integration test for Fix 3 (deploy-window dispatch safety net): invokes the REAL
 * resubmitByStep() for a cpay_-keyed apply_payment row that has a confirmed papp_
 * sibling, and asserts the row is marked 'skipped' WITHOUT reaching
 * handlePosPaymentApplied (i.e. no second ReceivePaymentMod).
 *
 * The skip path in resubmit-by-step only touches getDbPool() + the logger; the
 * Medusa container is passed to handlePosPaymentApplied, which must NOT be reached.
 * We pass a poisoned container that throws if resolved — proving the skip happens
 * before any dispatch.
 *
 * SANDBOX ONLY. Refuses a Railway/prod DATABASE_URL.
 *
 * Run:
 *   DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *     npx tsx src/scripts/tests/test-dispatch-net-skip.ts
 */
import { getDbPool } from "../../api/utils/db-pool";
import { resubmitByStep } from "../../lib/quickbooks/consolidator/resubmit-by-step";

const TAG = "order_TEST_DISPATCH_NET";
const CP = "cpay_TEST_DISPATCH_NET";
const PA = "papp_TEST_DISPATCH_NET";

async function cleanup(): Promise<void> {
  const pool = getDbPool();
  await pool.query(`DELETE FROM qb_order_pipeline WHERE order_id LIKE $1`, [`${TAG}%`]);
  await pool.query(`DELETE FROM payment_application WHERE id LIKE $1`, [`${PA}%`]);
  await pool.query(`DELETE FROM customer_payment WHERE id LIKE $1`, [`${CP}%`]);
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL not set");
  if (url.includes("railway") || url.includes("rlwy.net")) {
    throw new Error("REFUSING prod DATABASE_URL — sandbox only.");
  }
  console.log(`[test-dispatch-net] db=${url.replace(/:[^:@]+@/, ":***@")}\n`);

  const pool = getDbPool();
  const ts = Date.now();
  const orderId = `${TAG}_${ts}`;
  const cpay = `${CP}_${ts}`;
  const papp = `${PA}_${ts}`;
  const invoiceId = `inv_NET_${ts}`;

  await cleanup();

  // Seed customer_payment + payment_application
  await pool.query(
    `INSERT INTO customer_payment
        (id, customer_id, source, type, amount, currency, method, status,
         received_at, raw_amount, created_at, updated_at, medusa_payment_synced)
     VALUES ($1,'cust_TEST','pos','payment',1,'usd','cash','applied',
         NOW(),'{"value":"1","precision":20}'::jsonb, NOW(), NOW(), false)`,
    [cpay]
  );
  await pool.query(
    `INSERT INTO payment_application
        (id, payment_id, invoice_id, order_id, amount_applied, applied_at,
         raw_amount_applied, created_at, updated_at)
     VALUES ($1,$2,$3,$4,1,NOW(),'{"value":"1","precision":20}'::jsonb,NOW(),NOW())`,
    [papp, cpay, invoiceId, orderId]
  );

  // Confirmed papp_ sibling apply row
  await pool.query(
    `INSERT INTO qb_order_pipeline
            (order_id, reference_id, reference_type, step, status, retry_count, qb_txn_id)
         VALUES ($1,$2,'payment_application','apply_payment','confirmed',0,'1C-TESTTXN')`,
    [orderId, papp]
  );

  // The cpay_ row (simulating a stale-build write) — pending, ready to dispatch
  const { rows: cpayRow } = await pool.query(
    `INSERT INTO qb_order_pipeline
            (order_id, reference_id, reference_type, step, status, retry_count)
         VALUES ($1,$2,'customer_payment','apply_payment','pending',0)
         RETURNING id`,
    [orderId, cpay]
  );
  const cpayRowId = cpayRow[0].id as string;

  // Stub container: resubmitByStep resolves ORDER/CUSTOMER modules upfront (unused
  // by the skip path). Return a proxy that throws on ANY method call — so if the
  // code falls through to handlePosPaymentApplied (which USES resolved services),
  // it errors out and the row is NOT skipped → the assertion below fails. The Fix 3
  // skip path uses neither module, so it sails through to status='skipped'.
  const throwingStub: any = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error("stub service method invoked — reached dispatch, skip did NOT fire");
      },
    }
  );
  const stubContainer: any = { resolve: () => throwingStub };
  const logger: any = {
    info: (m: string) => console.log("  [logger.info]", m),
    warn: (m: string) => console.log("  [logger.warn]", m),
    error: (m: string) => console.log("  [logger.error]", m),
  };

  // Invoke the REAL dispatch code path.
  await resubmitByStep(
    {
      id: cpayRowId,
      order_id: orderId,
      reference_id: cpay,
      reference_type: "customer_payment",
      step: "apply_payment",
      qb_txn_id: null,
    },
    stubContainer,
    logger
  );

  const { rows: after } = await pool.query(
    `SELECT status, error FROM qb_order_pipeline WHERE id = $1`,
    [cpayRowId]
  );
  const status = after[0]?.status;
  const errorText: string = after[0]?.error ?? "";

  const pass =
    status === "skipped" && /superseded by payment_application/.test(errorText);

  console.log(`\n  cpay_ row after dispatch: status=${status}`);
  console.log(
    `  ${pass ? "✅ PASS" : "❌ FAIL"}  Fix 3 skips the cpay_ row before any dispatch`
  );

  await cleanup();
  await pool.end();
  process.exit(pass ? 0 : 1);
}

main().catch(async (err) => {
  console.error("[test-dispatch-net] fatal:", err);
  try {
    await cleanup();
    await getDbPool().end();
  } catch {}
  process.exit(1);
});
