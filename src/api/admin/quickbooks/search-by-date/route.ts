import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import {
  bridgeFetch,
  POLL_INTERVAL_MS,
  MAX_POLL_ATTEMPTS,
} from "../../../../lib/quickbooks/client/core";

type DateSearchDocType = "InventoryAdjustment" | "ItemReceipt";

interface DocConfig {
  queryElement: string;
  retElement: string;
  rsElement: string;
  vendorField: string | null;
}

const DOC_CONFIG: Record<DateSearchDocType, DocConfig> = {
  InventoryAdjustment: {
    queryElement: "InventoryAdjustmentQueryRq",
    retElement: "InventoryAdjustmentRet",
    rsElement: "InventoryAdjustmentQueryRs",
    vendorField: null, // uses AccountRef
  },
  ItemReceipt: {
    queryElement: "ItemReceiptQueryRq",
    retElement: "ItemReceiptRet",
    rsElement: "ItemReceiptQueryRs",
    vendorField: "VendorRef",
  },
};

const VALID_DOC_TYPES = Object.keys(DOC_CONFIG) as DateSearchDocType[];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pickNumber(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const n = parseFloat(String(value));
  return Number.isFinite(n) ? n : 0;
}

/**
 * POST /admin/quickbooks/search-by-date
 *
 * Queries QB Bridge for InventoryAdjustment or ItemReceipt transactions on a
 * given day. Used to recover orphaned QB transactions that were created but
 * never linked back to the POS pipeline row (missing qb_txn_number).
 *
 * Body: { docType: 'InventoryAdjustment' | 'ItemReceipt', date: 'YYYY-MM-DD' }
 * Returns: { success, docType, date, count, results: SearchResult[] }
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { docType, date } = (req.body ?? {}) as {
    docType?: string;
    date?: string;
  };

  if (!docType || !VALID_DOC_TYPES.includes(docType as DateSearchDocType)) {
    res.status(400).json({
      error: `docType must be one of: ${VALID_DOC_TYPES.join(", ")}`,
    });
    return;
  }
  if (!date || !DATE_RE.test(date)) {
    res.status(400).json({ error: "date is required in YYYY-MM-DD format" });
    return;
  }

  const cfg = DOC_CONFIG[docType as DateSearchDocType];

  const qbxml = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<?qbxml version="10.0"?>`,
    `<QBXML><QBXMLMsgsRq onError="stopOnError">`,
    `<${cfg.queryElement} requestID="1">`,
    `<TxnDateRangeFilter>`,
    `<FromTxnDate>${date}</FromTxnDate>`,
    `<ToTxnDate>${date}</ToTxnDate>`,
    `</TxnDateRangeFilter>`,
    `</${cfg.queryElement}>`,
    `</QBXMLMsgsRq></QBXML>`,
  ].join("");

  try {
    const enqueueRes = await bridgeFetch("POST", "/api/sync/direct-query", {
      qbxml,
    });
    const operationId: string =
      enqueueRes?.operationId || enqueueRes?.operation_id;
    if (!operationId) throw new Error("Bridge did not return operationId");

    let rawResult: Record<string, unknown> | null = null;

    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const statusRes = await bridgeFetch(
        "GET",
        `/api/sync/status/${operationId}`
      );
      const op = statusRes?.operation;
      if (!op) continue;
      if (op.status === "completed") {
        rawResult = op.result as Record<string, unknown>;
        break;
      }
      if (op.status === "failed") {
        throw new Error(`QB query failed: ${op.error || "Unknown error"}`);
      }
    }

    if (!rawResult) {
      throw new Error(
        "QB query timed out — QuickBooks Desktop may be offline or QBWC not connected"
      );
    }

    const qbMsgs: Record<string, unknown> =
      (rawResult as any)?.QBXML?.QBXMLMsgsRs ??
      (rawResult as any)?.QBXMLMsgsRs ??
      rawResult;

    const retRaw: unknown =
      (qbMsgs as any)?.[cfg.rsElement]?.[cfg.retElement] ??
      (rawResult as any)?.[cfg.rsElement]?.[cfg.retElement] ??
      (rawResult as any)?.[cfg.retElement] ??
      null;

    const retArr: Record<string, any>[] = retRaw
      ? Array.isArray(retRaw)
        ? retRaw
        : [retRaw]
      : [];

    const results = retArr
      .map((doc) => {
        const entityName =
          cfg.vendorField
            ? (doc[cfg.vendorField]?.FullName ?? null)
            : (doc.AccountRef?.FullName ?? null);

        return {
          txnId:        doc.TxnID || "",
          editSequence: doc.EditSequence || null,
          refNumber:    doc.RefNumber || "",
          entityName,
          amount:       pickNumber(doc.TotalAmount ?? doc.Amount) || null,
          txnDate:      doc.TxnDate || null,
          memo:         doc.Memo || null,
        };
      })
      .filter((r) => r.txnId);

    res.json({
      success: true,
      docType,
      date,
      count: results.length,
      results,
    });
  } catch (error: unknown) {
    const msg =
      error instanceof Error ? error.message : "Failed to search QB transactions";
    console.error(`[QB Search By Date ${docType} ${date}] Error:`, error);
    res.status(500).json({ error: msg });
  }
}
