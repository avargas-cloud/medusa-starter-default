import { getCachedEditSequence, cacheEditSequence } from "../qb-pipeline";

import { DRY_RUN, bridgeFetch, pollRawOperationResult } from "./core";
import {
  QbCreateEstimatePayload,
  QbUpdateEstimatePayload,
  QbConvertEstimatePayload,
  QbBridgeResult,
  QbAsyncResult,
} from "./types";

/**
 * Compares two QB TxnLineID strings for ascending sort.
 * Number() on hex-format IDs like "1C1255-1776781804" returns NaN, breaking sort.
 * Falls back to parsing the first hex segment when numeric conversion fails.
 */
function compareTxnLineIds(a: string, b: string): number {
  const numA = Number(a);
  const numB = Number(b);
  if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
  const hexA = parseInt(a.split("-")[0] ?? a, 16);
  const hexB = parseInt(b.split("-")[0] ?? b, 16);
  if (!isNaN(hexA) && !isNaN(hexB)) return hexA - hexB;
  return a.localeCompare(b);
}

/**
 * Creates an Estimate in QuickBooks (async — used for Draft Orders).
 * Returns operationId. Poll for txnId (qb_estimate_txn_id) + refNumber (qb_estimate_ref).
 */
export async function createEstimateInQb(
  payload: QbCreateEstimatePayload
): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    console.log(
      `[QB DRY RUN] Would create Estimate for:`,
      payload.customerId,
      `(${payload.items.length} items)`
    );
    return {
      success: true,
      dryRun: true,
      data: {
        operationId: "DRY_RUN",
        txnId: "DRY_RUN_ESTIMATE_TXNID",
        refNumber: "DRY_RUN_REF",
      },
    };
  }

  try {
    const body = {
      ...payload,
      salesRepRef: payload.salesRep,
    };
    const data = await bridgeFetch("POST", "/api/estimates", body);
    const operationId = data?.operationId;
    if (!operationId)
      throw new Error("Bridge did not return an operationId for Estimate");
    return { success: true, data: { operationId } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Updates an existing QB Estimate (for Draft Order re-sync).
 */
export async function updateEstimateInQb(
  payload: QbUpdateEstimatePayload
): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    console.log(
      `[QB DRY RUN] Would update Estimate ${payload.txnId} (${payload.items.length} items)`
    );
    return {
      success: true,
      dryRun: true,
      data: { operationId: "DRY_RUN", txnId: payload.txnId },
    };
  }

  try {
    let editSequence: string;
    let qbLinesByProductId: Record<string, string[]> = {};

    // Try the EditSequence + TxnLineID cache first (populated by consolidator after confirmation).
    // This avoids a round-trip GET to the QB bridge for the common case (single or sequential saves).
    const cached = await getCachedEditSequence("estimate", payload.txnId);
    if (cached?.editSeq && cached?.lineIds) {
      console.log(
        `[QB] ✅ Cache hit for estimate ${payload.txnId} — skipping GET round-trip`
      );
      editSequence = cached.editSeq;
      qbLinesByProductId = cached.lineIds;
    } else {
      // Cache miss (first edit, or lineIds not yet cached) → fetch from QB bridge
      console.log(
        `[QB] Cache miss for estimate ${payload.txnId} — querying QB for EditSequence + lines`
      );
      const queryResp = await bridgeFetch(
        "GET",
        `/api/estimates/${payload.txnId}`
      );
      const queryOpId = queryResp?.operationId;
      if (!queryOpId)
        throw new Error("Bridge did not return operationId for estimate query");

      const rawResult = await pollRawOperationResult(queryOpId);

      const estRet =
        rawResult?.QBXML?.QBXMLMsgsRs?.EstimateQueryRs?.EstimateRet ??
        rawResult?.QBXMLMsgsRs?.EstimateQueryRs?.EstimateRet ??
        rawResult?.EstimateRet ??
        rawResult?.EstimateQueryRs?.EstimateRet;

      if (!estRet?.EditSequence) {
        throw new Error(
          `Could not extract EditSequence from estimate query result. Raw: ${JSON.stringify(rawResult).slice(0, 200)}`
        );
      }

      editSequence = estRet.EditSequence as string;
      const existingLines = estRet.EstimateLineRet;
      const linesArr: any[] = Array.isArray(existingLines)
        ? existingLines
        : existingLines
          ? [existingLines]
          : [];

      // Sort ascending by TxnLineID (numeric) so the queue matches QB line order.
      // Duplicate products (same QB ListID) are supported via arrays.
      const sortedLines = [...linesArr].sort((a, b) =>
        compareTxnLineIds(
          String(a?.TxnLineID ?? ""),
          String(b?.TxnLineID ?? "")
        )
      );
      for (const line of sortedLines) {
        const productId = line?.ItemRef?.ListID;
        const txnLineId = line?.TxnLineID;
        if (productId && txnLineId) {
          if (!qbLinesByProductId[productId])
            qbLinesByProductId[productId] = [];
          qbLinesByProductId[productId].push(txnLineId);
        }
      }

      // Warm the cache with what we just fetched so the next mod can skip the GET
      cacheEditSequence(
        "estimate",
        payload.txnId,
        editSequence,
        qbLinesByProductId
      ).catch(() => {});
    }

    // Make a mutable copy of the queues so .shift() doesn't mutate the cached object.
    const txnLineQueue: Record<string, string[]> = Object.fromEntries(
      Object.entries(qbLinesByProductId).map(([k, v]) => [k, [...v]])
    );

    const modItems = payload.items
      .map((item) => {
        const pid = item.productId;
        // Pop the first available TxnLineID for this productId (supports duplicates).
        const txnLineId = pid ? txnLineQueue[pid]?.shift() : undefined;
        return {
          ...(txnLineId ? { TxnLineID: txnLineId } : {}),
          ...(pid ? { productId: pid } : {}),
          ...(item.productName ? { productName: item.productName } : {}),
          quantity: item.quantity,
          price: item.price,
          amount: item.amount,
          desc: item.desc,
        };
      })
      // QB Error 3290: TxnLineIDs must be sent in ascending numeric order.
      // Items without TxnLineID (new lines) go last so QB appends them.
      .sort((a, b) => {
        if (a.TxnLineID && b.TxnLineID)
          return compareTxnLineIds(String(a.TxnLineID), String(b.TxnLineID));
        if (a.TxnLineID) return -1; // existing line → before new
        if (b.TxnLineID) return 1; // new line → after existing
        return 0;
      });

    const modResp = await bridgeFetch(
      "PUT",
      `/api/estimates/${payload.txnId}`,
      {
        EditSequence: editSequence,
        items: modItems,
        memo: payload.memo,
        ...(payload.isActive !== undefined
          ? { IsActive: payload.isActive }
          : {}),
        ...(payload.taxExempt === true ? { taxExempt: true } : {}),
        ...(payload.salesTaxCode ? { salesTaxCode: payload.salesTaxCode } : {}),
        ...(payload.salesRep ? { salesRepRef: payload.salesRep } : {}),
      }
    );

    const operationId = modResp?.operationId;
    if (!operationId)
      throw new Error(
        "Bridge did not return operationId for estimate update (mod)"
      );

    console.log(`[QB] ✅ Estimate update queued. OperationID: ${operationId}`);
    return { success: true, data: { operationId, txnId: payload.txnId } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Converts an existing Estimate into a Sales Order (async).
 */
export async function convertEstimateToSalesOrder(
  payload: QbConvertEstimatePayload
): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    console.log(
      `[QB DRY RUN] Would convert Estimate ${payload.estimateTxnId} to Sales Order`
    );
    return {
      success: true,
      dryRun: true,
      data: {
        operationId: "DRY_RUN",
        txnId: "DRY_RUN_CONVERT_TXNID",
        refNumber: "DRY_RUN_REF",
      },
    };
  }

  try {
    const data = await bridgeFetch(
      "POST",
      "/api/sales-orders/convert-from-estimate",
      payload
    );
    const operationId = data?.operationId;
    if (!operationId)
      throw new Error(
        "Bridge did not return an operationId for convert-from-estimate"
      );
    return { success: true, data: { operationId } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Deactivates an Estimate in QuickBooks (sets IsActive = false).
 * If `editSequence` is provided (from cache), skips the GET round-trip to QB.
 */
export async function deactivateEstimateInQb(
  estimateTxnId: string,
  editSequence?: string,
  log: (msg: string) => void = console.log
): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    log(`[QB DRY RUN] Would deactivate Estimate ${estimateTxnId}`);
    return {
      success: true,
      dryRun: true,
      data: { operationId: "DRY_RUN", txnId: estimateTxnId },
    };
  }

  try {
    let resolvedEditSequence = editSequence;

    if (!resolvedEditSequence) {
      log(
        `[QB] Querying Estimate ${estimateTxnId} to get EditSequence for deactivation...`
      );
      const queryResp = await bridgeFetch(
        "GET",
        `/api/estimates/${estimateTxnId}`
      );
      const queryOpId = queryResp?.operationId;
      if (!queryOpId)
        throw new Error("Bridge did not return operationId for Estimate query");

      const rawResult = await pollRawOperationResult(queryOpId);

      const estRet =
        rawResult?.QBXML?.QBXMLMsgsRs?.EstimateQueryRs?.EstimateRet ??
        rawResult?.QBXMLMsgsRs?.EstimateQueryRs?.EstimateRet ??
        rawResult?.EstimateRet ??
        rawResult?.EstimateQueryRs?.EstimateRet;

      if (!estRet?.EditSequence) {
        throw new Error(
          `Could not extract EditSequence from Estimate query. Raw: ${JSON.stringify(rawResult).slice(0, 200)}`
        );
      }
      resolvedEditSequence = estRet.EditSequence as string;
    }

    log(
      `[QB] EditSequence: ${resolvedEditSequence}. Deactivating Estimate ${estimateTxnId}...`
    );

    const modResp = await bridgeFetch(
      "PUT",
      `/api/estimates/${estimateTxnId}`,
      {
        EditSequence: resolvedEditSequence,
        IsActive: false,
      }
    );

    const operationId = modResp?.operationId;
    if (!operationId)
      throw new Error(
        "Bridge did not return operationId for Estimate deactivation"
      );

    log(
      `[QB] Estimate ${estimateTxnId} deactivation queued (op: ${operationId})`
    );
    return { success: true, data: { operationId, txnId: estimateTxnId } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Cancels an Estimate in QuickBooks (zeros all line quantities via EstimateMod).
 */
export async function cancelEstimateInQb(
  estimateTxnId: string,
  log: (msg: string) => void = console.log
): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    log(`[QB DRY RUN] Would cancel Estimate ${estimateTxnId}`);
    return {
      success: true,
      dryRun: true,
      data: { operationId: "DRY_RUN", txnId: estimateTxnId },
    };
  }

  try {
    log(
      `[QB] Querying Estimate ${estimateTxnId} to get EditSequence and lines for cancellation...`
    );
    const queryResp = await bridgeFetch(
      "GET",
      `/api/estimates/${estimateTxnId}`
    );
    const queryOpId = queryResp?.operationId;
    if (!queryOpId)
      throw new Error("Bridge did not return operationId for Estimate query");

    const rawResult = await pollRawOperationResult(queryOpId);

    const estRet =
      rawResult?.QBXML?.QBXMLMsgsRs?.EstimateQueryRs?.EstimateRet ??
      rawResult?.QBXMLMsgsRs?.EstimateQueryRs?.EstimateRet ??
      rawResult?.EstimateRet ??
      rawResult?.EstimateQueryRs?.EstimateRet;

    if (!estRet?.EditSequence) {
      throw new Error(
        `Could not extract EditSequence from Estimate query. Raw: ${JSON.stringify(rawResult).slice(0, 200)}`
      );
    }

    const editSequence = estRet.EditSequence as string;

    const existingLines = estRet.EstimateLineRet;
    const linesArr: any[] = Array.isArray(existingLines)
      ? existingLines
      : existingLines
        ? [existingLines]
        : [];
    const lines = linesArr
      .map((line) => ({ TxnLineID: line?.TxnLineID }))
      .filter((l) => l.TxnLineID);

    log(
      `[QB] EditSequence obtained: ${editSequence}. Extracted ${lines.length} lines. Canceling Estimate...`
    );

    const data = await bridgeFetch(
      "DELETE",
      `/api/estimates/${estimateTxnId}`,
      {
        EditSequence: editSequence,
        lines,
      }
    );
    const operationId = data?.operationId;
    if (!operationId)
      throw new Error("Bridge did not return operationId for Estimate cancel");

    log(`[QB] Estimate ${estimateTxnId} cancel queued (op: ${operationId})`);
    return { success: true, data: { operationId, txnId: estimateTxnId } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
