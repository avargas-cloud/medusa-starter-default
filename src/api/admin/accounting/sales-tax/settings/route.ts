import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";

import { getQbConfig } from "../../../../../lib/quickbooks/qb-config";
import { loadSalesTaxSettings, saveSalesTaxSettings } from "../../../../../lib/sales-tax/settings";

import { CENTS_SCHEMA, invalid, withAccounting, withAccountingAndPin } from "../_lib/common";

/**
 * GET  /admin/accounting/sales-tax/settings
 *   → { settings, options: { bank_accounts, vendors, income_accounts, expense_accounts, qb_default_tax_item } }
 * PUT  /admin/accounting/sales-tax/settings  (PIN)  { tax_item_list_id?, tax_item_name?, vendor_list_id?, vendor_name?,
 *        default_bank_account_list_id?, variance_tolerance_cents? } → { settings }
 *
 * `qb_default_tax_item` sale de la config del order-flow (`quickbooks_config` +
 * QB_TAX_ITEM_LISTID_TAXED): es el mismo ItemSalesTax que viaja en cada invoice,
 * así que "Use QuickBooks default" no puede apuntar a otro ítem que el que cobra.
 */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  await withAccounting(req, res, async (client) => {
    const settings = await loadSalesTaxSettings(client);
    const [banks, vendors, income, expense] = await Promise.all([
      client.query<{ qb_list_id: string; full_name: string }>(
        `SELECT qb_list_id, full_name FROM qb_account WHERE account_type = 'Bank' AND is_active AND deleted_at IS NULL ORDER BY full_name`
      ),
      client.query<{ qb_list_id: string; name: string }>(
        `SELECT qb_list_id, COALESCE(full_name, name) AS name FROM qb_vendor
          WHERE is_active AND deleted_at IS NULL AND qb_list_id IS NOT NULL AND qb_list_id NOT LIKE 'pending_%'
          ORDER BY 2`
      ),
      client.query<{ qb_list_id: string; full_name: string; account_type: string }>(
        `SELECT qb_list_id, full_name, account_type FROM qb_account
          WHERE account_type IN ('Income','OtherIncome') AND is_active AND deleted_at IS NULL ORDER BY full_name`
      ),
      client.query<{ qb_list_id: string; full_name: string; account_type: string }>(
        `SELECT qb_list_id, full_name, account_type FROM qb_account
          WHERE account_type IN ('Expense','OtherExpense') AND is_active AND deleted_at IS NULL ORDER BY full_name`
      ),
    ]);
    const qb = await getQbConfig();
    res.json({
      settings,
      options: {
        bank_accounts: banks.rows,
        vendors: vendors.rows,
        income_accounts: income.rows,
        expense_accounts: expense.rows,
        qb_default_tax_item: { list_id: qb.taxItemListidTaxed ?? null, name: qb.defaultSalesTaxCode },
      },
    });
  });
}

const BODY = z.object({
  tax_item_list_id: z.string().trim().min(1).nullable().optional(),
  tax_item_name: z.string().trim().max(80).nullable().optional(),
  vendor_list_id: z.string().trim().min(1).nullable().optional(),
  vendor_name: z.string().trim().max(200).nullable().optional(),
  default_bank_account_list_id: z.string().trim().min(1).nullable().optional(),
  variance_tolerance_cents: CENTS_SCHEMA.optional(),
});

export async function PUT(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const parsed = BODY.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error.issues[0]?.message);
  await withAccountingAndPin(req, res, async (client, actorId) => {
    const settings = await saveSalesTaxSettings(client, parsed.data, actorId);
    res.json({ settings });
  });
}
