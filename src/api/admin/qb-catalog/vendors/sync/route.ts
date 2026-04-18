import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { QUICKBOOKS_CATALOG_MODULE } from "../../../../../modules/quickbooks-catalog";

const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com";
const API_KEY = process.env.QB_API_KEY || "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD";

const HEADERS = {
  "x-api-key": API_KEY,
  "bypass-tunnel-reminder": "true",
  "Content-Type": "application/json",
};

async function pollOperation(
  operationId: string,
  maxAttempts = 30,
  intervalMs = 3000
): Promise<any> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const res = await fetch(`${BRIDGE_URL}/api/sync/status/${operationId}`, {
      headers: HEADERS,
    });
    const data = await res.json();
    const status = data.operation?.status;
    if (status === "completed") return data.operation.result;
    if (status === "failed")
      throw new Error(data.operation.error || "QB operation failed");
  }
  throw new Error("QB operation timed out");
}

/**
 * POST /admin/qb-catalog/vendors/sync
 * Pulls all active vendors from QuickBooks via the bridge,
 * upserts into the local qb_vendor table.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const catalog = req.scope.resolve(QUICKBOOKS_CATALOG_MODULE) as any;
  const query = req.scope.resolve("query");
  const logger = req.scope.resolve("logger");

  try {
    const initRes = await fetch(`${BRIDGE_URL}/api/vendors`, {
      headers: HEADERS,
    });
    const initData = await initRes.json();
    if (!initData.operationId) {
      throw new Error("Bridge did not return operationId");
    }

    const result = await pollOperation(initData.operationId);

    const raw = result?.QBXML?.QBXMLMsgsRs?.VendorQueryRs?.VendorRet ?? [];
    const vendors = Array.isArray(raw) ? raw : [raw];

    if (vendors.length === 0) {
      return res.json({
        success: true,
        synced: 0,
        message: "No vendors returned from QuickBooks",
      });
    }

    const { data: existing } = await query.graph({
      entity: "qb_vendor",
      fields: ["id", "qb_list_id"],
      pagination: { skip: 0, take: 5000 },
    });
    const byListId = new Map(existing.map((v: any) => [v.qb_list_id, v]));

    let created = 0;
    let updated = 0;
    const now = new Date();

    for (const v of vendors) {
      const listId = v.ListID;
      if (!listId) continue;

      const addr = v.VendorAddress ?? {};
      const prefill = Array.isArray(v.PrefillAccountRef)
        ? v.PrefillAccountRef[0]
        : v.PrefillAccountRef;
      const creditLimitRaw = v.CreditLimit;
      const creditLimit =
        creditLimitRaw != null && !Number.isNaN(Number(creditLimitRaw))
          ? Number(creditLimitRaw)
          : null;

      const payload = {
        qb_list_id: listId,
        full_name: String(v.FullName ?? v.Name ?? ""),
        name: String(v.Name ?? v.FullName ?? ""),
        company_name: v.CompanyName ?? null,
        account_number: v.AccountNumber ?? null,
        is_active: v.IsActive !== false,

        first_name: v.FirstName ?? null,
        middle_initial: v.MiddleInitial ?? null,
        last_name: v.LastName ?? null,
        contact: v.Contact ?? null,
        alt_contact: v.AltContact ?? null,

        email: v.Email ?? null,
        phone: v.Phone ?? null,
        alt_phone: v.AltPhone ?? null,
        fax: v.Fax ?? null,

        addr1: addr.Addr1 ?? null,
        addr2: addr.Addr2 ?? null,
        city: addr.City ?? null,
        state: addr.State ?? null,
        postal_code: addr.PostalCode ?? null,
        country: addr.Country ?? null,

        terms_ref_name: v.TermsRef?.FullName ?? null,
        prefill_account_ref_name: prefill?.FullName ?? null,
        vendor_type_ref_name: v.VendorTypeRef?.FullName ?? null,
        currency_ref_name: v.CurrencyRef?.FullName ?? null,

        tax_identity: v.VendorTaxIdent ?? null,
        is_vendor_eligible_for_1099: (() => {
          const raw = v.IsVendorEligibleFor1099;
          if (raw === true || raw === "true" || raw === 1 || raw === "1") return true;
          if (raw === false || raw === "false" || raw === 0 || raw === "0") return false;
          return null;
        })(),
        credit_limit: creditLimit,

        notes: v.Notes ?? null,

        last_synced_at: now,
      };

      const prev = byListId.get(listId);
      if (!prev) {
        await catalog.createQbVendors(payload);
        created++;
      } else {
        await catalog.updateQbVendors({ id: prev.id, ...payload });
        updated++;
      }
    }

    logger.info(
      `[QB Catalog] Vendors sync: created=${created} updated=${updated} total=${vendors.length}`
    );

    return res.json({
      success: true,
      synced: vendors.length,
      created,
      updated,
      message: `Synced ${vendors.length} vendors (${created} new, ${updated} updated)`,
    });
  } catch (err: any) {
    logger.error(`[QB Catalog] Vendors sync failed: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
};
