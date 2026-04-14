import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com";
const API_KEY = process.env.QB_API_KEY || "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD";

const HEADERS = {
  "x-api-key": API_KEY,
  "bypass-tunnel-reminder": "true",
  "Content-Type": "application/json",
};

async function pollOperation(
  operationId: string,
  maxAttempts = 20,
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

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const financeService = req.scope.resolve("finance") as any;
  const logger = req.scope.resolve("logger");

  try {
    // 1. Queue account query on bridge
    const initRes = await fetch(`${BRIDGE_URL}/api/accounts`, {
      headers: HEADERS,
    });
    const initData = await initRes.json();
    if (!initData.operationId)
      throw new Error("Bridge did not return operationId");

    // 2. Poll for result
    const result = await pollOperation(initData.operationId);

    // 3. Extract bank accounts from QBXML response
    const accountRets =
      result?.QBXML?.QBXMLMsgsRs?.AccountQueryRs?.AccountRet ?? [];
    const bankAccounts = accountRets.filter(
      (a: any) => a.AccountType === "Bank"
    );

    if (bankAccounts.length === 0) {
      return res.json({
        success: true,
        synced: 0,
        message: "No bank accounts found in QuickBooks",
      });
    }

    // 4. Get existing mappings to detect what needs upsert
    const query = req.scope.resolve("query");
    const { data: existing } = await query.graph({
      entity: "qb_bank_account",
      fields: ["id", "list_id", "name", "is_active"],
      pagination: { skip: 0, take: 200 },
    });

    const existingByListId = new Map(existing.map((a: any) => [a.list_id, a]));

    let created = 0;
    let updated = 0;

    for (const acct of bankAccounts) {
      const listId: string = acct.ListID;
      const name: string = acct.FullName ?? acct.Name;
      const existing = existingByListId.get(listId);

      if (!existing) {
        await financeService.createQbBankAccounts({
          name,
          list_id: listId,
          type: "Bank",
        });
        created++;
      } else if (existing.name !== name) {
        await financeService.updateQbBankAccounts({ id: existing.id, name });
        updated++;
      }
    }

    logger.info(
      `[QB Bank Accounts Sync] created=${created} updated=${updated} total=${bankAccounts.length}`
    );

    return res.json({
      success: true,
      synced: bankAccounts.length,
      created,
      updated,
      message: `Synced ${bankAccounts.length} bank accounts from QuickBooks (${created} new, ${updated} updated)`,
    });
  } catch (err: any) {
    logger.error(`[QB Bank Accounts Sync] Failed: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
};
