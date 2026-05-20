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
    m.includes("3200") ||
    m.includes("failed to build xml")
  );
};

/**
 * QB rejects an item Add when the Name is already taken (statusCode 3100,
 * "...the name ... is already in use"). This means the item exists in QB but
 * Medusa lost (or never received) its ListID. Rather than retrying the add
 * forever, we recover the existing ListID via an ItemQuery-by-name and convert
 * the operation into a mod. Message-based detection only — 3100 is overloaded
 * (it also covers transient "another update in progress" locks).
 */
const isNameInUseError = (msg: string | null | undefined): boolean => {
  if (!msg) return false;
  return msg.toLowerCase().includes("already in use");
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
    body: action === "add"
      ? JSON.stringify({ action, ...payload })
      : JSON.stringify({ action, data: payload }),
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
      "op_payload",
      "item_type",
      "retries",
    ],
    filters: { status: "waiting" },
    pagination: { skip: 0, take: MAX_ROWS_PER_TICK },
  });

  let resolved = 0;
  let failedToError = 0;
  let editSeqHydrated = 0;
  let reconciled = 0;

  if (pending && pending.length > 0) {
    logger.info(
      `[qb-item-pipeline-poller] phase A: polling ${pending.length} waiting rows`
    );

    for (const row of pending as any[]) {
      if (!row.qb_operation_id) {
        // No operationId means the row was manually retried (retry route clears it).
        // Set next_retry_at: null so Phase B picks it up on the very next tick.
        await catalog.updateQbItemPipelines({
          id: row.id,
          status: "error",
          last_error: "Missing qb_operation_id — awaiting Phase B resubmit",
          next_retry_at: null,
        });
        failedToError++;
        continue;
      }

      try {
        const data = await fetchBridgeStatus(row.qb_operation_id);
        const status = data.operation?.status;
        const isItemQuery = (row.op_payload as any)?.__iq_pending === true;
        const isReconcileQuery =
          (row.op_payload as any)?.__iq_reconcile === true;

        if (status === "expired" || status === "failed") {
          if (isItemQuery) {
            // ItemQuery didn't complete — restore error so Phase B retries with stale EditSequence.
            const origPayload = { ...(row.op_payload ?? {}) } as Record<string, unknown>;
            delete origPayload.__iq_pending;
            await catalog.updateQbItemPipelines({
              id: row.id,
              status: "error",
              last_error: `ItemQuery ${status}: ${data.operation?.error ?? "unknown"} — will retry with stale EditSequence`,
              qb_operation_id: null,
              op_payload: origPayload,
              next_retry_at: new Date(Date.now() + FIRST_ERROR_BACKOFF_MIN * 60_000),
            });
            failedToError++;
            continue;
          }

          if (isReconcileQuery) {
            // The reconcile ItemQuery didn't complete. Restore the add to error
            // but keep an "already in use" marker so Phase B re-queries instead
            // of resubmitting a doomed add. Count it as a retry so a perpetually
            // failing query can't loop forever.
            const origPayload = {
              ...(row.op_payload ?? {}),
            } as Record<string, unknown>;
            delete origPayload.__iq_reconcile;
            const newRetries = (row.retries ?? 0) + 1;
            const isExhausted = newRetries >= MAX_RETRIES;
            await catalog.updateQbItemPipelines({
              id: row.id,
              status: isExhausted ? "failed_permanent" : "error",
              last_error: `Reconcile ItemQuery ${status} (item name already in use) — ${data.operation?.error ?? "unknown"}`,
              qb_operation_id: null,
              op_payload: origPayload,
              retries: newRetries,
              next_retry_at: isExhausted
                ? null
                : new Date(Date.now() + FIRST_ERROR_BACKOFF_MIN * 60_000),
              failed_at: isExhausted ? new Date() : null,
            });
            failedToError++;
            continue;
          }

          if (status === "expired") {
            await catalog.updateQbItemPipelines({
              id: row.id,
              status: "error",
              last_error: data.operation?.error ?? "Bridge operation expired",
              qb_operation_id: null,
              next_retry_at: new Date(Date.now() + 2 * 60_000),
            });
            continue;
          }

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

        // ItemQuery completed — extract fresh EditSequence and resubmit the original mod.
        if (isItemQuery) {
          const freshSeq = extractEditSequence(data) ?? (data.operation as any)?.editSequence ?? null;
          const origPayload = { ...(row.op_payload ?? {}) } as Record<string, unknown>;
          delete origPayload.__iq_pending;

          if (!freshSeq) {
            await catalog.updateQbItemPipelines({
              id: row.id,
              status: "error",
              last_error: "ItemQuery completed but returned no EditSequence — will retry with stale",
              qb_operation_id: null,
              op_payload: origPayload,
              next_retry_at: new Date(Date.now() + FIRST_ERROR_BACKOFF_MIN * 60_000),
            });
            failedToError++;
            continue;
          }

          origPayload.EditSequence = freshSeq;
          await knex.raw(
            `UPDATE product_variant
               SET metadata = COALESCE(metadata, '{}'::jsonb)
                 || jsonb_build_object('qb_edit_sequence', ?::text)
             WHERE id = ?`,
            [freshSeq, row.variant_id]
          );

          try {
            const newOpId = await resubmitToBridge("mod", origPayload);
            await catalog.updateQbItemPipelines({
              id: row.id,
              status: "waiting",
              qb_operation_id: newOpId,
              op_payload: origPayload,
              last_error: null,
              next_retry_at: null,
            });
            editSeqHydrated++;
            logger.info(`[qb-item-pipeline-poller] ${row.sku}: EditSequence hydrated → mod resubmitted (op=${newOpId})`);
          } catch (resubErr: any) {
            await catalog.updateQbItemPipelines({
              id: row.id,
              status: "error",
              last_error: resubErr.message,
              qb_operation_id: null,
              op_payload: origPayload,
              next_retry_at: new Date(Date.now() + FIRST_ERROR_BACKOFF_MIN * 60_000),
            });
            failedToError++;
          }
          continue;
        }

        // Reconcile ItemQuery completed — the item already existed in QB. Recover
        // its ListID/EditSequence, link it back onto the variant, and resubmit the
        // user's edit as a mod (the add was a no-op once the name collided).
        if (isReconcileQuery) {
          const recoveredListId = extractListId(data);
          const recoveredSeq = extractEditSequence(data);
          const origPayload = {
            ...(row.op_payload ?? {}),
          } as Record<string, unknown>;
          delete origPayload.__iq_reconcile;

          if (!recoveredListId) {
            // QB has no item by that name after all — fall back to retrying the
            // add (no flag → Phase B resubmits as add).
            await catalog.updateQbItemPipelines({
              id: row.id,
              status: "error",
              last_error:
                "Reconcile query returned no ListID — item not found by name; will retry as add",
              qb_operation_id: null,
              op_payload: origPayload,
              next_retry_at: new Date(
                Date.now() + FIRST_ERROR_BACKOFF_MIN * 60_000
              ),
            });
            failedToError++;
            continue;
          }

          // Link the existing QB item onto the variant so it's no longer orphaned.
          await knex.raw(
            `UPDATE product_variant
               SET metadata = COALESCE(metadata, '{}'::jsonb)
                 || jsonb_strip_nulls(jsonb_build_object(
                      'quickbooks_id',    ?::text,
                      'qb_edit_sequence', ?::text
                    ))
             WHERE id = ?`,
            [recoveredListId, recoveredSeq, row.variant_id]
          );

          // Convert the add payload into a mod. The bridge ItemInventoryMod
          // builder honors Name/MPN/SalesDesc/SalesPrice/PurchaseDesc/
          // PurchaseCost/PrefVendorRef — all already present in the add payload.
          const modPayload: Record<string, unknown> = {
            ...origPayload,
            ListID: recoveredListId,
            EditSequence: recoveredSeq,
          };

          try {
            const newOpId = await resubmitToBridge("mod", modPayload);
            await catalog.updateQbItemPipelines({
              id: row.id,
              status: "waiting",
              op_action: "mod",
              qb_id: recoveredListId,
              qb_operation_id: newOpId,
              op_payload: modPayload,
              last_error: null,
              next_retry_at: null,
            });
            reconciled++;
            logger.info(
              `[qb-item-pipeline-poller] ${row.sku}: reconciled to existing QB item ${recoveredListId} → mod resubmitted (op=${newOpId})`
            );
          } catch (resubErr: any) {
            await catalog.updateQbItemPipelines({
              id: row.id,
              status: "error",
              op_action: "mod",
              qb_id: recoveredListId,
              last_error: resubErr.message,
              qb_operation_id: null,
              op_payload: modPayload,
              next_retry_at: new Date(
                Date.now() + FIRST_ERROR_BACKOFF_MIN * 60_000
              ),
            });
            failedToError++;
          }
          continue;
        }

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

  if (retryable && retryable.length > 0) {
    // Rows with no op_payload can't be auto-retried — update their error message
    // so the user knows to re-edit the item in inventory to enqueue a fresh op.
    for (const r of retryable as any[]) {
      if (!r.op_payload && !r.last_error?.includes("re-edit")) {
        await catalog.updateQbItemPipelines({
          id: r.id,
          last_error: "No payload — re-edit this item in inventory to queue a new sync",
        });
      }
    }

    const dueRows = (retryable as any[]).filter((r) => {
      if (!r.op_payload) return false;
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

      // Price/cost fallback: if payload is missing SalesPrice or PurchaseCost,
      // default to 0 so QB doesn't reject with error 3045.
      if (payload.SalesPrice === undefined || payload.SalesPrice === null) {
        payload.SalesPrice = 0;
        log("SalesPrice missing in payload — defaulted to 0");
      }
      if (payload.PurchaseCost === undefined || payload.PurchaseCost === null) {
        payload.PurchaseCost = 0;
      }

      // Name-conflict reconcile — an add failed because an item with that Name
      // already exists in QB (we have no ListID). Query QB by FullName so Phase A
      // can recover the ListID, link it to the variant, and resubmit as a mod.
      if (
        row.op_action === "add" &&
        !row.qb_id &&
        isNameInUseError(row.last_error)
      ) {
        const fullName = (payload.Name as string | undefined) ?? row.sku;
        if (fullName) {
          log("name already in use — querying QB by FullName to reconcile");
          try {
            const iqRes = await fetch(
              `${bridgeUrl()}/api/products?FullName=${encodeURIComponent(fullName)}`,
              {
                headers: {
                  "x-api-key": apiKey(),
                  "bypass-tunnel-reminder": "true",
                },
              }
            );
            if (iqRes.ok) {
              const iqJson = (await iqRes.json()) as { operationId?: string };
              if (iqJson.operationId) {
                await catalog.updateQbItemPipelines({
                  id: row.id,
                  status: "waiting",
                  qb_operation_id: iqJson.operationId,
                  op_payload: { ...payload, __iq_reconcile: true },
                  last_error: null,
                  next_retry_at: null,
                });
                log(
                  `reconcile ItemQuery queued (op=${iqJson.operationId}) — Phase A will link + resubmit as mod`
                );
                continue;
              }
            }
            log(`reconcile ItemQuery init failed (HTTP ${iqRes.status})`);
          } catch (iqErr: any) {
            log(`reconcile ItemQuery exception: ${iqErr.message}`);
          }
          // Couldn't queue the query — fall through to the generic resubmit,
          // which re-attempts the add and re-triggers reconcile next tick.
        }
      }

      // EditSequence async fallback — submit ItemQuery, let Phase A pick up the result
      // on the next poller tick (avoids blocking the cron while waiting for QB COM).
      if (
        row.op_action === "mod" &&
        row.qb_id &&
        isEditSequenceError(row.last_error)
      ) {
        log("EditSequence error detected — queueing async ItemQuery");
        try {
          const iqRes = await fetch(`${bridgeUrl()}/api/products/${row.qb_id}`, {
            headers: { "x-api-key": apiKey(), "bypass-tunnel-reminder": "true" },
          });
          if (iqRes.ok) {
            const iqJson = (await iqRes.json()) as { operationId?: string };
            if (iqJson.operationId) {
              await catalog.updateQbItemPipelines({
                id: row.id,
                status: "waiting",
                qb_operation_id: iqJson.operationId,
                op_payload: { ...payload, __iq_pending: true },
                last_error: null,
                next_retry_at: null,
              });
              log(`ItemQuery queued (op=${iqJson.operationId}) — Phase A will resubmit after EditSequence arrives`);
              continue;
            }
          }
          log(`ItemQuery init failed (HTTP ${iqRes.status}) — proceeding with stale EditSequence`);
        } catch (iqErr: any) {
          log(`ItemQuery exception: ${iqErr.message} — proceeding with stale EditSequence`);
        }
        // Falls through to resubmitToBridge with stale EditSequence
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

  if (
    resolved ||
    failedToError ||
    retried ||
    permaFailed ||
    editSeqHydrated ||
    reconciled
  ) {
    logger.info(
      `[qb-item-pipeline-poller] tick complete: ` +
        `resolved=${resolved} failed→error=${failedToError} ` +
        `retried=${retried} editSeq_hydrated=${editSeqHydrated} ` +
        `reconciled=${reconciled} failed_permanent=${permaFailed}`
    );
  }
}

export const config = {
  name: "qb-item-pipeline-poller",
  schedule: "*/1 * * * *",
};
