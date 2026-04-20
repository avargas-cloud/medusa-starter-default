import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { QUICKBOOKS_CATALOG_MODULE } from "../../../../modules/quickbooks-catalog";

const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com";
const API_KEY = process.env.QB_API_KEY || "";

type CreateVendorBody = {
  name: string;
  first_name?: string | null;
  middle_initial?: string | null;
  last_name?: string | null;
  contact?: string | null;
  company_name?: string | null;
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
  account_number?: string | null;
  notes?: string | null;
  tax_identity?: string | null;
  is_vendor_eligible_for_1099?: boolean | null;
};

export const POST = async (
  req: MedusaRequest<CreateVendorBody>,
  res: MedusaResponse
) => {
  const logger = req.scope.resolve("logger");
  const catalog = req.scope.resolve(QUICKBOOKS_CATALOG_MODULE) as any;
  const query = req.scope.resolve("query");

  const body = req.body;
  if (!body?.name || !body.name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }
  const name = body.name.trim();

  try {
    const { data: existing } = await query.graph({
      entity: "qb_vendor",
      fields: ["id", "full_name"],
      filters: { full_name: name } as any,
      pagination: { skip: 0, take: 1 },
    });
    if ((existing as any[])?.length > 0) {
      return res.status(409).json({
        error: `Vendor "${name}" already exists`,
        vendor: (existing as any[])[0],
      });
    }

    const local = await catalog.createQbVendors({
      qb_list_id: `pending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      full_name: name,
      name,
      company_name: body.company_name ?? null,
      account_number: body.account_number ?? null,
      is_active: true,
      first_name: body.first_name ?? null,
      middle_initial: body.middle_initial ?? null,
      last_name: body.last_name ?? null,
      contact: body.contact ?? null,
      email: body.email ?? null,
      phone: body.phone ?? null,
      alt_phone: body.alt_phone ?? null,
      fax: body.fax ?? null,
      addr1: body.addr1 ?? null,
      addr2: body.addr2 ?? null,
      city: body.city ?? null,
      state: body.state ?? null,
      postal_code: body.postal_code ?? null,
      country: body.country ?? null,
      notes: body.notes ?? null,
      tax_identity: body.tax_identity ?? null,
      is_vendor_eligible_for_1099: body.is_vendor_eligible_for_1099 ?? null,
      sync_status: "waiting",
      last_synced_at: new Date(),
    });

    const pipelineRow = await catalog.createQbVendorPipelines({
      vendor_id: local.id,
      vendor_name: name,
      op_type: "create",
      status: "waiting",
    });

    const bridgePayload = {
      action: "add",
      Name: name,
      FirstName: body.first_name ?? undefined,
      MiddleInitial: body.middle_initial ?? undefined,
      LastName: body.last_name ?? undefined,
      Contact: body.contact ?? undefined,
      CompanyName: body.company_name ?? undefined,
      Email: body.email ?? undefined,
      Phone: body.phone ?? undefined,
      AltPhone: body.alt_phone ?? undefined,
      Fax: body.fax ?? undefined,
      AccountNumber: body.account_number ?? undefined,
      Notes: body.notes ?? undefined,
      VendorTaxIdent: body.tax_identity ?? undefined,
      IsVendorEligibleFor1099: body.is_vendor_eligible_for_1099 ?? undefined,
      VendorAddress:
        body.addr1 || body.city || body.state
          ? {
              Addr1: body.addr1 ?? undefined,
              Addr2: body.addr2 ?? undefined,
              City: body.city ?? undefined,
              State: body.state ?? undefined,
              PostalCode: body.postal_code ?? undefined,
              Country: body.country ?? undefined,
            }
          : undefined,
    };

    try {
      const bridgeRes = await fetch(`${BRIDGE_URL}/api/vendors`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": API_KEY,
          "bypass-tunnel-reminder": "true",
        },
        body: JSON.stringify(bridgePayload),
      });
      const data = await bridgeRes.json();
      if (!bridgeRes.ok || !data.operationId) {
        throw new Error(
          data.error ?? `bridge status ${bridgeRes.status} no operationId`
        );
      }
      await catalog.updateQbVendors({
        id: local.id,
        qb_operation_id: data.operationId,
      });
      await catalog.updateQbVendorPipelines({
        id: pipelineRow.id,
        qb_operation_id: data.operationId,
      });
      logger.info(
        `[qb-catalog vendor create] "${name}" queued op=${data.operationId}`
      );
      return res.json({ success: true, vendor: { ...local, qb_operation_id: data.operationId } });
    } catch (err: any) {
      await catalog.updateQbVendors({
        id: local.id,
        sync_status: "error",
        last_error: err.message,
      });
      await catalog.updateQbVendorPipelines({
        id: pipelineRow.id,
        status: "error",
        last_error: err.message,
      });
      logger.error(
        `[qb-catalog vendor create] bridge failed for "${name}": ${err.message}`
      );
      return res.status(502).json({
        error: `Vendor saved locally but QB sync failed: ${err.message}`,
        vendor: local,
      });
    }
  } catch (err: any) {
    logger.error(`[qb-catalog vendor create] fatal: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
};

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
