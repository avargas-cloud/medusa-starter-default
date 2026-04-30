/**
 * qb-config.ts
 *
 * Shared helper to read QuickBooks order-flow settings from the database.
 * Used by both the automatic subscriber (qb-order-subscriber.ts) and
 * the manual sync route (/admin/quickbooks/order).
 */

import { Client } from "pg";

export interface QbOrderConfig {
  shippingItemId: string;
  defaultSalesTaxCode: string;
  exemptSalesTaxCode: string;
}

/**
 * Reads QB order-flow settings from the DB config row.
 * Falls back to env vars or safe defaults if DB is unreachable.
 */
export async function getQbConfig(): Promise<QbOrderConfig> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    const res = await client.query(
      `SELECT shipping_item_id, default_sales_tax_code, exempt_sales_tax_code FROM quickbooks_config WHERE id = 'default' LIMIT 1`
    );
    const row = res.rows[0] || {};
    return {
      shippingItemId:
        row.shipping_item_id ||
        process.env.QB_SHIPPING_ITEM_ID ||
        "800006A3-1395258131",
      defaultSalesTaxCode:
        row.default_sales_tax_code ||
        process.env.QB_DEFAULT_SALES_TAX_CODE ||
        "Sale Tax 7%",
      exemptSalesTaxCode:
        row.exempt_sales_tax_code ||
        process.env.QB_EXEMPT_SALES_TAX_CODE ||
        "Exempt",
    };
  } catch {
    return {
      shippingItemId: process.env.QB_SHIPPING_ITEM_ID || "800006A3-1395258131",
      defaultSalesTaxCode:
        process.env.QB_DEFAULT_SALES_TAX_CODE || "Sale Tax 7%",
      exemptSalesTaxCode:
        process.env.QB_EXEMPT_SALES_TAX_CODE || "Exempt",
    };
  } finally {
    await client.end();
  }
}
