import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const query = req.scope.resolve("query");
  const id = req.params.id;

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
      "middle_initial",
      "last_name",
      "contact",
      "alt_contact",
      "email",
      "phone",
      "alt_phone",
      "fax",
      "addr1",
      "addr2",
      "city",
      "state",
      "postal_code",
      "country",
      "terms_ref_name",
      "prefill_account_ref_name",
      "vendor_type_ref_name",
      "currency_ref_name",
      "tax_identity",
      "is_vendor_eligible_for_1099",
      "credit_limit",
      "notes",
      "last_synced_at",
      "created_at",
      "updated_at",
    ],
    filters: { id },
    pagination: { skip: 0, take: 1 },
  });

  const vendor = data?.[0];
  if (!vendor) {
    return res.status(404).json({ error: "Vendor not found" });
  }

  return res.json({ vendor });
};
