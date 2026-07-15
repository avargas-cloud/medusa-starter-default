import { MedusaContainer } from "@medusajs/framework/types";
import { pollBridgeStatus } from "../lib/quickbooks/bridge-fetch";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { QUICKBOOKS_CATALOG_MODULE } from "../modules/quickbooks-catalog";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";
const MAX_ROWS_PER_TICK = 30;
// Use shared retry policy so vendor sync matches the rest of the QB pipeline
// (formerly used [2,4,8] which gave up ~5× faster — see B2 fix 2026-04-29).
import {
  STANDARD_BACKOFF_MINUTES,
  MAX_RETRIES,
  computeNextRetryDate,
} from "../lib/quickbooks/retry-config";
const BACKOFF_MINUTES = STANDARD_BACKOFF_MINUTES;

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
  const msgs = op.result?.QBXML?.QBXMLMsgsRs ?? op.result?.QBXMLMsgsRs ?? {};
  return msgs?.VendorAddRs?.VendorRet?.ListID ?? null;
};

const computeNextRetry = (attemptsSoFar: number): Date =>
  computeNextRetryDate(attemptsSoFar, BACKOFF_MINUTES);

type VendorRow = {
  id: string;
  full_name: string;
  qb_operation_id: string | null;
  qb_list_id: string | null;
  sync_status: string | null;
  retry_count: number | null;
  next_retry_at: Date | string | null;
};

/**
 * Find the pipeline row tracking this bridge op and update it.
 * Observability-only — failures here never break the vendor resolution.
 */
const syncPipelineRow = async (
  container: MedusaContainer,
  qbOperationId: string | null,
  patch: Record<string, unknown>
): Promise<void> => {
  if (!qbOperationId) return;
  try {
    const query = container.resolve(ContainerRegistrationKeys.QUERY);
    const catalog = container.resolve(QUICKBOOKS_CATALOG_MODULE) as any;
    const { data } = await query.graph({
      entity: "qb_vendor_pipeline",
      fields: ["id"],
      filters: { qb_operation_id: qbOperationId } as any,
      pagination: { skip: 0, take: 1 },
    });
    const row = (data as { id: string }[])[0];
    if (!row) return;
    await catalog.updateQbVendorPipelines({ id: row.id, ...patch });
  } catch {
    // swallow — pipeline is observability, not a gate
  }
};

/**
 * Mark a row as errored — advance retry_count and next_retry_at, or flip
 * to failed_permanent if the MAX_RETRIES cap is exceeded.
 */
const markError = async (
  catalog: any,
  row: VendorRow,
  message: string
): Promise<void> => {
  const attempts = (row.retry_count ?? 0) + 1;
  if (attempts >= MAX_RETRIES) {
    await catalog.updateQbVendors({
      id: row.id,
      sync_status: "failed_permanent",
      last_error: message,
      retry_count: attempts,
      next_retry_at: null,
    });
    return;
  }
  await catalog.updateQbVendors({
    id: row.id,
    sync_status: "error",
    last_error: message,
    retry_count: attempts,
    next_retry_at: computeNextRetry(attempts - 1),
  });
};

export default async function qbVendorPoller(container: MedusaContainer) {
  if (isScheduledJobsDisabled(container)) return;

  const logger = container.resolve("logger");
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const catalog = container.resolve(QUICKBOOKS_CATALOG_MODULE) as any;
  const pipelineSync = (opId: string | null, patch: Record<string, unknown>) =>
    syncPipelineRow(container, opId, patch);
  const now = new Date();

  // Pull waiting + (error AND due for retry). Done in two filter passes
  // because the graph query builder doesn't support OR across status + timestamp.
  const { data: waiting } = await query.graph({
    entity: "qb_vendor",
    fields: [
      "id",
      "full_name",
      "qb_operation_id",
      "qb_list_id",
      "sync_status",
      "retry_count",
      "next_retry_at",
    ],
    filters: { sync_status: "waiting" } as any,
    pagination: { skip: 0, take: MAX_ROWS_PER_TICK },
  });

  const { data: errored } = await query.graph({
    entity: "qb_vendor",
    fields: [
      "id",
      "full_name",
      "qb_operation_id",
      "qb_list_id",
      "sync_status",
      "retry_count",
      "next_retry_at",
    ],
    filters: { sync_status: "error" } as any,
    pagination: { skip: 0, take: MAX_ROWS_PER_TICK },
  });

  const dueForRetry = (errored as VendorRow[]).filter((row) => {
    if (!row.next_retry_at) return true;
    const due =
      row.next_retry_at instanceof Date
        ? row.next_retry_at
        : new Date(row.next_retry_at);
    return due.getTime() <= now.getTime();
  });

  const pending: VendorRow[] = [
    ...(waiting as VendorRow[]),
    ...dueForRetry,
  ].slice(0, MAX_ROWS_PER_TICK);

  if (pending.length === 0) return;

  logger.info(
    `[qb-vendor-poller] processing ${pending.length} rows ` +
      `(${(waiting as any[]).length} waiting + ${dueForRetry.length} due-for-retry)`
  );

  let resolved = 0;
  let failed = 0;

  for (const row of pending) {
    if (!row.qb_operation_id) {
      await markError(catalog, row, "Missing qb_operation_id");
      failed++;
      continue;
    }

    try {
      const polled = await pollBridgeStatus(row.qb_operation_id);
      if (polled.status === "expired") {
        // Bridge no longer knows the op. Mark error so retry cycle re-submits.
        await catalog.updateQbVendors({
          id: row.id,
          sync_status: "error",
          last_error: "Bridge operation expired (HTTP 404)",
          next_retry_at: new Date(Date.now() + 2 * 60_000),
        });
        continue;
      }
      const data = polled.data as BridgeStatusResponse;
      const status = data.operation?.status;

      if (status === "failed") {
        const errMsg = data.operation?.error ?? "Bridge returned failed";
        await markError(catalog, row, errMsg);
        await pipelineSync(row.qb_operation_id, {
          status: "error",
          last_error: errMsg,
        });
        failed++;
        continue;
      }

      if (status !== "completed") continue;

      const listId = extractListId(data);
      if (!listId) {
        await markError(catalog, row, "Completed but no ListID in response");
        await pipelineSync(row.qb_operation_id, {
          status: "error",
          last_error: "Completed but no ListID in response",
        });
        failed++;
        continue;
      }

      const resolvedAt = new Date();
      await catalog.updateQbVendors({
        id: row.id,
        qb_list_id: listId,
        sync_status: "synced",
        resolved_at: resolvedAt,
        last_error: null,
        next_retry_at: null,
      });
      await pipelineSync(row.qb_operation_id, {
        status: "synced",
        qb_list_id: listId,
        resolved_at: resolvedAt,
        last_error: null,
      });
      resolved++;
    } catch (err: any) {
      await markError(catalog, row, err.message);
      await pipelineSync(row.qb_operation_id, {
        status: "error",
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
