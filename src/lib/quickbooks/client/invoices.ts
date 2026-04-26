import {
  getCachedEditSequence,
  cacheEditSequence,
  invalidateEditSequence,
} from "../qb-pipeline";

import {
  DRY_RUN,
  bridgeFetch,
  pollRawOperationResult,
  pollOperationResult,
} from "./core";
import {
  QbCreateInvoicePayload,
  QbUpdateInvoicePayload,
  QbBridgeResult,
  QbAsyncResult,
} from "./types";

/**
 * Creates an Invoice in QuickBooks (async).
 * Can be linked to a Sales Order via LinkToTxnID, or standalone with items[].
 */
export async function createInvoiceInQb(
  payload: QbCreateInvoicePayload
): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    console.log(
      `[QB DRY RUN] Would create Invoice in QB linked to SO:`,
      payload.LinkToTxnID || "(standalone)"
    );
    return {
      success: true,
      dryRun: true,
      data: {
        operationId: "DRY_RUN",
        txnId: "DRY_RUN_INVOICE_TXNID",
        refNumber: "DRY_RUN_REF",
      },
    };
  }

  try {
    const body = {
      ...payload,
      salesRepRef: payload.salesRep,
    };
    const data = await bridgeFetch("POST", "/api/invoices", body);
    const operationId = data?.operationId;
    if (!operationId)
      throw new Error("Bridge did not return an operationId for Invoice");
    return { success: true, data: { operationId } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

async function fetchFreshInvoiceEditSequence(txnId: string): Promise<string> {
  const queryResp = await bridgeFetch("GET", `/api/invoices/${txnId}`);
  const queryOpId = queryResp?.operationId;
  if (!queryOpId)
    throw new Error("Bridge did not return operationId for invoice query");

  const rawResult = await pollRawOperationResult(queryOpId);
  const invRet =
    rawResult?.QBXML?.QBXMLMsgsRs?.InvoiceQueryRs?.InvoiceRet ??
    rawResult?.QBXMLMsgsRs?.InvoiceQueryRs?.InvoiceRet ??
    rawResult?.InvoiceRet ??
    rawResult?.InvoiceQueryRs?.InvoiceRet;

  if (!invRet?.EditSequence)
    throw new Error("Could not extract EditSequence from invoice query result");

  return invRet.EditSequence as string;
}

export interface QbInvoiceLineSnapshot {
  TxnLineID: string;
  ItemListID?: string;
  ItemFullName?: string;
  Quantity?: number;
  Rate?: number;
  Amount?: number;
  Desc?: string;
  /** True if the existing QB line has InventorySiteRef (so it's an inventory item). */
  hasSite?: boolean;
}

/**
 * Queries an Invoice from QB and returns its current lines with TxnLineIDs.
 * Required for *Mod operations that want to update/append/delete specific
 * lines instead of replacing everything blindly (which QB does not support).
 */
export async function fetchInvoiceLinesFromQb(
  txnId: string
): Promise<{ editSequence: string; lines: QbInvoiceLineSnapshot[] }> {
  const queryResp = await bridgeFetch("GET", `/api/invoices/${txnId}`);
  const queryOpId = queryResp?.operationId;
  if (!queryOpId)
    throw new Error("Bridge did not return operationId for invoice query");

  const rawResult = await pollRawOperationResult(queryOpId);
  const invRet =
    rawResult?.QBXML?.QBXMLMsgsRs?.InvoiceQueryRs?.InvoiceRet ??
    rawResult?.QBXMLMsgsRs?.InvoiceQueryRs?.InvoiceRet ??
    rawResult?.InvoiceRet ??
    rawResult?.InvoiceQueryRs?.InvoiceRet;

  if (!invRet?.EditSequence)
    throw new Error("Could not extract EditSequence from invoice query result");

  const rawLines = invRet.InvoiceLineRet
    ? Array.isArray(invRet.InvoiceLineRet)
      ? invRet.InvoiceLineRet
      : [invRet.InvoiceLineRet]
    : [];

  const lines: QbInvoiceLineSnapshot[] = rawLines
    .filter((l: any) => l?.TxnLineID)
    .map((l: any) => ({
      TxnLineID: String(l.TxnLineID),
      ItemListID: l.ItemRef?.ListID,
      ItemFullName: l.ItemRef?.FullName,
      Quantity:
        l.Quantity !== undefined && l.Quantity !== ""
          ? Number(l.Quantity)
          : undefined,
      Rate: l.Rate !== undefined && l.Rate !== "" ? Number(l.Rate) : undefined,
      Amount:
        l.Amount !== undefined && l.Amount !== ""
          ? Number(l.Amount)
          : undefined,
      Desc: l.Desc,
      hasSite: !!(l.InventorySiteRef && l.InventorySiteRef.ListID),
    }));

  return { editSequence: invRet.EditSequence as string, lines };
}

/**
 * Updates an existing Invoice in QuickBooks (salesRep only for now).
 * Fetches EditSequence from cache or QB, then sends InvoiceMod.
 * If QB returns error 3200 (stale EditSequence), invalidates cache and retries once.
 */
export async function updateInvoiceInQb(
  payload: QbUpdateInvoicePayload
): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    console.log(`[QB DRY RUN] Would update Invoice ${payload.txnId}`);
    return {
      success: true,
      dryRun: true,
      data: { operationId: "DRY_RUN", txnId: payload.txnId },
    };
  }

  const sendMod = async (editSequence: string) => {
    const modResp = await bridgeFetch("PUT", `/api/invoices/${payload.txnId}`, {
      EditSequence: editSequence,
      ...(payload.salesRep ? { salesRepRef: payload.salesRep } : {}),
      ...(payload.salesTaxCode ? { salesTaxCode: payload.salesTaxCode } : {}),
      ...(payload.taxExempt === true ? { taxExempt: true } : {}),
      ...(payload.items && payload.items.length > 0
        ? { items: payload.items }
        : {}),
    });
    const operationId = modResp?.operationId;
    if (!operationId)
      throw new Error(
        "Bridge did not return operationId for invoice update (mod)"
      );
    return operationId;
  };

  try {
    // ── Step 1: get EditSequence (cache or QB query) ──────────────────────
    let editSequence: string;
    const cached = await getCachedEditSequence("invoice", payload.txnId);
    if (cached?.editSeq) {
      console.log(
        `[QB] ✅ Cache hit for invoice ${payload.txnId} — skipping GET round-trip`
      );
      editSequence = cached.editSeq;
    } else {
      console.log(
        `[QB] Cache miss for invoice ${payload.txnId} — querying QB for EditSequence`
      );
      editSequence = await fetchFreshInvoiceEditSequence(payload.txnId);
      cacheEditSequence("invoice", payload.txnId, editSequence).catch(() => {});
    }

    // ── Step 2: send mod and poll ─────────────────────────────────────────
    let operationId = await sendMod(editSequence);
    console.log(`[QB] Invoice mod queued. OperationID: ${operationId}`);

    let pollResult: QbAsyncResult;
    try {
      pollResult = await pollOperationResult(operationId);
    } catch (pollErr: any) {
      // ── Step 3: stale EditSequence → invalidate, re-fetch, retry once ───
      if (/3200|out.of.date|edit.?sequence/i.test(pollErr.message)) {
        console.warn(
          `[QB] ⚠️ Stale EditSequence for invoice ${payload.txnId} (${editSequence}) — invalidating cache and retrying`
        );
        await invalidateEditSequence("invoice", payload.txnId);

        const freshEditSeq = await fetchFreshInvoiceEditSequence(payload.txnId);
        cacheEditSequence("invoice", payload.txnId, freshEditSeq).catch(
          () => {}
        );

        operationId = await sendMod(freshEditSeq);
        console.log(
          `[QB] Invoice mod retry queued. OperationID: ${operationId}`
        );
        pollResult = await pollOperationResult(operationId);
      } else {
        throw pollErr;
      }
    }

    if (pollResult.editSequence) {
      cacheEditSequence(
        "invoice",
        payload.txnId,
        pollResult.editSequence
      ).catch(() => {});
    }

    console.log(`[QB] ✅ Invoice updated. OperationID: ${operationId}`);
    return { success: true, data: { operationId, txnId: payload.txnId } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Voids an Invoice in QuickBooks.
 * Fetches the EditSequence dynamically before voiding to ensure consistency.
 */
export async function voidInvoiceInQb(
  invoiceTxnId: string,
  log: (msg: string) => void = console.log
): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    log(`[QB DRY RUN] Would void Invoice ${invoiceTxnId}`);
    return {
      success: true,
      dryRun: true,
      data: { operationId: "DRY_RUN", txnId: invoiceTxnId },
    };
  }

  try {
    log(
      `[QB] Querying Invoice ${invoiceTxnId} to get EditSequence for voiding...`
    );
    const queryResp = await bridgeFetch("GET", `/api/invoices/${invoiceTxnId}`);
    const queryOpId = queryResp?.operationId;
    if (!queryOpId)
      throw new Error("Bridge did not return operationId for Invoice query");

    const rawResult = await pollRawOperationResult(queryOpId, log);

    const invRet =
      rawResult?.QBXML?.QBXMLMsgsRs?.InvoiceQueryRs?.InvoiceRet ??
      rawResult?.QBXMLMsgsRs?.InvoiceQueryRs?.InvoiceRet ??
      rawResult?.InvoiceRet ??
      rawResult?.InvoiceQueryRs?.InvoiceRet;

    const editSequence = invRet?.EditSequence as string | undefined;
    // Warning if missing, though TxnVoidRq technically doesn't require it, we fetch it per policy.
    if (!editSequence) {
      log(
        `[QB] Warning: Could not extract EditSequence for Invoice ${invoiceTxnId}. Proceeding with void.`
      );
    } else {
      log(`[QB] EditSequence obtained: ${editSequence}. Voiding Invoice...`);
    }

    const data = await bridgeFetch("DELETE", `/api/invoices/${invoiceTxnId}`);
    const operationId = data?.operationId;
    if (!operationId)
      throw new Error("Bridge did not return operationId for Invoice void");

    log(`[QB] Invoice ${invoiceTxnId} void queued (op: ${operationId})`);
    const result = await pollOperationResult(operationId, log);
    return { success: true, data: result };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
