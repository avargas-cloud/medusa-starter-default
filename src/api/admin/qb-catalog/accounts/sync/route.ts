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
 * POST /admin/qb-catalog/accounts/sync
 * Pulls the full Chart of Accounts from QuickBooks via the bridge,
 * upserts into the local qb_account table.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const catalog = req.scope.resolve(QUICKBOOKS_CATALOG_MODULE) as any;
  const query = req.scope.resolve("query");
  const logger = req.scope.resolve("logger");

  try {
    // 1. Queue the account query on the bridge
    const initRes = await fetch(`${BRIDGE_URL}/api/accounts`, {
      headers: HEADERS,
    });
    const initData = await initRes.json();
    if (!initData.operationId) {
      throw new Error("Bridge did not return operationId");
    }

    // 2. Poll for result
    const result = await pollOperation(initData.operationId);

    // 3. Extract AccountRet list from QBXML response
    const raw = result?.QBXML?.QBXMLMsgsRs?.AccountQueryRs?.AccountRet ?? [];
    const accounts = Array.isArray(raw) ? raw : [raw];

    if (accounts.length === 0) {
      return res.json({
        success: true,
        synced: 0,
        message: "No accounts returned from QuickBooks",
      });
    }

    // 4. Load existing rows to detect upserts
    const { data: existing } = await query.graph({
      entity: "qb_account",
      fields: ["id", "qb_list_id", "full_name", "name", "account_type", "is_active"],
      pagination: { skip: 0, take: 5000 },
    });
    const byListId = new Map(existing.map((a: any) => [a.qb_list_id, a]));

    let created = 0;
    let updated = 0;
    const now = new Date();

    for (const acct of accounts) {
      const listId = acct.ListID;
      if (!listId) continue;

      const fullName = String(acct.FullName ?? acct.Name ?? "");
      const name = String(acct.Name ?? fullName.split(":").pop() ?? "");
      const parent = fullName.includes(":")
        ? fullName.split(":").slice(0, -1).join(":")
        : null;

      const payload = {
        qb_list_id: listId,
        full_name: fullName,
        name,
        account_type: String(acct.AccountType ?? ""),
        parent_full_name: parent,
        currency: acct.CurrencyRef?.FullName ?? null,
        is_active: acct.IsActive !== false,
        last_synced_at: now,
      };

      const prev = byListId.get(listId);
      if (!prev) {
        await catalog.createQbAccounts(payload);
        created++;
      } else {
        await catalog.updateQbAccounts({ id: prev.id, ...payload });
        updated++;
      }
    }

    logger.info(
      `[QB Catalog] Accounts sync: created=${created} updated=${updated} total=${accounts.length}`
    );

    return res.json({
      success: true,
      synced: accounts.length,
      created,
      updated,
      message: `Synced ${accounts.length} accounts (${created} new, ${updated} updated)`,
    });
  } catch (err: any) {
    logger.error(`[QB Catalog] Accounts sync failed: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
};
