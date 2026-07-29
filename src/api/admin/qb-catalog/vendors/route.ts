import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { QUICKBOOKS_CATALOG_MODULE } from "../../../../modules/quickbooks-catalog";
import { requireBridgeUrl } from "../../../../lib/quickbooks/bridge-url";

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
  terms_ref_name?: string | null;
  vendor_type_ref_name?: string | null;
  is_china_agent?: boolean;
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
      terms_ref_name: body.terms_ref_name ?? null,
      metadata: (() => {
        const md: Record<string, unknown> = {};
        if (body.terms_ref_name) md.payment_terms = body.terms_ref_name;
        // Persist explicit boolean so the flag survives Medusa's JSONB deep-merge
        // (a deleted/absent key would re-hydrate; see project deep-merge caveat).
        if (typeof body.is_china_agent === "boolean")
          md.is_china_agent = body.is_china_agent;
        return Object.keys(md).length > 0 ? md : null;
      })(),
      vendor_type_ref_name: body.vendor_type_ref_name ?? null,
      sync_status: "waiting",
      last_synced_at: new Date(),
    });

    let pipelineRow: { id: string } | null = null;
    try {
      pipelineRow = await catalog.createQbVendorPipelines({
        vendor_id: local.id,
        vendor_name: name,
        op_type: "create",
        status: "waiting",
      });
    } catch (pipelineErr: any) {
      logger.error(
        `[qb-catalog vendor create] pipeline insert failed (non-fatal): ${pipelineErr.message}`
      );
    }

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
      TermsRef: body.terms_ref_name ?? undefined,
      VendorTypeRef: body.vendor_type_ref_name ?? undefined,
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
      const bridgeRes = await fetch(`${requireBridgeUrl()}/api/vendors`, {
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
      if (pipelineRow) {
        await catalog.updateQbVendorPipelines({
          id: pipelineRow.id,
          qb_operation_id: data.operationId,
        });
      }
      logger.info(
        `[qb-catalog vendor create] "${name}" queued op=${data.operationId}`
      );
      return res.json({
        success: true,
        vendor: { ...local, qb_operation_id: data.operationId },
      });
    } catch (err: any) {
      await catalog.updateQbVendors({
        id: local.id,
        sync_status: "error",
        last_error: err.message,
      });
      if (pipelineRow) {
        await catalog.updateQbVendorPipelines({
          id: pipelineRow.id,
          status: "error",
          last_error: err.message,
        });
      }
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

  const search = req.query.search
    ? String(req.query.search).toLowerCase()
    : undefined;
  const listId = req.query.list_id ? String(req.query.list_id) : undefined;
  const activeOnly = req.query.active !== "false";
  const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 100;

  const filters: any = {};
  if (activeOnly) filters.is_active = true;
  if (listId) filters.qb_list_id = listId;

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
      "metadata",
      "prefill_account_ref_name",
      "vendor_type_ref_name",
      "last_synced_at",
    ],
    filters,
    pagination: { skip: 0, take: 2000 },
  });

  const vendorScore = (v: any): number => {
    if (!search) return 0;
    const name = (v.full_name ?? "").toLowerCase();
    const company = (v.company_name ?? "").toLowerCase();
    const contact = [v.contact, v.first_name, v.last_name]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const secondary = [v.phone, v.email]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (name.includes(search)) return 4;
    if (company.includes(search)) return 3;
    if (contact.includes(search)) return 2;
    if (secondary.includes(search)) return 1;
    return 0;
  };

  const filtered = search ? data.filter((v: any) => vendorScore(v) > 0) : data;

  const sorted = filtered.sort((a: any, b: any) => {
    const scoreDiff = vendorScore(b) - vendorScore(a);
    if (scoreDiff !== 0) return scoreDiff;
    return a.full_name.localeCompare(b.full_name);
  });
  const sliced = sorted.slice(0, limit);

  return res.json({
    vendors: sliced,
    count: sliced.length,
    total: filtered.length,
    module: QUICKBOOKS_CATALOG_MODULE,
  });
};
