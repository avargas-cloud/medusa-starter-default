import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { QUICKBOOKS_CATALOG_MODULE } from "../../../../modules/quickbooks-catalog";

/**
 * GET /admin/qb-catalog/vendors
 * Query params:
 *   search?: substring match on full_name (case-insensitive)
 *   active?: "true" | "false" (default true)
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const query = req.scope.resolve("query");

  const search = req.query.search ? String(req.query.search).toLowerCase() : undefined;
  const activeOnly = req.query.active !== "false";

  const filters: any = {};
  if (activeOnly) filters.is_active = true;

  const { data } = await query.graph({
    entity: "qb_vendor",
    fields: [
      "id",
      "qb_list_id",
      "full_name",
      "name",
      "company_name",
      "account_number",
      "is_active",
      "first_name",
      "last_name",
      "contact",
      "email",
      "phone",
      "city",
      "state",
      "terms_ref_name",
      "prefill_account_ref_name",
      "vendor_type_ref_name",
      "last_synced_at",
    ],
    filters,
    pagination: { skip: 0, take: 2000 },
  });

  const filtered = search
    ? data.filter((v: any) => {
        const haystack = [
          v.full_name,
          v.company_name,
          v.email,
          v.phone,
          v.contact,
          v.first_name,
          v.last_name,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(search);
      })
    : data;

  return res.json({
    vendors: filtered.sort((a: any, b: any) => a.full_name.localeCompare(b.full_name)),
    count: filtered.length,
    module: QUICKBOOKS_CATALOG_MODULE,
  });
};
