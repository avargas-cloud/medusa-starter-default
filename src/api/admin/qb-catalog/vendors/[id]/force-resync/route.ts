import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { QUICKBOOKS_CATALOG_MODULE } from "../../../../../../modules/quickbooks-catalog";

const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com";
const API_KEY = process.env.QB_API_KEY || "";

/**
 * Admin-only manual re-queue for a vendor that landed in `error` or
 * `failed_permanent`. Clears retry counters, re-dispatches the add op to the
 * bridge, and flips the row back to `waiting`.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve("logger");
  const query = req.scope.resolve("query");
  const catalog = req.scope.resolve(QUICKBOOKS_CATALOG_MODULE) as any;
  const id = req.params.id;

  const { data } = await query.graph({
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
      "account_number",
      "notes",
      "tax_identity",
      "is_vendor_eligible_for_1099",
      "addr1",
      "addr2",
      "city",
      "state",
      "postal_code",
      "country",
      "sync_status",
      "qb_list_id",
    ],
    filters: { id },
    pagination: { skip: 0, take: 1 },
  });

  const vendor = (data as any[])[0];
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });

  // If already synced (has a real ListID), there's nothing to re-sync.
  const hasRealListId =
    vendor.qb_list_id &&
    !String(vendor.qb_list_id).startsWith("pending_");
  if (hasRealListId && vendor.sync_status === "synced") {
    return res.status(400).json({
      error: "Vendor already synced — use the Edit flow instead",
    });
  }

  const bridgePayload = {
    action: "add",
    Name: vendor.name ?? vendor.full_name,
    FirstName: vendor.first_name ?? undefined,
    MiddleInitial: vendor.middle_initial ?? undefined,
    LastName: vendor.last_name ?? undefined,
    Contact: vendor.contact ?? undefined,
    CompanyName: vendor.company_name ?? undefined,
    Email: vendor.email ?? undefined,
    Phone: vendor.phone ?? undefined,
    AltPhone: vendor.alt_phone ?? undefined,
    Fax: vendor.fax ?? undefined,
    AccountNumber: vendor.account_number ?? undefined,
    Notes: vendor.notes ?? undefined,
    VendorTaxIdent: vendor.tax_identity ?? undefined,
    IsVendorEligibleFor1099: vendor.is_vendor_eligible_for_1099 ?? undefined,
    TermsRef: vendor.terms_ref_name ?? undefined,
    VendorTypeRef: vendor.vendor_type_ref_name ?? undefined,
    VendorAddress:
      vendor.addr1 || vendor.city || vendor.state
        ? {
            Addr1: vendor.addr1 ?? undefined,
            Addr2: vendor.addr2 ?? undefined,
            City: vendor.city ?? undefined,
            State: vendor.state ?? undefined,
            PostalCode: vendor.postal_code ?? undefined,
            Country: vendor.country ?? undefined,
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
    const bridgeData = await bridgeRes.json();
    if (!bridgeRes.ok || !bridgeData.operationId) {
      throw new Error(
        bridgeData.error ?? `bridge status ${bridgeRes.status} no operationId`
      );
    }

    await catalog.updateQbVendors({
      id: vendor.id,
      qb_operation_id: bridgeData.operationId,
      sync_status: "waiting",
      last_error: null,
      retry_count: 0,
      next_retry_at: null,
    });

    try {
      await catalog.createQbVendorPipelines({
        vendor_id: vendor.id,
        vendor_name: vendor.full_name ?? vendor.name,
        op_type: "create",
        qb_operation_id: bridgeData.operationId,
        status: "waiting",
      });
    } catch (pipelineErr: any) {
      logger.error(`[qb-vendor force-resync] pipeline insert failed (non-fatal): ${pipelineErr.message}`);
    }

    logger.info(
      `[qb-vendor force-resync] "${vendor.full_name}" re-queued op=${bridgeData.operationId}`
    );
    return res.json({
      success: true,
      operation_id: bridgeData.operationId,
      message: `Re-enqueued "${vendor.full_name}". Pipeline will resolve within ~60s.`,
    });
  } catch (err: any) {
    logger.error(
      `[qb-vendor force-resync] bridge failed for "${vendor.full_name}": ${err.message}`
    );
    await catalog.updateQbVendors({
      id: vendor.id,
      sync_status: "error",
      last_error: err.message,
    });
    return res.status(502).json({
      success: false,
      error: `Bridge push failed: ${err.message}`,
    });
  }
};
