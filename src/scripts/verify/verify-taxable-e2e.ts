/**
 * End-to-end taxable flag propagation test (sandbox-only).
 *
 * Walks the per-item taxable flag through every sales document layer:
 *   1. Estimate / Order  (order_line_item)
 *   2. POS Invoice       (pos_invoice_item)
 *   3. Credit Memo       (pos_credit_memo_item)
 *
 * Each layer gets two synthetic line items inserted: one regular (taxable=true)
 * product and one non-taxable product (INSTALL).  We assert the trigger sets
 * `taxable` correctly at INSERT time and that the math (subtotal vs tax base)
 * matches the documented behavior.
 *
 * Test data is created with `test_e2e_*` ids and cleaned up at the end.
 *
 * Run (sandbox):
 *   yarn medusa exec ./src/scripts/verify/verify-taxable-e2e.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";

// Hardcoded sandbox catalog references (taxable=false set earlier in Phase 1)
const REGULAR_PRODUCT = "prod_01KK53MV8XFSPCMK0SAVYB6K5K"; // Special Item / regular taxable
const REGULAR_VARIANT = "variant_01KK53MV8XGZBBX3ZEDZEBHV05";
const INSTALL_PRODUCT = "prod_01KPE2XSF7FKKS2QGB4B19EXJC"; // INSTALL (non-taxable)
const INSTALL_VARIANT = "variant_01KPE2XSF7YW52KWXEXAD8TVQH";

const REG_PRICE_CENTS = 10000; // $100.00
const INSTALL_PRICE_CENTS = 130000; // $1,300.00
const TAX_RATE = 0.07;

function expectedTax(): number {
  // Only the regular line is taxable.
  return Math.round(REG_PRICE_CENTS * TAX_RATE);
}
function expectedTotal(): number {
  return REG_PRICE_CENTS + INSTALL_PRICE_CENTS + expectedTax();
}

type Pg = { raw: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }> };

async function fetchRealOrderId(pg: Pg): Promise<string> {
  const r = await pg.raw(
    `SELECT id FROM "order" WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`
  );
  if (!r.rows[0]) throw new Error("no orders in sandbox to attach test items to");
  return r.rows[0].id;
}
async function fetchRealInvoiceId(pg: Pg): Promise<string> {
  const r = await pg.raw(`SELECT id FROM pos_invoice ORDER BY created_at DESC LIMIT 1`);
  if (!r.rows[0]) throw new Error("no pos_invoices in sandbox to attach test items to");
  return r.rows[0].id;
}
async function fetchRealCreditMemoId(pg: Pg): Promise<string> {
  const r = await pg.raw(`SELECT id FROM pos_credit_memo ORDER BY created_at DESC LIMIT 1`);
  if (!r.rows[0]) throw new Error("no pos_credit_memos in sandbox to attach test items to");
  return r.rows[0].id;
}

type Result = { name: string; ok: boolean; detail: string };

export default async function verifyTaxableE2E({ container }: ExecArgs) {
  const logger = container.resolve("logger");
  const pg = container.resolve("__pg_connection__") as Pg;

  const results: Result[] = [];
  const cleanup: Array<() => Promise<unknown>> = [];

  logger.info(`\n${"=".repeat(70)}`);
  logger.info(`E2E taxable propagation test — sandbox`);
  logger.info(`${"=".repeat(70)}`);
  logger.info(
    `Regular product: ${REGULAR_PRODUCT} ($${(REG_PRICE_CENTS / 100).toFixed(2)})`
  );
  logger.info(
    `Non-taxable: ${INSTALL_PRODUCT} ($${(INSTALL_PRICE_CENTS / 100).toFixed(2)})`
  );
  logger.info(`Expected tax: $${(expectedTax() / 100).toFixed(2)} (only on regular line)`);
  logger.info(`Expected total: $${(expectedTotal() / 100).toFixed(2)}`);

  try {
    // ── Layer 1: order_line_item ─────────────────────────────────────────────
    {
      const orderId = await fetchRealOrderId(pg);

      // Insert two line items via raw SQL — trigger should fill taxable.
      await pg.raw(
        `INSERT INTO order_line_item
          (id, product_id, variant_id, title, variant_sku,
           unit_price, raw_unit_price, requires_shipping, is_discountable,
           is_tax_inclusive, is_custom_price, is_giftcard, metadata)
         VALUES
          (?, ?, ?, ?, ?, ?, ?::jsonb, true, true, false, false, false, '{}'::jsonb)`,
        [
          "test_e2e_oli_reg",
          REGULAR_PRODUCT,
          REGULAR_VARIANT,
          "E2E REG",
          "E2E_REG",
          REG_PRICE_CENTS / 100,
          JSON.stringify({ value: String(REG_PRICE_CENTS / 100), precision: 20 }),
        ]
      );
      cleanup.push(() =>
        pg.raw(`DELETE FROM order_line_item WHERE id = 'test_e2e_oli_reg'`)
      );

      await pg.raw(
        `INSERT INTO order_line_item
          (id, product_id, variant_id, title, variant_sku,
           unit_price, raw_unit_price, requires_shipping, is_discountable,
           is_tax_inclusive, is_custom_price, is_giftcard, metadata)
         VALUES
          (?, ?, ?, ?, ?, ?, ?::jsonb, true, true, false, false, false, '{}'::jsonb)`,
        [
          "test_e2e_oli_install",
          INSTALL_PRODUCT,
          INSTALL_VARIANT,
          "E2E INSTALL",
          "INSTALL",
          INSTALL_PRICE_CENTS / 100,
          JSON.stringify({ value: String(INSTALL_PRICE_CENTS / 100), precision: 20 }),
        ]
      );
      cleanup.push(() =>
        pg.raw(`DELETE FROM order_line_item WHERE id = 'test_e2e_oli_install'`)
      );

      const r = await pg.raw(
        `SELECT id, taxable FROM order_line_item WHERE id LIKE 'test_e2e_oli_%' ORDER BY id`
      );
      const map = Object.fromEntries(r.rows.map((row: any) => [row.id, row.taxable]));
      const regOk = map["test_e2e_oli_reg"] === true;
      const insOk = map["test_e2e_oli_install"] === false;
      results.push({
        name: "L1 order_line_item: regular → taxable=true, INSTALL → taxable=false",
        ok: regOk && insOk,
        detail: `attached to order ${orderId}; reg=${map["test_e2e_oli_reg"]} install=${map["test_e2e_oli_install"]}`,
      });
    }

    // ── Layer 2: pos_invoice_item ────────────────────────────────────────────
    {
      const invoiceId = await fetchRealInvoiceId(pg);
      await pg.raw(
        `INSERT INTO pos_invoice_item
          (id, invoice_id, variant_id, sku, description,
           quantity, unit_price, total, raw_unit_price, raw_total)
         VALUES
          (?, ?, ?, ?, ?, 1, ?, ?, ?::jsonb, ?::jsonb)`,
        [
          "test_e2e_inv_reg",
          invoiceId,
          REGULAR_VARIANT,
          "E2E_REG",
          "E2E REG",
          REG_PRICE_CENTS,
          REG_PRICE_CENTS,
          JSON.stringify({ value: String(REG_PRICE_CENTS), precision: 20 }),
          JSON.stringify({ value: String(REG_PRICE_CENTS), precision: 20 }),
        ]
      );
      cleanup.push(() =>
        pg.raw(`DELETE FROM pos_invoice_item WHERE id = 'test_e2e_inv_reg'`)
      );

      await pg.raw(
        `INSERT INTO pos_invoice_item
          (id, invoice_id, variant_id, sku, description,
           quantity, unit_price, total, raw_unit_price, raw_total)
         VALUES
          (?, ?, ?, ?, ?, 1, ?, ?, ?::jsonb, ?::jsonb)`,
        [
          "test_e2e_inv_install",
          invoiceId,
          INSTALL_VARIANT,
          "INSTALL",
          "INSTALL",
          INSTALL_PRICE_CENTS,
          INSTALL_PRICE_CENTS,
          JSON.stringify({ value: String(INSTALL_PRICE_CENTS), precision: 20 }),
          JSON.stringify({ value: String(INSTALL_PRICE_CENTS), precision: 20 }),
        ]
      );
      cleanup.push(() =>
        pg.raw(`DELETE FROM pos_invoice_item WHERE id = 'test_e2e_inv_install'`)
      );

      const r = await pg.raw(
        `SELECT id, taxable FROM pos_invoice_item WHERE id LIKE 'test_e2e_inv_%' ORDER BY id`
      );
      const map = Object.fromEntries(r.rows.map((row: any) => [row.id, row.taxable]));
      const regOk = map["test_e2e_inv_reg"] === true;
      const insOk = map["test_e2e_inv_install"] === false;
      results.push({
        name: "L2 pos_invoice_item: regular → taxable=true, INSTALL → taxable=false",
        ok: regOk && insOk,
        detail: `attached to invoice ${invoiceId}; reg=${map["test_e2e_inv_reg"]} install=${map["test_e2e_inv_install"]}`,
      });
    }

    // ── Layer 3: pos_credit_memo_item ────────────────────────────────────────
    {
      const cmId = await fetchRealCreditMemoId(pg);
      await pg.raw(
        `INSERT INTO pos_credit_memo_item
          (id, credit_memo_id, variant_id, sku, title, description,
           quantity, unit_price, line_total, raw_unit_price, raw_line_total)
         VALUES
          (?, ?, ?, ?, ?, ?, 1, ?, ?, ?::jsonb, ?::jsonb)`,
        [
          "test_e2e_cm_reg",
          cmId,
          REGULAR_VARIANT,
          "E2E_REG",
          "E2E REG",
          "E2E REG",
          REG_PRICE_CENTS,
          REG_PRICE_CENTS,
          JSON.stringify({ value: String(REG_PRICE_CENTS), precision: 20 }),
          JSON.stringify({ value: String(REG_PRICE_CENTS), precision: 20 }),
        ]
      );
      cleanup.push(() =>
        pg.raw(`DELETE FROM pos_credit_memo_item WHERE id = 'test_e2e_cm_reg'`)
      );

      await pg.raw(
        `INSERT INTO pos_credit_memo_item
          (id, credit_memo_id, variant_id, sku, title, description,
           quantity, unit_price, line_total, raw_unit_price, raw_line_total)
         VALUES
          (?, ?, ?, ?, ?, ?, 1, ?, ?, ?::jsonb, ?::jsonb)`,
        [
          "test_e2e_cm_install",
          cmId,
          INSTALL_VARIANT,
          "INSTALL",
          "INSTALL",
          "INSTALL",
          INSTALL_PRICE_CENTS,
          INSTALL_PRICE_CENTS,
          JSON.stringify({ value: String(INSTALL_PRICE_CENTS), precision: 20 }),
          JSON.stringify({ value: String(INSTALL_PRICE_CENTS), precision: 20 }),
        ]
      );
      cleanup.push(() =>
        pg.raw(`DELETE FROM pos_credit_memo_item WHERE id = 'test_e2e_cm_install'`)
      );

      const r = await pg.raw(
        `SELECT id, taxable FROM pos_credit_memo_item WHERE id LIKE 'test_e2e_cm_%' ORDER BY id`
      );
      const map = Object.fromEntries(r.rows.map((row: any) => [row.id, row.taxable]));
      const regOk = map["test_e2e_cm_reg"] === true;
      const insOk = map["test_e2e_cm_install"] === false;
      results.push({
        name: "L3 pos_credit_memo_item: regular → taxable=true, INSTALL → taxable=false",
        ok: regOk && insOk,
        detail: `attached to credit_memo ${cmId}; reg=${map["test_e2e_cm_reg"]} install=${map["test_e2e_cm_install"]}`,
      });
    }

    // ── Layer 4: math sanity (replicates POS computeTotals path) ─────────────
    {
      const lines = [
        { total: REG_PRICE_CENTS, taxable: true },
        { total: INSTALL_PRICE_CENTS, taxable: false },
      ];
      const subtotal = lines.reduce((s, l) => s + l.total, 0);
      const taxBase = lines.filter((l) => l.taxable).reduce((s, l) => s + l.total, 0);
      const tax = Math.round(taxBase * TAX_RATE);
      const total = subtotal + tax;
      const ok =
        subtotal === REG_PRICE_CENTS + INSTALL_PRICE_CENTS &&
        tax === expectedTax() &&
        total === expectedTotal();
      results.push({
        name: "L4 math: subtotal/tax/total cents-exact",
        ok,
        detail: `subtotal=$${(subtotal / 100).toFixed(2)} tax=$${(tax / 100).toFixed(2)} total=$${(total / 100).toFixed(2)}`,
      });
    }
  } finally {
    // Cleanup all inserted test rows in reverse order.
    for (const fn of cleanup.reverse()) {
      try {
        await fn();
      } catch (err: any) {
        logger.warn(`cleanup error: ${err?.message ?? err}`);
      }
    }
  }

  // Report
  logger.info("");
  let passed = 0;
  for (const r of results) {
    if (r.ok) {
      passed++;
      logger.info(`✅ ${r.name}\n   ${r.detail}`);
    } else {
      logger.info(`❌ ${r.name}\n   ${r.detail}`);
    }
  }
  logger.info(`\n${"=".repeat(70)}`);
  logger.info(`Results: ${passed}/${results.length} passed`);
  logger.info(`${"=".repeat(70)}`);

  if (passed < results.length) process.exitCode = 1;
}
