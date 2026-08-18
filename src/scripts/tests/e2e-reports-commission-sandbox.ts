/**
 * e2e-reports-commission-sandbox.ts — las dos bases de comisión en los
 * reportes de ventas/compras, de punta a punta contra Postgres + HTTP reales.
 *
 * Cubre: los dos campos EXISTEN en la respuesta (línea base), el prorrateo
 * multi-factura reparte exacto sin perder ni inventar centavos (el corazón
 * del E2E), las dos bases DIFIEREN cuando corresponde (devengado vs
 * liquidación miden cosas distintas a propósito), un recipient `void` no
 * cuenta para el devengado, y `gross_profit` de `sales/summary` NO se mueve
 * por la comisión (garantía de comparabilidad histórica).
 *
 * REPETIBLE: borra sus propias filas `e2erc_%` al arrancar Y al terminar.
 * `order_commission.order_id` / `pos_invoice.order_id` son TEXT sin FK a la
 * tabla `order` real (verificado contra el esquema del sandbox) — el
 * fixture NO necesita una orden Medusa real detrás, sólo un id sintético.
 *
 * Uso (NUNCA contra producción — aborta si la DB no es :5499):
 *   env DATABASE_URL="postgres://postgres:sandbox@127.0.0.1:5499/medusa" \
 *       SANDBOX_URL="http://localhost:9099" \
 *       SANDBOX_ADMIN_EMAIL="sandbox@test.com" SANDBOX_ADMIN_PASSWORD="sandbox123" \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-reports-commission-sandbox.ts
 */
import { Pool } from "pg";

const BASE = process.env.SANDBOX_URL ?? "http://localhost:9099";
const ADMIN_EMAIL = process.env.SANDBOX_ADMIN_EMAIL ?? "";
const ADMIN_PASSWORD = process.env.SANDBOX_ADMIN_PASSWORD ?? "";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

interface FetchResult {
  status: number;
  body: Record<string, unknown>;
}

async function api(token: string, method: string, path: string): Promise<FetchResult> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  });
  const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: parsed };
}

// Fixture: ids fijos, reconocibles con el prefijo e2erc_.
const ORDER_ID = "e2erc_order_1";
const COMMISSION_ID = "e2erc_comm_1";
const RECIPIENT_ID = "e2erc_recip_1";
const VENDOR_ID = "e2erc_vendor_1";
const CUSTOMER_ID = "e2erc_cust_1";
const INVOICE_MAR_ID = "e2erc_inv_mar";
const INVOICE_APR_ID = "e2erc_inv_apr";
const ITEM_MAR_ID = "e2erc_item_mar";
const ITEM_APR_ID = "e2erc_item_apr";

const BASE_CENTS = 100_000; // $1,000 base de la orden
const PERCENT_BPS = 1_000; // 10% → $100 de comisión total
const TOTAL_COMMISSION_CENTS = 10_000; // 10% de 100_000

const MAR_TOTAL_CENTS = 75_000; // peso 75%
const APR_TOTAL_CENTS = 25_000; // peso 25%

// Ventanas de fecha — issued_at cae bien adentro, lejos de los bordes.
const MARCH_ONLY = { from: "2026-03-01T00:00:00.000Z", to: "2026-04-01T00:00:00.000Z" };
const APRIL_ONLY = { from: "2026-04-01T00:00:00.000Z", to: "2026-05-01T00:00:00.000Z" };
const BOTH_MONTHS = { from: "2026-03-01T00:00:00.000Z", to: "2026-05-01T00:00:00.000Z" };
const FULL_YEAR = { from: "2026-01-01T00:00:00.000Z", to: "2027-01-01T00:00:00.000Z" };

const rawJsonb = (cents: number): string => JSON.stringify({ value: String(cents), precision: 20 });

async function cleanup(pool: Pool): Promise<void> {
  // Dos sentencias: el WITH de Postgres comparte snapshot y no vería el
  // propio borrado si se intentara en una sola.
  await pool.query(
    `DELETE FROM commission_settlement
      WHERE recipient_id IN (SELECT id FROM order_commission_recipient WHERE id LIKE 'e2erc_%')
         OR recipient_id LIKE 'e2erc_%'`
  );
  await pool.query(`DELETE FROM order_commission_recipient WHERE id LIKE 'e2erc_%'`);
  await pool.query(`DELETE FROM order_commission WHERE id LIKE 'e2erc_%'`);
  await pool.query(`DELETE FROM pos_invoice_item WHERE id LIKE 'e2erc_%'`);
  await pool.query(`DELETE FROM pos_invoice WHERE id LIKE 'e2erc_%'`);
}

async function seedFixture(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO order_commission
       (id, order_id, currency_code, item_subtotal_cents, discount_cents, base_cents, discount_bps, cap_bps, wait_days, version)
     VALUES ($1, $2, 'usd', $3, 0, $3, 0, 10000, 30, 1)`,
    [COMMISSION_ID, ORDER_ID, BASE_CENTS]
  );

  // amount_cents NULL a propósito: ejercita el cálculo REAL vía
  // effectiveAmountCents(base_cents, percent_bps) dentro de
  // fetchAccruedCommissionCentsForPeriod, no un valor pre-congelado.
  await pool.query(
    `INSERT INTO order_commission_recipient
       (id, order_commission_id, qb_vendor_id, display_name, percent_bps, amount_cents, amount_mode, state)
     VALUES ($1, $2, $3, 'E2E RC Recipient', $4, NULL, 'percent', 'eligible')`,
    [RECIPIENT_ID, COMMISSION_ID, VENDOR_ID, PERCENT_BPS]
  );

  const invoice = async (id: string, totalCents: number, issuedAt: string): Promise<void> => {
    await pool.query(
      `INSERT INTO pos_invoice
         (id, invoice_number, order_id, customer_id, status, subtotal, tax, total, amount_paid, balance_due,
          raw_subtotal, raw_tax, raw_total, raw_amount_paid, raw_balance_due, discount, issued_at)
       VALUES ($1, $1, $2, $3, 'paid', $4, 0, $4, $4, 0, $5, $6, $5, $5, $6, 0, $7)`,
      [id, ORDER_ID, CUSTOMER_ID, totalCents, rawJsonb(totalCents), rawJsonb(0), issuedAt]
    );
  };
  await invoice(INVOICE_MAR_ID, MAR_TOTAL_CENTS, "2026-03-15T12:00:00.000Z");
  await invoice(INVOICE_APR_ID, APR_TOTAL_CENTS, "2026-04-15T12:00:00.000Z");

  const item = async (id: string, invoiceId: string, totalCents: number): Promise<void> => {
    await pool.query(
      `INSERT INTO pos_invoice_item
         (id, invoice_id, sku, description, quantity, unit_price, total, raw_unit_price, raw_total)
       VALUES ($1, $2, 'E2ERC-SKU', 'E2E RC fixture item', 1, $3, $3, $4, $4)`,
      [id, invoiceId, totalCents, rawJsonb(totalCents)]
    );
  };
  await item(ITEM_MAR_ID, INVOICE_MAR_ID, MAR_TOTAL_CENTS);
  await item(ITEM_APR_ID, INVOICE_APR_ID, APR_TOTAL_CENTS);
}

interface SalesSummary {
  commission?: number;
  gross_profit?: number;
}
interface CostProfit {
  totals?: { commission?: number };
}

async function fetchSalesSummary(
  token: string,
  range: { from: string; to: string }
): Promise<SalesSummary> {
  const res = await api(
    token,
    "GET",
    `/admin/reports/sales/summary?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
  );
  return res.body as SalesSummary;
}

async function fetchCostProfit(token: string, range: { from: string; to: string }): Promise<CostProfit> {
  const res = await api(
    token,
    "GET",
    `/admin/reports/purchases/cost-profit?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
  );
  return res.body as CostProfit;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!/127\.0\.0\.1:5499|localhost:5499/.test(url)) {
    console.error(`ABORT: DATABASE_URL no apunta al sandbox (:5499).`);
    process.exit(2);
  }
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error("ABORT: faltan SANDBOX_ADMIN_EMAIL / SANDBOX_ADMIN_PASSWORD.");
    process.exit(2);
  }
  const pool = new Pool({ connectionString: url });

  const authRes = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const auth = (await authRes.json().catch(() => ({}))) as { token?: string };
  if (!auth.token) {
    console.error(`ABORT: login falló (${authRes.status}).`);
    process.exit(2);
  }
  const token = auth.token;

  await cleanup(pool);

  console.log("§1 — línea base: los dos campos EXISTEN en la respuesta\n");
  {
    const summary = await fetchSalesSummary(token, FULL_YEAR);
    const costProfit = await fetchCostProfit(token, FULL_YEAR);
    check(
      "sales/summary.commission existe (no undefined)",
      summary.commission !== undefined,
      String(summary.commission)
    );
    check(
      "cost-profit.totals.commission existe (no undefined)",
      costProfit.totals?.commission !== undefined,
      String(costProfit.totals?.commission)
    );
  }

  console.log("\n§2 — fixture multi-factura: el prorrateo reparte EXACTO\n");
  await seedFixture(pool);
  try {
    const marchOnly = await fetchCostProfit(token, MARCH_ONLY);
    const aprilOnly = await fetchCostProfit(token, APRIL_ONLY);
    const bothMonths = await fetchCostProfit(token, BOTH_MONTHS);

    const marchCents = Math.round((marchOnly.totals?.commission ?? 0) * 100);
    const aprilCents = Math.round((aprilOnly.totals?.commission ?? 0) * 100);
    const bothCents = Math.round((bothMonths.totals?.commission ?? 0) * 100);

    check(
      "marzo + abril == 10000 (ningún centavo perdido ni inventado)",
      marchCents + aprilCents === TOTAL_COMMISSION_CENTS,
      `${marchCents} + ${aprilCents} = ${marchCents + aprilCents}`
    );
    check(
      "marzo ≠ abril (pesos 75/25 desiguales, el reparto es observable)",
      marchCents !== aprilCents,
      `marzo=${marchCents} abril=${aprilCents}`
    );
    check(
      "el período que cubre los dos meses == 10000",
      bothCents === TOTAL_COMMISSION_CENTS,
      `${bothCents}`
    );

    console.log("\n§3 — las dos bases DIFIEREN (sin settlement confirmado)\n");
    const accrued = await fetchCostProfit(token, BOTH_MONTHS);
    const settled = await fetchSalesSummary(token, BOTH_MONTHS);
    const accruedCents = Math.round((accrued.totals?.commission ?? 0) * 100);
    const settledCents = Math.round((settled.commission ?? 0) * 100);
    check("devengado > 0", accruedCents > 0, `${accruedCents}`);
    check("liquidación == 0 (no hay settlement confirmed)", settledCents === 0, `${settledCents}`);
    check(
      "devengado y liquidación DIFIEREN (miden cosas distintas)",
      accruedCents !== settledCents,
      `devengado=${accruedCents} liquidación=${settledCents}`
    );

    console.log("\n§4 — un recipient void no cuenta para el devengado\n");
    await pool.query(`UPDATE order_commission_recipient SET state = 'void' WHERE id = $1`, [
      RECIPIENT_ID,
    ]);
    try {
      const afterVoid = await fetchCostProfit(token, BOTH_MONTHS);
      const afterVoidCents = Math.round((afterVoid.totals?.commission ?? 0) * 100);
      check(
        "devengado BAJA (a 0) cuando el único recipient está void",
        afterVoidCents < accruedCents,
        `antes=${accruedCents} después=${afterVoidCents}`
      );
    } finally {
      await pool.query(`UPDATE order_commission_recipient SET state = 'eligible' WHERE id = $1`, [
        RECIPIENT_ID,
      ]);
    }

    console.log("\n§5 — gross_profit de sales/summary NO se mueve por la comisión\n");
    // Aislar SOLO la comisión (order_commission + recipient), dejando las
    // DOS invoices del fixture en pie: gross_profit sale de pos_invoice/
    // pos_invoice_item — borrar las invoices también movería el revenue de
    // la ventana y contaminaría la comparación con una causa ajena a la
    // comisión (medido: un primer intento que borraba TODO el fixture movió
    // gross_profit en exactamente los $1,000 de revenue de las invoices,
    // no por la comisión).
    const grossProfitWithCommission = (await fetchSalesSummary(token, BOTH_MONTHS)).gross_profit;
    await pool.query(`DELETE FROM commission_settlement WHERE recipient_id = $1`, [RECIPIENT_ID]);
    await pool.query(`DELETE FROM order_commission_recipient WHERE id = $1`, [RECIPIENT_ID]);
    await pool.query(`DELETE FROM order_commission WHERE id = $1`, [COMMISSION_ID]);
    const grossProfitWithoutCommission = (await fetchSalesSummary(token, BOTH_MONTHS)).gross_profit;
    check(
      "gross_profit es el MISMO con y sin la comisión (mismas invoices, sólo se quita commission)",
      grossProfitWithCommission === grossProfitWithoutCommission,
      `con=${grossProfitWithCommission} sin=${grossProfitWithoutCommission}`
    );
  } finally {
    await cleanup(pool);
  }

  const { rows: leftover } = await pool.query<{ n: string }>(
    `SELECT
       (SELECT count(*) FROM order_commission WHERE id LIKE 'e2erc_%')
     + (SELECT count(*) FROM order_commission_recipient WHERE id LIKE 'e2erc_%')
     + (SELECT count(*) FROM commission_settlement WHERE recipient_id LIKE 'e2erc_%')
     + (SELECT count(*) FROM pos_invoice WHERE id LIKE 'e2erc_%')
     + (SELECT count(*) FROM pos_invoice_item WHERE id LIKE 'e2erc_%') AS n`
  );
  check("limpieza final: cero filas e2erc_% remanentes", leftover[0]?.n === "0", `n=${leftover[0]?.n}`);

  await pool.end();
  console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed · ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("E2E crashed:", err);
  process.exit(1);
});
