import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { QUICKBOOKS_CATALOG_MODULE } from "../../../../modules/quickbooks-catalog";

/**
 * GET /admin/qb-catalog/accounts
 * Query params:
 *   type?:   "Income" | "CostOfGoodsSold" | "Expense" | ... (AccountType filter)
 *   search?: substring match on full_name (case-insensitive)
 *   active?: "true" | "false" (default true)
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const query = req.scope.resolve("query");

  const type = req.query.type ? String(req.query.type) : undefined;
  const search = req.query.search
    ? String(req.query.search).toLowerCase()
    : undefined;
  const activeOnly = req.query.active !== "false";

  const filters: any = {};
  if (type) filters.account_type = type;
  if (activeOnly) filters.is_active = true;

  const { data } = await query.graph({
    entity: "qb_account",
    fields: [
      "id",
      "qb_list_id",
      "full_name",
      "name",
      "account_type",
      "parent_full_name",
      "currency",
      "is_active",
      "last_synced_at",
    ],
    filters,
    pagination: { skip: 0, take: 1000 },
  });

  const filtered = search
    ? data.filter((a: any) =>
        (a.full_name ?? "").toLowerCase().includes(search)
      )
    : data;

  return res.json({
    accounts: filtered.sort((a: any, b: any) =>
      a.full_name.localeCompare(b.full_name)
    ),
    count: filtered.length,
    module: QUICKBOOKS_CATALOG_MODULE,
  });
};
