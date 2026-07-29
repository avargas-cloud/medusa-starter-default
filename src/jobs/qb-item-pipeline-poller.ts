import { MedusaContainer } from "@medusajs/framework/types";
import { pollBridgeStatus } from "../lib/quickbooks/bridge-fetch";
import {
  markStaleRowsAsFailed,
  STANDARD_STALE_CONFIG,
} from "../lib/quickbooks/stale-row-cleanup";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { QUICKBOOKS_CATALOG_MODULE } from "../modules/quickbooks-catalog";
import { syncProductToMeiliSearchWorkflow } from "../workflows/sync-product-meilisearch";
import { syncInventoryItemToMeiliSearchWorkflow } from "../workflows/sync-inventory-item-meilisearch";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";
import { requireBridgeUrl } from "../lib/quickbooks/bridge-url";
// Read at call time so tests can override QB_BRIDGE_URL after module load.
const bridgeUrl = (): string =>
  requireBridgeUrl();
const apiKey = (): string => process.env.QB_API_KEY || "";
const MAX_ROWS_PER_TICK = 50;
const MAX_RETRIES = 5;
/**
 * Hard cap on total bridge dispatches (add/mod) for a single row before it is
 * demoted to failed_permanent. Unlike MAX_RETRIES — which only counts resubmit
 * *failures* — this counts EVERY dispatch. It is the backstop for a row that
 * keeps re-submitting successfully each tick but never reaches `synced`
 * (retries stays 0, updated_at stays fresh, so no other guard fires). This is
 * exactly how seq 120 / LUX-LR24950 looped for 5+ hours (2026-05-29).
 */
const MAX_SUBMITS = 8;
/** A non-terminal row older than this with no progress is surfaced as stuck. */
const STUCK_ALERT_HOURS = 2;
/** Backoff per retry attempt, in minutes. Index = retry # (1-based). */
const RETRY_BACKOFF_MIN: readonly number[] = [2, 4, 10, 30, 60] as const;
/** Backoff used when a row first transitions waiting → error in Phase A. */
const FIRST_ERROR_BACKOFF_MIN = 2;
const backoffForRetry = (retryNum: number): number =>
  RETRY_BACKOFF_MIN[Math.min(retryNum, RETRY_BACKOFF_MIN.length - 1)] ??
  FIRST_ERROR_BACKOFF_MIN;

/**
 * Recovery state for a row. Lives in the SCALAR `recovery_mode` column, NOT in
 * op_payload — a scalar update replaces cleanly, whereas the old JSONB markers
 * (__iq_pending/__iq_reconcile) could never be removed because the service
 * deep-merges jsonb (a deleted key is re-hydrated from the stored value). That
 * made the marker immortal and the recovery branch re-ran forever (seq 120).
 *   none            — normal add/mod, no recovery in flight
 *   editseq_query   — a mod hit a stale EditSequence; an ItemQuery is refreshing it
 *   reconcile_query — an add hit name-in-use; an ItemQuery is recovering the ListID
 */
type RecoveryMode = "none" | "editseq_query" | "reconcile_query";

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

// Generic fallback: walk any QBXML `*Rs` → first `*Ret` → return the named field.
// The explicit Add/Mod lookups below don't enumerate `ItemQueryRs.Item*Ret`, which
// is the shape returned by the EditSequence-recovery / reconcile ItemQuery. Mirrors
// the bridge's own extractQBIds walk so a query response yields ListID/EditSequence.
const walkRetField = (
  msgs: Record<string, unknown>,
  field: string
): string | null => {
  for (const rsKey of Object.keys(msgs)) {
    if (!rsKey.endsWith("Rs")) continue;
    const rs = msgs[rsKey];
    if (!rs || typeof rs !== "object") continue;
    for (const [retKey, retVal] of Object.entries(
      rs as Record<string, unknown>
    )) {
      if (!retKey.endsWith("Ret")) continue;
      const ret = Array.isArray(retVal) ? retVal[0] : retVal;
      const value = (ret as Record<string, unknown> | null | undefined)?.[
        field
      ];
      if (typeof value === "string" && value) return value;
    }
  }
  return null;
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
    walkRetField(msgs as Record<string, unknown>, "ListID")
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
    walkRetField(msgs as Record<string, unknown>, "EditSequence")
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
 * Extract a structured 4-digit QB/bridge status code (3170, 3200, 3100, …) from
 * a free-text error for triage/filtering. Returns null when none is present.
 */
const parseQbErrorCode = (msg: string | null | undefined): string | null => {
  if (!msg) return null;
  const m = msg.match(/\b(\d{4})\b/);
  return m?.[1] ?? null;
};

/**
 * Legacy JSON markers. Older rows (pre-2026-05-29) carried __iq_pending /
 * __iq_reconcile inside op_payload; recovery state now lives in the scalar
 * `recovery_mode` column (migration backfills it). We still strip these keys
 * from any payload we send to the bridge so a legacy row doesn't ship junk —
 * but recovery is driven ONLY by recovery_mode, never by these keys.
 */
const LEGACY_IQ_MARKERS = ["__iq_pending", "__iq_reconcile"] as const;
const cleanPayload = (
  payload: Record<string, unknown> | null | undefined
): Record<string, unknown> => {
  const clean = { ...(payload ?? {}) };
  for (const marker of LEGACY_IQ_MARKERS) delete clean[marker];
  return clean;
};

/**
 * Guardrail against the seq-120 price-zeroing failure mode, applied ONLY on
 * RECOVERY-path mod resubmits (reconcile add→mod, EditSequence re-hydration).
 *
 * The contamination vector is specific: an add with a missing price gets a
 * fabricated `SalesPrice: 0` (the add-only fallback — QB requires a price on
 * create), and if that add later converts to a mod via recovery, the fabricated
 * 0 would OVERWRITE QB's real price. The bridge omits undefined SalesPrice/
 * PurchaseCost on a mod (QB keeps its value), so dropping the explicit 0 here is
 * the safe default for a recovered payload of unknown provenance.
 *
 * We deliberately do NOT apply this to Phase B's normal mod retries: there a `0`
 * came straight from the row's own payload (a real POS edit), so a legitimately
 * free / zero-cost item must still be pushable to QB.
 */
const dropFabricatedZeroPrices = (
  payload: Record<string, unknown>
): Record<string, unknown> => {
  const p = { ...payload };
  if (p.SalesPrice === 0) delete p.SalesPrice;
  if (p.PurchaseCost === 0) delete p.PurchaseCost;
  return p;
};

/**
 * Re-emits the original add/mod operation to the bridge using op_action +
 * op_payload from the pipeline row. Returns the new operationId on success
 * or throws on bridge failure. The payload is sent verbatim — callers on a
 * recovery path pre-clean it via dropFabricatedZeroPrices().
 */
// QB QBXML PRICETYPE accepts at most 5 decimal places. Cost/price values coming
// from AVCO landed-cost math carry float noise (e.g. 27.648000000000003), which
// QB rejects with error 3045 ("invalid amount"). Round to a QB-valid precision.
const QB_PRICE_FIELDS = ["PurchaseCost", "SalesPrice"] as const;
const roundQbPriceFields = (
  payload: Record<string, unknown>
): Record<string, unknown> => {
  const p = { ...payload };
  for (const field of QB_PRICE_FIELDS) {
    const value = p[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      p[field] = Math.round(value * 1e5) / 1e5;
    }
  }
  return p;
};

const resubmitToBridge = async (
  action: "add" | "mod",
  rawPayload: Record<string, unknown>
): Promise<string> => {
  // Single chokepoint for every add/mod dispatch — guarantees QB never sees
  // float-noise amounts regardless of which caller built the payload.
  const payload = roundQbPriceFields(rawPayload);
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
  if (isScheduledJobsDisabled(container)) return;

  const logger = container.resolve("logger");
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const catalog = container.resolve(QUICKBOOKS_CATALOG_MODULE) as any;
  const knex = (container as any).resolve("__pg_connection__");

  // Safety net: demote rows stuck in waiting/submitted past their thresholds.
  // Keys off updated_at — catches IDLE rows. Active loops (updated_at stays
  // fresh) are caught by the MAX_SUBMITS cap below, not here.
  await markStaleRowsAsFailed(
    knex,
    "qb_item_pipeline",
    STANDARD_STALE_CONFIG,
    { warn: (m: string) => (logger as any).warn?.(`[qb-item-pipeline] ${m}`) }
  );

  /** Demote a row that has dispatched too many times without completing. */
  const overSubmitCap = (row: { submit_count?: number | null }): boolean =>
    (row.submit_count ?? 0) >= MAX_SUBMITS;

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
      "recovery_mode",
      "submit_count",
    ],
    filters: { status: "waiting" },
    pagination: { skip: 0, take: MAX_ROWS_PER_TICK },
  });

  let resolved = 0;
  let failedToError = 0;
  let editSeqHydrated = 0;
  let reconciled = 0;
  let loopCapped = 0;

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
        const recoveryMode = (row.recovery_mode ?? "none") as RecoveryMode;
        const isItemQuery = recoveryMode === "editseq_query";
        const isReconcileQuery = recoveryMode === "reconcile_query";

        if (status === "expired" || status === "failed") {
          const errorMsg =
            data.operation?.error ??
            (status === "expired"
              ? "Bridge operation expired"
              : "Bridge returned failed");
          const errorCode = parseQbErrorCode(errorMsg);

          if (isItemQuery) {
            // ItemQuery didn't complete — restore error so Phase B retries with stale EditSequence.
            await catalog.updateQbItemPipelines({
              id: row.id,
              status: "error",
              last_error: `ItemQuery ${status}: ${errorMsg} — will retry with stale EditSequence`,
              last_error_code: errorCode,
              qb_operation_id: null,
              recovery_mode: "none",
              op_payload: cleanPayload(row.op_payload),
              next_retry_at: new Date(Date.now() + FIRST_ERROR_BACKOFF_MIN * 60_000),
            });
            failedToError++;
            continue;
          }

          if (isReconcileQuery) {
            // The reconcile ItemQuery didn't complete. Restore the add to error
            // but count it as a retry so a perpetually failing query can't loop
            // forever; clear recovery_mode so Phase B re-queries cleanly.
            const newRetries = (row.retries ?? 0) + 1;
            const isExhausted = newRetries >= MAX_RETRIES;
            await catalog.updateQbItemPipelines({
              id: row.id,
              status: isExhausted ? "failed_permanent" : "error",
              last_error: `Reconcile ItemQuery ${status} (item name already in use) — ${errorMsg}`,
              last_error_code: errorCode,
              qb_operation_id: null,
              recovery_mode: "none",
              op_payload: cleanPayload(row.op_payload),
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
              last_error: errorMsg,
              last_error_code: errorCode,
              qb_operation_id: null,
              next_retry_at: new Date(Date.now() + 2 * 60_000),
            });
            continue;
          }

          await catalog.updateQbItemPipelines({
            id: row.id,
            status: "error",
            last_error: errorMsg,
            last_error_code: errorCode,
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

        // Backstop: a completed op on a row that has already dispatched too many
        // times means we're in a resubmit loop that never closes. Demote instead
        // of resubmitting yet again. (This is the guard seq 120 lacked.)
        if ((isItemQuery || isReconcileQuery) && overSubmitCap(row)) {
          await catalog.updateQbItemPipelines({
            id: row.id,
            status: "failed_permanent",
            last_error: `Submit cap reached (${row.submit_count}/${MAX_SUBMITS}) during ${recoveryMode} recovery — possible resubmit loop, demoted for manual review`,
            qb_operation_id: null,
            recovery_mode: "none",
            op_payload: cleanPayload(row.op_payload),
            next_retry_at: null,
            failed_at: new Date(),
          });
          logger.error(
            `[qb-item-pipeline-poller] ${row.sku} → failed_permanent: submit cap ${row.submit_count}/${MAX_SUBMITS} (${recoveryMode} loop)`
          );
          loopCapped++;
          continue;
        }

        // ItemQuery completed — extract fresh EditSequence and resubmit the original mod.
        if (isItemQuery) {
          const freshSeq = extractEditSequence(data) ?? (data.operation as any)?.editSequence ?? null;
          const origPayload = cleanPayload(row.op_payload);

          if (!freshSeq) {
            // The query completed but carried no EditSequence (e.g. item not
            // found, or a field we can't parse). Count this as a retry so an
            // unrecoverable item eventually lands in failed_permanent instead
            // of re-querying every backoff window forever.
            const newRetries = (row.retries ?? 0) + 1;
            const isExhausted = newRetries >= MAX_RETRIES;
            await catalog.updateQbItemPipelines({
              id: row.id,
              status: isExhausted ? "failed_permanent" : "error",
              last_error: "ItemQuery completed but returned no EditSequence — will retry with stale",
              qb_operation_id: null,
              recovery_mode: "none",
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

          origPayload.EditSequence = freshSeq;
          // Recovery path → drop any fabricated 0 price so a re-hydrated mod can't
          // overwrite QB's real price (the seq-120 vector).
          const editSeqPayload = dropFabricatedZeroPrices(origPayload);
          await knex.raw(
            `UPDATE product_variant
               SET metadata = COALESCE(metadata, '{}'::jsonb)
                 || jsonb_build_object('qb_edit_sequence', ?::text)
             WHERE id = ?`,
            [freshSeq, row.variant_id]
          );

          try {
            const newOpId = await resubmitToBridge("mod", editSeqPayload);
            await catalog.updateQbItemPipelines({
              id: row.id,
              status: "waiting",
              qb_operation_id: newOpId,
              op_payload: editSeqPayload,
              recovery_mode: "none",
              last_error: null,
              last_error_code: null,
              next_retry_at: null,
              submit_count: (row.submit_count ?? 0) + 1,
              last_submitted_at: new Date(),
            });
            editSeqHydrated++;
            logger.info(`[qb-item-pipeline-poller] ${row.sku}: EditSequence hydrated → mod resubmitted (op=${newOpId})`);
          } catch (resubErr: any) {
            await catalog.updateQbItemPipelines({
              id: row.id,
              status: "error",
              last_error: resubErr.message,
              last_error_code: parseQbErrorCode(resubErr.message),
              qb_operation_id: null,
              recovery_mode: "none",
              op_payload: origPayload,
              next_retry_at: new Date(Date.now() + FIRST_ERROR_BACKOFF_MIN * 60_000),
              // Count the attempt — a dispatch that the bridge rejected still
              // consumes the loop budget (otherwise a failing resubmit loops free).
              submit_count: (row.submit_count ?? 0) + 1,
              last_submitted_at: new Date(),
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
          const origPayload = cleanPayload(row.op_payload);

          if (!recoveredListId) {
            // QB has no item by that name after all — fall back to retrying the
            // add (recovery_mode: none → Phase B resubmits as add).
            await catalog.updateQbItemPipelines({
              id: row.id,
              status: "error",
              last_error:
                "Reconcile query returned no ListID — item not found by name; will retry as add",
              qb_operation_id: null,
              recovery_mode: "none",
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
          // Drop any fabricated 0 price (an add with no price defaults to 0; once
          // it becomes a mod, 0 would overwrite QB's real price — the seq-120 bug).
          const modPayload: Record<string, unknown> = dropFabricatedZeroPrices({
            ...origPayload,
            ListID: recoveredListId,
            EditSequence: recoveredSeq,
          });

          try {
            const newOpId = await resubmitToBridge("mod", modPayload);
            await catalog.updateQbItemPipelines({
              id: row.id,
              status: "waiting",
              op_action: "mod",
              qb_id: recoveredListId,
              qb_operation_id: newOpId,
              op_payload: modPayload,
              recovery_mode: "none",
              last_error: null,
              last_error_code: null,
              next_retry_at: null,
              submit_count: (row.submit_count ?? 0) + 1,
              last_submitted_at: new Date(),
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
              last_error_code: parseQbErrorCode(resubErr.message),
              qb_operation_id: null,
              recovery_mode: "none",
              op_payload: modPayload,
              next_retry_at: new Date(
                Date.now() + FIRST_ERROR_BACKOFF_MIN * 60_000
              ),
              submit_count: (row.submit_count ?? 0) + 1,
              last_submitted_at: new Date(),
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
              await syncInventoryItemToMeiliSearchWorkflow(container).run({
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
          recovery_mode: "none",
          last_error: null,
          last_error_code: null,
          next_retry_at: null,
          resolved_at: new Date(),
        });
        resolved++;
      } catch (err: any) {
        await catalog.updateQbItemPipelines({
          id: row.id,
          status: "error",
          last_error: err.message,
          last_error_code: parseQbErrorCode(err.message),
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
      "recovery_mode",
      "submit_count",
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

      // Submit cap backstop — applies to every dispatch path below.
      if (overSubmitCap(row)) {
        await catalog.updateQbItemPipelines({
          id: row.id,
          status: "failed_permanent",
          last_error: `Submit cap reached (${row.submit_count}/${MAX_SUBMITS}) — possible resubmit loop, demoted for manual review`,
          recovery_mode: "none",
          next_retry_at: null,
          failed_at: new Date(),
        });
        logger.error(
          `[qb-item-pipeline-poller] ${row.sku} → failed_permanent: submit cap ${row.submit_count}/${MAX_SUBMITS}`
        );
        loopCapped++;
        continue;
      }

      const payload: Record<string, unknown> = cleanPayload(row.op_payload);

      // Price/cost fallback — ADD ONLY. On a create, QB rejects a missing price
      // with error 3045, so default to 0. On a MOD we must NOT do this: the
      // bridge item-mod builder omits undefined SalesPrice/PurchaseCost so QB
      // keeps its existing value, and dropZeroPricesForMod() drops explicit 0s.
      if (row.op_action === "add") {
        if (payload.SalesPrice === undefined || payload.SalesPrice === null) {
          payload.SalesPrice = 0;
          log("SalesPrice missing in add payload — defaulted to 0");
        }
        if (payload.PurchaseCost === undefined || payload.PurchaseCost === null) {
          payload.PurchaseCost = 0;
        }
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
                  recovery_mode: "reconcile_query",
                  op_payload: payload,
                  last_error: null,
                  last_error_code: null,
                  next_retry_at: null,
                  // An ItemQuery IS a bridge dispatch — count it so a query that
                  // never resolves can't loop past the cap (Codex review).
                  submit_count: (row.submit_count ?? 0) + 1,
                  last_submitted_at: new Date(),
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
                recovery_mode: "editseq_query",
                op_payload: payload,
                last_error: null,
                last_error_code: null,
                next_retry_at: null,
                // An ItemQuery IS a bridge dispatch — count it (Codex review).
                submit_count: (row.submit_count ?? 0) + 1,
                last_submitted_at: new Date(),
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
          recovery_mode: "none",
          last_error: null,
          last_error_code: null,
          next_retry_at: null,
          submit_count: (row.submit_count ?? 0) + 1,
          last_submitted_at: new Date(),
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
          last_error_code: parseQbErrorCode(err.message),
          retries: newRetries,
          next_retry_at: isExhausted
            ? null
            : new Date(Date.now() + backoffMin * 60_000),
          failed_at: isExhausted ? new Date() : null,
          // A rejected dispatch still consumes the loop budget.
          submit_count: (row.submit_count ?? 0) + 1,
          last_submitted_at: new Date(),
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

  // ── Stuck-row surfacing ──────────────────────────────────────────────────
  // A non-terminal row older than STUCK_ALERT_HOURS is surfaced (warn-level)
  // even if updated_at is fresh — the signal an active loop hides from the
  // updated_at-based stale-cleanup. We ALERT here; we do NOT auto-demote
  // (a real bridge/QBWC outage can legitimately keep rows pending for hours).
  // The MAX_SUBMITS cap is the only auto-demotion, and only for true loops.
  try {
    const stuckRes = await knex.raw(
      `SELECT count(*)::int AS n
         FROM qb_item_pipeline
        WHERE status NOT IN ('synced', 'failed_permanent')
          AND deleted_at IS NULL
          AND created_at < now() - interval '${STUCK_ALERT_HOURS} hours'`
    );
    const stuckCount: number =
      (stuckRes?.rows?.[0]?.n ?? stuckRes?.[0]?.n ?? 0) as number;
    if (stuckCount > 0) {
      logger.warn(
        `[qb-item-pipeline-poller] ${stuckCount} non-terminal row(s) older than ${STUCK_ALERT_HOURS}h — see QB pipeline digest / admin for triage`
      );
    }
  } catch {
    // best-effort observability — never let it break the tick
  }

  if (
    resolved ||
    failedToError ||
    retried ||
    permaFailed ||
    editSeqHydrated ||
    reconciled ||
    loopCapped
  ) {
    logger.info(
      `[qb-item-pipeline-poller] tick complete: ` +
        `resolved=${resolved} failed→error=${failedToError} ` +
        `retried=${retried} editSeq_hydrated=${editSeqHydrated} ` +
        `reconciled=${reconciled} loop_capped=${loopCapped} ` +
        `failed_permanent=${permaFailed}`
    );
  }
}

export const config = {
  name: "qb-item-pipeline-poller",
  schedule: "*/1 * * * *",
};
