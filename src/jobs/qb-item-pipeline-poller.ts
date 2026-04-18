import { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { QUICKBOOKS_CATALOG_MODULE } from "../modules/quickbooks-catalog";

const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com";
const API_KEY = process.env.QB_API_KEY || "";
const MAX_ROWS_PER_TICK = 50;

type BridgeStatusResponse = {
  operation?: {
    status?: "queued" | "processing" | "completed" | "failed";
    result?: any;
    error?: string;
    txnId?: string;
    listId?: string;
    editSequence?: string;
  };
};

const fetchBridgeStatus = async (
  operationId: string
): Promise<BridgeStatusResponse> => {
  const res = await fetch(`${BRIDGE_URL}/api/sync/status/${operationId}`, {
    headers: {
      "x-api-key": API_KEY,
      "bypass-tunnel-reminder": "true",
    },
  });
  if (!res.ok) {
    throw new Error(`Bridge ${res.status}`);
  }
  return (await res.json()) as BridgeStatusResponse;
};

const extractListId = (data: BridgeStatusResponse): string | null => {
  const op = data.operation;
  if (!op) return null;
  if (op.listId) return op.listId;
  if (op.txnId) return op.txnId;
  const msgs =
    op.result?.QBXML?.QBXMLMsgsRs ?? op.result?.QBXMLMsgsRs ?? {};
  return (
    msgs?.ItemInventoryAddRs?.ItemInventoryRet?.ListID ??
    msgs?.ItemServiceAddRs?.ItemServiceRet?.ListID ??
    msgs?.ItemNonInventoryAddRs?.ItemNonInventoryRet?.ListID ??
    null
  );
};

const extractEditSequence = (data: BridgeStatusResponse): string | null => {
  const op = data.operation;
  if (op?.editSequence) return op.editSequence;
  const msgs =
    op?.result?.QBXML?.QBXMLMsgsRs ?? op?.result?.QBXMLMsgsRs ?? {};
  return (
    msgs?.ItemInventoryAddRs?.ItemInventoryRet?.EditSequence ??
    msgs?.ItemServiceAddRs?.ItemServiceRet?.EditSequence ??
    msgs?.ItemNonInventoryAddRs?.ItemNonInventoryRet?.EditSequence ??
    null
  );
};

export default async function qbItemPipelinePoller(container: MedusaContainer) {
  const logger = container.resolve("logger");
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const catalog = container.resolve(QUICKBOOKS_CATALOG_MODULE) as any;
  const knex = (container as any).resolve("__pg_connection__");

  const { data: pending } = await query.graph({
    entity: "qb_item_pipeline",
    fields: [
      "id",
      "variant_id",
      "sku",
      "qb_operation_id",
      "item_type",
      "retries",
    ],
    filters: { status: "waiting" },
    pagination: { skip: 0, take: MAX_ROWS_PER_TICK },
  });

  if (!pending || pending.length === 0) return;

  logger.info(
    `[qb-item-pipeline-poller] processing ${pending.length} waiting rows`
  );

  let resolved = 0;
  let failed = 0;

  for (const row of pending as any[]) {
    if (!row.qb_operation_id) {
      await catalog.updateQbItemPipelines({
        id: row.id,
        status: "error",
        last_error: "Missing qb_operation_id",
      });
      failed++;
      continue;
    }

    try {
      const data = await fetchBridgeStatus(row.qb_operation_id);
      const status = data.operation?.status;

      if (status === "failed") {
        await catalog.updateQbItemPipelines({
          id: row.id,
          status: "error",
          last_error: data.operation?.error ?? "Bridge returned failed",
          retries: (row.retries ?? 0) + 1,
        });
        failed++;
        continue;
      }

      if (status !== "completed") continue;

      const listId = extractListId(data);
      const editSequence = extractEditSequence(data);

      if (!listId) {
        await catalog.updateQbItemPipelines({
          id: row.id,
          status: "error",
          last_error: "Completed but no ListID in response",
          retries: (row.retries ?? 0) + 1,
        });
        failed++;
        continue;
      }

      await knex.raw(
        `UPDATE product_variant
           SET metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object('quickbooks_id', ?::text, 'qb_edit_sequence', ?::text)
         WHERE id = ?`,
        [listId, editSequence, row.variant_id]
      );

      await catalog.updateQbItemPipelines({
        id: row.id,
        status: "synced",
        qb_list_id: listId,
        qb_edit_sequence: editSequence,
        resolved_at: new Date(),
      });
      resolved++;
    } catch (err: any) {
      await catalog.updateQbItemPipelines({
        id: row.id,
        last_error: err.message,
        retries: (row.retries ?? 0) + 1,
      });
      logger.warn(
        `[qb-item-pipeline-poller] row ${row.id} (${row.sku}) fetch failed: ${err.message}`
      );
    }
  }

  if (resolved || failed) {
    logger.info(
      `[qb-item-pipeline-poller] tick complete: resolved=${resolved} failed=${failed} total=${pending.length}`
    );
  }
}

export const config = {
  name: "qb-item-pipeline-poller",
  schedule: "*/1 * * * *",
};
