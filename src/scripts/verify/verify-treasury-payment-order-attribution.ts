/**
 * verify-treasury-payment-order-attribution.ts
 *
 * Sandbox-only integration smoke test for P2 (treasury re-anchor).
 *
 * Seeds a fixture (customer + payment + order with line items + order-only
 * PaymentApplication) on a specific test day, runs the SQL inside
 * load-sales-by-application against the sandbox postgres, and asserts that
 * the order-only application contributes COGS proportional to amount_applied
 * / order_total.
 *
 * Sandbox guard: refuses to run unless connected to localhost:5499 (sandbox).
 * Cleans up all rows it inserts before exit.
 *
 * Run:  yarn ts-node src/scripts/verify/verify-treasury-payment-order-attribution.ts
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";

import { Client } from "pg";

import { loadSalesByApplication } from "../../api/admin/accounting/treasury/_lib/load-sales-by-application";

interface PgFacade {
  raw: (sql: string, params: unknown[]) => Promise<{ rows: any[] }>;
}

function asKnexFacade(client: Client): PgFacade {
  return {
    raw: async (sql: string, params: unknown[]) => {
      // load-sales-by-application uses '?' placeholders for knex-style.
      // Convert to $N for node-pg.
      let idx = 0;
      const pgSql = sql.replace(/\?/g, () => `$${++idx}`);
      const res = await client.query(pgSql, params);
      return { rows: res.rows };
    },
  };
}

const TEST_DAY = "2026-05-28";
const TEST_TIMESTAMP = `${TEST_DAY} 12:00:00`;
const RUN_ID = `t-treasury-p2-${Date.now()}`;

const FIXTURE = {
  customer_id: `cus_${RUN_ID}`,
  order_id: `order_${RUN_ID}`,
  order_item_id: `oi_${RUN_ID}`,
  line_item_id: `oli_${RUN_ID}`,
  payment_id: `cpay_${RUN_ID}`,
  application_id: `papp_${RUN_ID}`,
};

async function guardSandbox(client: Client): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("localhost:5499") && !url.includes("127.0.0.1:5499")) {
    throw new Error(
      `Refusing to run: DATABASE_URL must point at sandbox (5499). Got: ${url}`
    );
  }
  const { rows } = await client.query(
    `SELECT current_database() AS db, inet_server_addr() AS addr`
  );
  if (rows[0]?.db !== "medusa") {
    throw new Error(`Unexpected db: ${JSON.stringify(rows[0])}`);
  }
}

async function pickVariantWithCost(
  client: Client
): Promise<{ variant_id: string; product_id: string; effective_cost: number }> {
  // Same fallback order as ORDER_COST_FALLBACK_EXPR in load-sales-by-application.
  const { rows } = await client.query(`
    SELECT pv.id AS variant_id, pv.product_id,
      COALESCE(
        NULLIF(pv.metadata->>'avg_landed_cost_cents', '')::numeric / 100.0,
        NULLIF(pv.metadata->>'qb_avg_cost', '')::numeric,
        NULLIF(pv.metadata->>'qb_purchase_cost', '')::numeric
      ) AS effective_cost
    FROM product_variant pv
    WHERE COALESCE(
      NULLIF(pv.metadata->>'avg_landed_cost_cents', ''),
      NULLIF(pv.metadata->>'qb_avg_cost', ''),
      NULLIF(pv.metadata->>'qb_purchase_cost', '')
    ) IS NOT NULL
      AND pv.product_id IS NOT NULL
    LIMIT 1
  `);
  if (rows.length === 0) {
    throw new Error("No product_variant with any cost metadata in sandbox");
  }
  return {
    variant_id: rows[0].variant_id,
    product_id: rows[0].product_id,
    effective_cost: Number(rows[0].effective_cost),
  };
}

async function seedFixture(
  client: Client,
  variant: { variant_id: string; product_id: string }
) {
  // Customer (best-effort — if customer table requires more cols, this will fail loudly)
  await client.query(
    `INSERT INTO customer (id, has_account, created_at, updated_at)
     VALUES ($1, false, NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    [FIXTURE.customer_id]
  );

  // Order with unit_price = $10, quantity = 5 → total = $50 = 5000 cents
  await client.query(
    `INSERT INTO "order" (id, status, created_at, updated_at, version, region_id, currency_code)
     VALUES ($1, 'pending', NOW(), NOW(), 1, NULL, 'usd')
     ON CONFLICT (id) DO NOTHING`,
    [FIXTURE.order_id]
  );

  await client.query(
    `INSERT INTO order_line_item (
       id, title, variant_id, product_id, unit_price, raw_unit_price,
       requires_shipping, is_discountable, is_tax_inclusive, created_at, updated_at
     )
     VALUES (
       $1, 'Verify fixture line', $2, $3, 10,
       jsonb_build_object('value', '10', 'precision', 20),
       true, true, false, NOW(), NOW()
     )
     ON CONFLICT (id) DO NOTHING`,
    [FIXTURE.line_item_id, variant.variant_id, variant.product_id]
  );

  await client.query(
    `INSERT INTO order_item (
       id, order_id, version, item_id, quantity, raw_quantity,
       fulfilled_quantity, raw_fulfilled_quantity,
       shipped_quantity, raw_shipped_quantity,
       return_requested_quantity, raw_return_requested_quantity,
       return_received_quantity, raw_return_received_quantity,
       return_dismissed_quantity, raw_return_dismissed_quantity,
       written_off_quantity, raw_written_off_quantity,
       delivered_quantity, raw_delivered_quantity,
       unit_price, created_at, updated_at
     )
     VALUES (
       $1, $2, 1, $3, 5, jsonb_build_object('value','5','precision',20),
       0, jsonb_build_object('value','0','precision',20),
       0, jsonb_build_object('value','0','precision',20),
       0, jsonb_build_object('value','0','precision',20),
       0, jsonb_build_object('value','0','precision',20),
       0, jsonb_build_object('value','0','precision',20),
       0, jsonb_build_object('value','0','precision',20),
       0, jsonb_build_object('value','0','precision',20),
       10, NOW(), NOW()
     )
     ON CONFLICT (id) DO NOTHING`,
    [FIXTURE.order_item_id, FIXTURE.order_id, FIXTURE.line_item_id]
  );

  // CustomerPayment: $20 (2000 cents) received on TEST_DAY
  await client.query(
    `INSERT INTO customer_payment (
       id, customer_id, source, type, amount, raw_amount, currency, method, status,
       received_at, created_at, updated_at
     )
     VALUES (
       $1, $2, 'pos', 'payment', 2000,
       jsonb_build_object('value','2000','precision',20),
       'usd', 'cash', 'partially_applied',
       $3::timestamp, NOW(), NOW()
     )
     ON CONFLICT (id) DO NOTHING`,
    [FIXTURE.payment_id, FIXTURE.customer_id, TEST_TIMESTAMP]
  );

  // PaymentApplication: order-only, $20 of the $50 order = 40%
  await client.query(
    `INSERT INTO payment_application (
       id, payment_id, invoice_id, invoice_number, order_id, amount_applied,
       raw_amount_applied, applied_at, applied_by, created_at, updated_at
     )
     VALUES (
       $1, $2, NULL, NULL, $3, 2000,
       jsonb_build_object('value','2000','precision',20),
       $4::timestamp, 'verify-script', NOW(), NOW()
     )
     ON CONFLICT (id) DO NOTHING`,
    [FIXTURE.application_id, FIXTURE.payment_id, FIXTURE.order_id, TEST_TIMESTAMP]
  );
}

async function cleanupFixture(client: Client) {
  await client.query(`DELETE FROM payment_application WHERE id = $1`, [
    FIXTURE.application_id,
  ]);
  await client.query(`DELETE FROM customer_payment WHERE id = $1`, [
    FIXTURE.payment_id,
  ]);
  await client.query(`DELETE FROM order_item WHERE id = $1`, [
    FIXTURE.order_item_id,
  ]);
  await client.query(`DELETE FROM order_line_item WHERE id = $1`, [
    FIXTURE.line_item_id,
  ]);
  await client.query(`DELETE FROM "order" WHERE id = $1`, [FIXTURE.order_id]);
  // Leave customer in place — referenced by other rows
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log("[verify] Connected to sandbox");
  let pass = 0;
  let fail = 0;

  try {
    await guardSandbox(client);
    console.log("[verify] Sandbox guard ✓");

    const variant = await pickVariantWithCost(client);
    console.log(
      `[verify] Using variant ${variant.variant_id} (cost $${variant.effective_cost})`
    );

    // Run baseline first (without fixture) to know the existing day total
    const facade = asKnexFacade(client);
    const dayStart = `${TEST_DAY} 00:00:00`;
    const dayEnd = `${TEST_DAY} 23:59:59.999999`;

    const baseline = await loadSalesByApplication(facade, dayStart, dayEnd);
    console.log("[verify] Baseline for", TEST_DAY, baseline);

    await seedFixture(client, variant);
    console.log("[verify] Fixture seeded");

    const seeded = await loadSalesByApplication(facade, dayStart, dayEnd);
    console.log("[verify] Seeded report", seeded);

    // Expected: $20 of $50 order = 40% prop. COGS = 5 qty × $cost × 100 × 0.4
    const expectedCogsDelta = Math.round(
      5 * variant.effective_cost * 100 * (2000 / (5 * 10 * 100))
    );
    const isChina = false; // qb_purchase_cost-only variants without origin tag = local
    const observedDelta = isChina
      ? Number(seeded.cogs_china_cents) - Number(baseline.cogs_china_cents)
      : Number(seeded.cogs_local_cents) - Number(baseline.cogs_local_cents);

    if (observedDelta === expectedCogsDelta) {
      console.log(
        `[verify] ✓ COGS attribution correct: delta=${observedDelta} (expected ${expectedCogsDelta})`
      );
      pass++;
    } else {
      console.error(
        `[verify] ✗ COGS attribution mismatch: delta=${observedDelta}, expected=${expectedCogsDelta}`
      );
      fail++;
    }

    // gross_revenue_pre_tax should also increase by $20 = 2000 cents proportional.
    // For order-only, source_subtotal == source_total == 5000 cents.
    // app_amount / source_total = 0.4. revenue delta = 5000 * 0.4 = 2000.
    const revDelta =
      Number(seeded.gross_revenue_pre_tax_cents) -
      Number(baseline.gross_revenue_pre_tax_cents);
    if (revDelta === 2000) {
      console.log(`[verify] ✓ Gross revenue attribution: delta=${revDelta}`);
      pass++;
    } else {
      console.error(
        `[verify] ✗ Gross revenue mismatch: delta=${revDelta}, expected 2000`
      );
      fail++;
    }
  } finally {
    try {
      await cleanupFixture(client);
      console.log("[verify] Fixture cleaned");
    } catch (err: any) {
      console.error("[verify] Cleanup error:", err.message);
    }
    await client.end();
  }

  console.log(`\n[verify] RESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[verify] Fatal:", err);
  process.exit(2);
});
