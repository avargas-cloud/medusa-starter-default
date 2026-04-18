import { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { QUICKBOOKS_CATALOG_MODULE } from "../modules/quickbooks-catalog";

const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com";
const API_KEY = process.env.QB_API_KEY || "";
const MAX_ROWS_PER_TICK = 30;

type BridgeStatusResponse = {
  operation?: {
    status?: "queued" | "processing" | "completed" | "failed";
    result?: any;
    error?: string;
    listId?: string;
  };
};

const extractListId = (data: BridgeStatusResponse): string | null => {
  const op = data.operation;
  if (!op) return null;
  if (op.listId) return op.listId;
  const msgs =
    op.result?.QBXML?.QBXMLMsgsRs ?? op.result?.QBXMLMsgsRs ?? {};
  return msgs?.VendorAddRs?.VendorRet?.ListID ?? null;
};

export default async function qbVendorPoller(container: MedusaContainer) {
  const logger = container.resolve("logger");
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const catalog = container.resolve(QUICKBOOKS_CATALOG_MODULE) as any;

  const { data: pending } = await query.graph({
    entity: "qb_vendor",
    fields: ["id", "full_name", "qb_operation_id", "qb_list_id"],
    filters: { sync_status: "waiting" } as any,
    pagination: { skip: 0, take: MAX_ROWS_PER_TICK },
  });

  if (!pending || pending.length === 0) return;

  logger.info(`[qb-vendor-poller] processing ${pending.length} waiting vendors`);

  let resolved = 0;
  let failed = 0;

  for (const row of pending as any[]) {
    if (!row.qb_operation_id) {
      await catalog.updateQbVendors({
        id: row.id,
        sync_status: "error",
        last_error: "Missing qb_operation_id",
      });
      failed++;
      continue;
    }

    try {
      const res = await fetch(
        `${BRIDGE_URL}/api/sync/status/${row.qb_operation_id}`,
        {
          headers: {
            "x-api-key": API_KEY,
            "bypass-tunnel-reminder": "true",
          },
        }
      );
      if (!res.ok) throw new Error(`Bridge ${res.status}`);
      const data = (await res.json()) as BridgeStatusResponse;
      const status = data.operation?.status;

      if (status === "failed") {
        await catalog.updateQbVendors({
          id: row.id,
          sync_status: "error",
          last_error: data.operation?.error ?? "Bridge returned failed",
        });
        failed++;
        continue;
      }

      if (status !== "completed") continue;

      const listId = extractListId(data);
      if (!listId) {
        await catalog.updateQbVendors({
          id: row.id,
          sync_status: "error",
          last_error: "Completed but no ListID in response",
        });
        failed++;
        continue;
      }

      await catalog.updateQbVendors({
        id: row.id,
        qb_list_id: listId,
        sync_status: "synced",
        resolved_at: new Date(),
      });
      resolved++;
    } catch (err: any) {
      await catalog.updateQbVendors({
        id: row.id,
        last_error: err.message,
      });
      logger.warn(
        `[qb-vendor-poller] row ${row.full_name} fetch failed: ${err.message}`
      );
    }
  }

  if (resolved || failed) {
    logger.info(
      `[qb-vendor-poller] tick: resolved=${resolved} failed=${failed} total=${pending.length}`
    );
  }
}

export const config = {
  name: "qb-vendor-poller",
  schedule: "*/1 * * * *",
};
