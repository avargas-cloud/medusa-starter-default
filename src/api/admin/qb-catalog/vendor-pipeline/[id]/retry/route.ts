import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { QUICKBOOKS_CATALOG_MODULE } from "../../../../../../modules/quickbooks-catalog";

const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com";
const API_KEY = process.env.QB_API_KEY || "";

type PipelineRow = {
  id: string;
  vendor_id: string;
  vendor_name: string;
  op_type: string;
  status: string;
  retries: number;
};

type VendorRow = {
  id: string;
  name: string;
  full_name: string;
  company_name: string | null;
  first_name: string | null;
  middle_initial: string | null;
  last_name: string | null;
  contact: string | null;
  email: string | null;
  phone: string | null;
  alt_phone: string | null;
  fax: string | null;
  addr1: string | null;
  addr2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  account_number: string | null;
  notes: string | null;
  tax_identity: string | null;
  is_vendor_eligible_for_1099: boolean | null;
  terms_ref_name: string | null;
  vendor_type_ref_name: string | null;
  metadata: Record<string, unknown> | null;
};

const buildPayload = (v: VendorRow, opType: string) => ({
  action: opType === "update" ? "update" : "add",
  Name: v.name ?? v.full_name,
  FirstName: v.first_name ?? undefined,
  MiddleInitial: v.middle_initial ?? undefined,
  LastName: v.last_name ?? undefined,
  Contact: v.contact ?? undefined,
  CompanyName: v.company_name ?? undefined,
  Email: v.email ?? undefined,
  Phone: v.phone ?? undefined,
  AltPhone: v.alt_phone ?? undefined,
  Fax: v.fax ?? undefined,
  AccountNumber: v.account_number ?? undefined,
  Notes: v.notes ?? undefined,
  VendorTaxIdent: v.tax_identity ?? undefined,
  IsVendorEligibleFor1099: v.is_vendor_eligible_for_1099 ?? undefined,
  TermsRef: (v.metadata as Record<string, unknown> | null)?.payment_terms as string ?? v.terms_ref_name ?? undefined,
  VendorTypeRef: v.vendor_type_ref_name ?? undefined,
  VendorAddress:
    v.addr1 || v.city || v.state
      ? {
          Addr1: v.addr1 ?? undefined,
          Addr2: v.addr2 ?? undefined,
          City: v.city ?? undefined,
          State: v.state ?? undefined,
          PostalCode: v.postal_code ?? undefined,
          Country: v.country ?? undefined,
        }
      : undefined,
});

/**
 * POST /admin/qb-catalog/vendor-pipeline/:id/retry
 * Re-dispatch a failed vendor op to the bridge and reset the pipeline row.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve("logger");
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
  const catalog = req.scope.resolve(QUICKBOOKS_CATALOG_MODULE) as any;
  const id = req.params.id;

  const { data: rows } = await query.graph({
    entity: "qb_vendor_pipeline",
    fields: ["id", "vendor_id", "vendor_name", "op_type", "status", "retries"],
    filters: { id },
    pagination: { skip: 0, take: 1 },
  });
  const row = (rows as PipelineRow[])[0];
  if (!row) return res.status(404).json({ error: "Pipeline row not found" });

  const { data: vendors } = await query.graph({
    entity: "qb_vendor",
    fields: [
      "id",
      "name",
      "full_name",
      "company_name",
      "first_name",
      "middle_initial",
      "last_name",
      "contact",
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
      "account_number",
      "notes",
      "tax_identity",
      "is_vendor_eligible_for_1099",
      "terms_ref_name",
      "vendor_type_ref_name",
      "metadata",
    ],
    filters: { id: row.vendor_id },
    pagination: { skip: 0, take: 1 },
  });
  const vendor = (vendors as VendorRow[])[0];
  if (!vendor) {
    return res.status(404).json({ error: "Underlying vendor missing" });
  }

  try {
    const bridgeRes = await fetch(`${BRIDGE_URL}/api/vendors`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "bypass-tunnel-reminder": "true",
      },
      body: JSON.stringify(buildPayload(vendor, row.op_type)),
    });
    const bridgeData = await bridgeRes.json();
    if (!bridgeRes.ok || !bridgeData.operationId) {
      throw new Error(
        bridgeData.error ?? `bridge status ${bridgeRes.status} no operationId`
      );
    }

    await catalog.updateQbVendorPipelines({
      id: row.id,
      status: "waiting",
      qb_operation_id: bridgeData.operationId,
      last_error: null,
      retries: (row.retries ?? 0) + 1,
    });

    await catalog.updateQbVendors({
      id: vendor.id,
      qb_operation_id: bridgeData.operationId,
      sync_status: "waiting",
      last_error: null,
      retry_count: 0,
      next_retry_at: null,
    });

    return res.json({
      success: true,
      operation_id: bridgeData.operationId,
      message: `Re-enqueued "${vendor.full_name}". Pipeline will resolve within ~60s.`,
    });
  } catch (err: any) {
    logger.error(
      `[vendor-pipeline retry] "${vendor.full_name}" failed: ${err.message}`
    );
    await catalog.updateQbVendorPipelines({
      id: row.id,
      status: "error",
      last_error: err.message,
      retries: (row.retries ?? 0) + 1,
    });
    return res.status(500).json({ success: false, error: err.message });
  }
};
