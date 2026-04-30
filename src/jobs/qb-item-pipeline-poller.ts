import { MedusaContainer } from "@medusajs/framework/types";
import { pollBridgeStatus } from "../lib/quickbooks/bridge-fetch";
import {
  markStaleRowsAsFailed,
  STANDARD_STALE_CONFIG,
} from "../lib/quickbooks/stale-row-cleanup";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { QUICKBOOKS_CATALOG_MODULE } from "../modules/quickbooks-catalog";
import { syncProductToMeiliSearchWorkflow } from "../workflows/sync-product-meilisearch";
import { updateInventoryIncrementalWorkflow } from "../workflows/update-inventory-incremental";

// Read at call time so tests can override QB_BRIDGE_URL after module load.
const bridgeUrl = (): string =>
  process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com";
const apiKey = (): string => process.env.QB_API_KEY || "";
const MAX_ROWS_PER_TICK = 50;
const MAX_RETRIES = 5;
/** Backoff per retry attempt, in minutes. Index = retry # (1-based). */
const RETRY_BACKOFF_MIN: readonly number[] = [2, 4, 10, 30, 60] as const;
/** Backoff used when a row first transitions waiting → error in Phase A. */
const FIRST_ERROR_BACKOFF_MIN = 2;
const backoffForRetry = (retryNum: number): number =>
  RETRY_BACKOFF_MIN[Math.min(retryNum, RETRY_BACKOFF_MIN.length - 1)] ??
  FIRST_ERROR_BACKOFF_MIN;
/** Bridge poll loop for the in-line ItemQuery during EditSequence fallback. */
const ITEM_QUERY_POLL_ATTEMPTS = 10;
const ITEM_QUERY_POLL_INTERVAL_MS = 2_000;

type BridgeStatusResponse = {
  operation?: {
    status?: "queued" | "processing" | "completed" | "failed" | "expired";
    result?: any;
    error?: string;
    txnId?: string;
    listId?: string;
    editSequence?: string;
    qbxmlResponse?: string;
  };
};

const fetchBridgeStatus = async (
  operationId: string
): Promise<BridgeStatusResponse> => {
  // 404 → synthetic "expired" status (centralized in bridge-fetch helper).
  // See bridge-fetch.ts for rationale (incident PO-1015/PO-1016, 2026-04-29).
  const _result = await pollBridgeStatus(operationId);
  if (_result.status === "expired") {
    return {
      operation: {
        status: "expired",
        error:
          "Bridge operation expired (HTTP 404). Op no longer in bridge queue.",
      },
    } as BridgeStatusResponse;
  }
  return _result.data as BridgeStatusResponse;
};

const extractListId = (data: BridgeStatusResponse): string | null => {
  const op = data.operation;
  if (!op) return null;
  if (op.listId) return op.listId;
  if (op.txnId) return op.txnId;
  const msgs = op.result?.QBXML?.QBXMLMsgsRs ?? op.result?.QBXMLMsgsRs ?? {};
  return (
    msgs?.ItemInventoryAddRs?.ItemInventoryRet?.ListID ??
    msgs?.ItemServiceAddRs?.ItemServiceRet?.ListID ??
    msgs?.ItemNonInventoryAddRs?.ItemNonInventoryRet?.ListID ??
    msgs?.ItemInventoryModRs?.ItemInventoryRet?.ListID ??
    msgs?.ItemServiceModRs?.ItemServiceRet?.ListID ??
    msgs?.ItemNonInventoryModRs?.ItemNonInventoryRet?.ListID ??
    null
  );
};

const extractEditSequence = (data: BridgeStatusResponse): string | null => {
  const op = data.operation;
  if (op?.editSequence) return op.editSequence;
  const msgs = op?.result?.QBXML?.QBXMLMsgsRs ?? op?.result?.QBXMLMsgsRs ?? {};
  return (
    msgs?.ItemInventoryAddRs?.ItemInventoryRet?.EditSequence ??
    msgs?.ItemServiceAddRs?.ItemServiceRet?.EditSequence ??
    msgs?.ItemNonInventoryAddRs?.ItemNonInventoryRet?.EditSequence ??
    msgs?.ItemInventoryModRs?.ItemInventoryRet?.EditSequence ??
    msgs?.ItemServiceModRs?.ItemServiceRet?.EditSequence ??
    msgs?.ItemNonInventoryModRs?.ItemNonInventoryRet?.EditSequence ??
    null
  );
};

/** Heuristic: detect bridge errors that indicate a stale or missing EditSequence. */
const isEditSequenceError = (msg: string | null | undefined): boolean => {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return (
    m.includes("editsequence") ||
    m.includes("3170") ||
    m.includes("3180") ||
    m.includes("failed to build xml")
  );
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Issues an ItemQuery to the bridge for a single ListID and returns the latest
 * EditSequence. Polls the operation result inline (short loop). Returns null
 * when the bridge times out, errors, or doesn't include an EditSequence.
 */
const fetchEditSequenceFromBridge = async (
  listId: string,
  log: (msg: string) => void
): Promise<string | null> => {
  try {
    const initRes = await fetch(`${bridgeUrl()}/api/products/${listId}`, {
      headers: { "x-api-key": apiKey(), "bypass-tunnel-reminder": "true" },
    });
    if (!initRes.ok) {
      log(`ItemQuery init failed: HTTP ${initRes.status}`);
      return null;
    }
    const initJson = (await initRes.json()) as { operationId?: string };
    const opId = initJson.operationId;
    if (!opId) return null;

    for (let i = 1; i <= ITEM_QUERY_POLL_ATTEMPTS; i++) {
      await sleep(ITEM_QUERY_POLL_INTERVAL_MS);
      const status = await fetchBridgeStatus(opId).catch(() => null);
      if (!status?.operation) continue;
      if (status.operation.status === "failed" || status.operation.status === "expired") {
        log(`ItemQuery operation ${status.operation.status}: ${status.operation.error ?? "?"}`);
        return null;
      }
      if (status.operation.status !== "completed") continue;
      const seq = extractEditSequence(status);
      if (seq) return seq;
      // Try ItemQueryRs explicitly (response shape differs from Add/Mod)
      const msgs =
        status.operation.result?.QBXML?.QBXMLMsgsRs ??
        status.operation.result?.QBXMLMsgsRs ??
        {};
      return (
        msgs?.ItemQueryRs?.ItemInventoryRet?.EditSequence ??
        msgs?.ItemQueryRs?.ItemServiceRet?.EditSequence ??
        msgs?.ItemQueryRs?.ItemNonInventoryRet?.EditSequence ??
        null
      );
    }
    return null;
  } catch (e: any) {
    log(`ItemQuery exception: ${e.message}`);
    return null;
  }
};

/**
 * Re-emits the original add/mod operation to the bridge using op_action +
 * op_payload from the pipeline row. Returns the new operationId on success
 * or throws on bridge failure.
 */
const resubmitToBridge = async (
  action: "add" | "mod",
  payload: Record<string, unknown>
): Promise<string> => {
  const url =
    action === "add"
      ? `${bridgeUrl()}/api/products`
      : `${bridgeUrl()}/api/products/${(payload as any).ListID}`;
  const method = action === "add" ? "POST" : "PUT";

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey(),
      "bypass-tunnel-reminder": "true",
    },
    body: JSON.stringify({ action, data: payload }),
  });
  if (!res.ok) {
    throw new Error(`Bridge ${res.status} — ${await res.text()}`);
  }
  const json = (await res.json()) as { operationId?: string; error?: string };
  if (json.error || !json.operationId) {
    throw new Error(json.error ?? "Bridge returned no operationId");
  }
  return json.operationId;
};

export default async function qbItemPipelinePoller(container: MedusaContainer) {
  const logger = container.resolve("logger");
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const catalog = container.resolve(QUICKBOOKS_CATALOG_MODULE) as any;
  const knex = (container as any).resolve("__pg_connection__");

  // Safety net: demote rows stuck in waiting/submitted past their thresholds.
  await markStaleRowsAsFailed(
    knex,
    "qb_item_pipeline",
    STANDARD_STALE_CONFIG,
    { warn: (m: string) => (logger as any).warn?.(`[qb-item-pipeline] ${m}`) }
  );

  // ── Phase A: Poll waiting rows for completion ────────────────────────────
  const { data: pending } = await query.graph({
    entity: "qb_item_pipeline",
    fields: [
      "id",
      "variant_id",
      "sku",
      "qb_operation_id",
      "qb_id",
      "op_action",
      "item_type",
      "retries",
    ],
    filters: { status: "waiting" },
    pagination: { skip: 0, take: MAX_ROWS_PER_TICK },
  });

  let resolved = 0;
  let failedToError = 0;

  if (pending && pending.length > 0) {
    logger.info(
      `[qb-item-pipeline-poller] phase A: polling ${pending.length} waiting rows`
    );

    for (const row of pending as any[]) {
      if (!row.qb_operation_id) {
        await catalog.updateQbItemPipelines({
          id: row.id,
          status: "error",
          last_error: "Missing qb_operation_id",
          next_retry_at: new Date(
            Date.now() + FIRST_ERROR_BACKOFF_MIN * 60_000
          ),
        });
        failedToError++;
        continue;
      }

      try {
        const data = await fetchBridgeStatus(row.qb_operation_id);
        const status = data.operation?.status;

        if (status === "expired") {
          await catalog.updateQbItemPipelines({
            id: row.id,
            status: "error",
            last_error:
              data.operation?.error ?? "Bridge operation expired",
            qb_operation_id: null,
            next_retry_at: new Date(Date.now() + 2 * 60_000),
          });
          continue;
        }

        if (status === "failed") {
          const errorMsg = data.operation?.error ?? "Bridge returned failed";
          await catalog.updateQbItemPipelines({
            id: row.id,
            status: "error",
            last_error: errorMsg,
            // Don't increment retries here — we haven't re-emitted yet, the
            // failure happened on the original op. Phase B will retry it.
            next_retry_at: new Date(
              Date.now() + FIRST_ERROR_BACKOFF_MIN * 60_000
            ),
          });
          failedToError++;
          continue;
        }

        if (status !== "completed") continue;

        const listId = extractListId(data);
        const editSequence = extractEditSequence(data);

        if (!listId && row.op_action === "add") {
          await catalog.updateQbItemPipelines({
            id: row.id,
            status: "error",
            last_error: "Completed but no ListID in response",
            next_retry_at: new Date(
              Date.now() + FIRST_ERROR_BACKOFF_MIN * 60_000
            ),
          });
          failedToError++;
          continue;
        }

        // Persist returned QB metadata back onto the variant so future Mods
        // have a fresh EditSequence available.
        if (listId || editSequence) {
          await knex.raw(
            `UPDATE product_variant
               SET metadata = COALESCE(metadata, '{}'::jsonb)
                 || jsonb_strip_nulls(jsonb_build_object(
                      'quickbooks_id',     ?::text,
                      'qb_edit_sequence',  ?::text
                    ))
             WHERE id = ?`,
            [listId, editSequence, row.variant_id]
          );

          // Raw UPDATE bypasses Medusa's event bus. Re-sync Meili explicitly so
          // POS search reflects the new quickbooks_id (and picks up the product
          // for the first time if it was just created via POS Product V2).
          try {
            const { data: variantRow } = await query.graph({
              entity: "product_variant",
              fields: ["product_id"],
              filters: { id: row.variant_id } as any,
            });
            const productId = (variantRow as any[])?.[0]?.product_id;
            if (productId) {
              await syncProductToMeiliSearchWorkflow(container).run({
                input: { productId },
                throwOnError: false,
              });
              await updateInventoryIncrementalWorkflow(container).run({
                input: { productId },
                throwOnError: false,
              });
            }
          } catch (meiliErr: any) {
            logger.warn(
              `[qb-item-pipeline-poller] Meili re-sync failed for variant ${row.variant_id}: ${meiliErr.message}`
            );
          }
        }

        await catalog.updateQbItemPipelines({
          id: row.id,
          status: "synced",
          qb_list_id: listId ?? row.qb_id,
          qb_edit_sequence: editSequence,
          last_error: null,
          next_retry_at: null,
          resolved_at: new Date(),
        });
        resolved++;
      } catch (err: any) {
        await catalog.updateQbItemPipelines({
          id: row.id,
          status: "error",
          last_error: err.message,
          next_retry_at: new Date(
            Date.now() + FIRST_ERROR_BACKOFF_MIN * 60_000
          ),
        });
        logger.warn(
          `[qb-item-pipeline-poller] row ${row.id} (${row.sku}) phase A fetch failed: ${err.message}`
        );
        failedToError++;
      }
    }
  }

  // ── Phase B: Auto-retry error rows whose backoff window expired ──────────
  const now = new Date();
  const { data: retryable } = await query.graph({
    entity: "qb_item_pipeline",
    fields: [
      "id",
      "variant_id",
      "sku",
      "op_action",
      "op_payload",
      "qb_id",
      "item_type",
      "retries",
      "last_error",
      "next_retry_at",
    ],
    filters: { status: "error" },
    pagination: { skip: 0, take: MAX_ROWS_PER_TICK },
  });

  let retried = 0;
  let permaFailed = 0;
  let editSeqHydrated = 0;

  if (retryable && retryable.length > 0) {
    const dueRows = (retryable as any[]).filter((r) => {
      // Skip rows missing op_payload (legacy rows from before F1 — they have no
      // way to retry without a payload). Mark them failed_permanent on first
      // touch so they show up in the digest and stop blocking the worker.
      if (!r.op_payload) return false;
      // Skip rows that haven't reached their next_retry_at yet. Rows with a
      // null next_retry_at (manual Retry just reset them) are also due.
      if (r.next_retry_at && new Date(r.next_retry_at) > now) return false;
      return true;
    });

    if (dueRows.length > 0) {
      logger.info(
        `[qb-item-pipeline-poller] phase B: ${dueRows.length} error rows due for retry`
      );
    }

    for (const row of dueRows) {
      const log = (msg: string) =>
        logger.info(`[qb-item-pipeline-poller] ${row.sku}: ${msg}`);

      const payload: Record<string, unknown> = { ...(row.op_payload ?? {}) };

      // EditSequence auto-fallback (free retry, doesn't consume counter).
      if (
        row.op_action === "mod" &&
        row.qb_id &&
        isEditSequenceError(row.last_error)
      ) {
        log(
          "EditSequence error detected — fetching fresh sequence via ItemQuery"
        );
        const freshSeq = await fetchEditSequenceFromBridge(row.qb_id, log);
        if (freshSeq) {
          payload.EditSequence = freshSeq;
          // Persist on the variant too so future Mods don't re-hit this path.
          await knex.raw(
            `UPDATE product_variant
               SET metadata = COALESCE(metadata, '{}'::jsonb)
                 || jsonb_build_object('qb_edit_sequence', ?::text)
             WHERE id = ?`,
            [freshSeq, row.variant_id]
          );
          editSeqHydrated++;
          log(`EditSequence hydrated to ${freshSeq}`);
        } else {
          log("EditSequence fallback failed — proceeding with stale sequence");
        }
      }

      try {
        const operationId = await resubmitToBridge(row.op_action, payload);
        await catalog.updateQbItemPipelines({
          id: row.id,
          status: "waiting",
          qb_operation_id: operationId,
          op_payload: payload,
          last_error: null,
          next_retry_at: null,
          // Do NOT increment retries on a successful re-submit — only count
          // retries when the resubmit *itself* fails. The waiting row will be
          // resolved/re-errored by Phase A on the next tick.
        });
        retried++;
        log(`re-submitted (op=${operationId})`);
      } catch (err: any) {
        const newRetries = (row.retries ?? 0) + 1;
        const isExhausted = newRetries >= MAX_RETRIES;
        const backoffMin = backoffForRetry(newRetries);
        await catalog.updateQbItemPipelines({
          id: row.id,
          status: isExhausted ? "failed_permanent" : "error",
          last_error: err.message,
          retries: newRetries,
          next_retry_at: isExhausted
            ? null
            : new Date(Date.now() + backoffMin * 60_000),
          failed_at: isExhausted ? new Date() : null,
        });
        if (isExhausted) {
          permaFailed++;
          logger.error(
            `[qb-item-pipeline-poller] ${row.sku} → failed_permanent after ${MAX_RETRIES} retries: ${err.message}`
          );
        } else {
          log(`retry ${newRetries}/${MAX_RETRIES} failed: ${err.message}`);
        }
      }
    }
  }

  if (resolved || failedToError || retried || permaFailed || editSeqHydrated) {
    logger.info(
      `[qb-item-pipeline-poller] tick complete: ` +
        `resolved=${resolved} failed→error=${failedToError} ` +
        `retried=${retried} editSeq_hydrated=${editSeqHydrated} ` +
        `failed_permanent=${permaFailed}`
    );
  }
}

export const config = {
  name: "qb-item-pipeline-poller",
  schedule: "*/1 * * * *",
};
