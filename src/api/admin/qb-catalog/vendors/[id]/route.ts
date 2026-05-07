import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { QUICKBOOKS_CATALOG_MODULE } from "../../../../../modules/quickbooks-catalog";
import { updateSingleVendorMeiliWorkflow } from "../../../../../workflows/update-single-vendor-meili";

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
      "metadata",
      "last_synced_at",
      "sync_status",
      "last_error",
      "qb_operation_id",
      "resolved_at",
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

type PatchVendorBody = {
  full_name?: string | null;
  name?: string | null;
  company_name?: string | null;
  account_number?: string | null;
  first_name?: string | null;
  middle_initial?: string | null;
  last_name?: string | null;
  contact?: string | null;
  alt_contact?: string | null;
  email?: string | null;
  phone?: string | null;
  alt_phone?: string | null;
  fax?: string | null;
  addr1?: string | null;
  addr2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
  terms_ref_name?: string | null;
  prefill_account_ref_name?: string | null;
  vendor_type_ref_name?: string | null;
  currency_ref_name?: string | null;
  tax_identity?: string | null;
  is_vendor_eligible_for_1099?: boolean | null;
  credit_limit?: string | number | null;
  notes?: string | null;
  metadata?: Record<string, unknown>;
};

const TEXT_FIELDS = [
  "full_name",
  "name",
  "company_name",
  "account_number",
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
  "notes",
] as const;

function normalizeText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export const PATCH = async (
  req: MedusaRequest<PatchVendorBody>,
  res: MedusaResponse
) => {
  const catalog = req.scope.resolve(QUICKBOOKS_CATALOG_MODULE) as any;
  const query = req.scope.resolve("query");
  const id = req.params.id;

  const body = req.body ?? {};
  const updates: Record<string, unknown> = {};

  for (const field of TEXT_FIELDS) {
    const normalized = normalizeText(body[field]);
    if (normalized !== undefined) {
      updates[field] = normalized;
    }
  }

  if ("is_vendor_eligible_for_1099" in body) {
    if (
      body.is_vendor_eligible_for_1099 !== null &&
      typeof body.is_vendor_eligible_for_1099 !== "boolean"
    ) {
      return res.status(400).json({
        error: "is_vendor_eligible_for_1099 must be a boolean or null",
      });
    }
    updates.is_vendor_eligible_for_1099 = body.is_vendor_eligible_for_1099;
  }

  if ("credit_limit" in body) {
    if (body.credit_limit === null || body.credit_limit === "") {
      updates.credit_limit = null;
    } else {
      const value = Number(body.credit_limit);
      if (!Number.isFinite(value) || value < 0) {
        return res.status(400).json({ error: "credit_limit must be a positive number" });
      }
      updates.credit_limit = value;
    }
  }

  const incomingMetadata = body.metadata;
  if (
    incomingMetadata !== undefined &&
    (incomingMetadata === null || typeof incomingMetadata !== "object")
  ) {
    return res.status(400).json({ error: "metadata must be an object" });
  }

  if (Object.keys(updates).length === 0 && incomingMetadata === undefined) {
    return res.status(400).json({ error: "No editable vendor fields provided" });
  }

  const { data } = await query.graph({
    entity: "qb_vendor",
    fields: ["id", "metadata"],
    filters: { id },
    pagination: { skip: 0, take: 1 },
  });

  const vendor = data?.[0];
  if (!vendor) {
    return res.status(404).json({ error: "Vendor not found" });
  }

  if ("name" in updates && !updates.name) {
    return res.status(400).json({ error: "name cannot be blank" });
  }
  if ("full_name" in updates && !updates.full_name) {
    return res.status(400).json({ error: "full_name cannot be blank" });
  }

  const merged =
    incomingMetadata === undefined
      ? undefined
      : { ...(vendor.metadata ?? {}), ...incomingMetadata };

  await catalog.updateQbVendors({
    id,
    ...updates,
    ...(merged === undefined ? {} : { metadata: merged }),
  });

  void updateSingleVendorMeiliWorkflow(req.scope)
    .run({ input: { vendor_id: id as string } })
    .catch((e) =>
      console.error(`[vendor-patch] Meili sync failed for ${id}:`, e?.message)
    );

  return res.json({ success: true, metadata: merged ?? vendor.metadata ?? null });
};
