import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import {
  bridgeFetch,
  POLL_INTERVAL_MS,
  MAX_POLL_ATTEMPTS,
} from "../../../../lib/quickbooks/client/core";

interface PaymentSearchResult {
  txnId: string;
  editSequence: string | null;
  refNumber: string;
  customerName: string | null;
  amount: number | null;
  txnDate: string | null;
  memo: string | null;
  appliedToInvoices: {
    txnId: string;
    refNumber: string | null;
    amount: number;
  }[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pickNumber(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const n = parseFloat(String(value));
  return Number.isFinite(n) ? n : 0;
}

function normalizeAppliedTo(
  appliedTo: unknown
): PaymentSearchResult["appliedToInvoices"] {
  if (!appliedTo) return [];
  const arr = Array.isArray(appliedTo) ? appliedTo : [appliedTo];
  return arr
    .map((a: any) => ({
      txnId: a?.TxnID || "",
      refNumber: a?.RefNumber || null,
      amount: pickNumber(a?.Amount),
    }))
    .filter((a) => a.txnId);
}

/**
 * POST /admin/quickbooks/search-payments
 *
 * Queries QB Bridge for all ReceivePayment transactions on a given day.
 * Used to recover orphaned QB payments that were created but never linked
 * back to the Medusa payment (missing qb_txn_id metadata).
 *
 * Body: { date: 'YYYY-MM-DD' }
 * Returns: { success: true, date, count, payments: PaymentSearchResult[] }
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { date } = (req.body ?? {}) as { date?: string };

  if (!date || !DATE_RE.test(date)) {
    res.status(400).json({ error: "date is required in YYYY-MM-DD format" });
    return;
  }

  const qbxml = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<?qbxml version="10.0"?>`,
    `<QBXML><QBXMLMsgsRq onError="stopOnError">`,
    `<ReceivePaymentQueryRq requestID="1">`,
    `<TxnDateRangeFilter>`,
    `<FromTxnDate>${date}</FromTxnDate>`,
    `<ToTxnDate>${date}</ToTxnDate>`,
    `</TxnDateRangeFilter>`,
    `<IncludeLineItems>true</IncludeLineItems>`,
    `</ReceivePaymentQueryRq>`,
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
      (qbMsgs as any)?.ReceivePaymentQueryRs?.ReceivePaymentRet ??
      (rawResult as any)?.ReceivePaymentQueryRs?.ReceivePaymentRet ??
      (rawResult as any)?.ReceivePaymentRet ??
      null;

    const retArr: Record<string, any>[] = retRaw
      ? Array.isArray(retRaw)
        ? retRaw
        : [retRaw]
      : [];

    const payments: PaymentSearchResult[] = retArr
      .map((doc) => ({
        txnId: doc.TxnID || "",
        editSequence: doc.EditSequence || null,
        refNumber: doc.RefNumber || "",
        customerName: doc.CustomerRef?.FullName || null,
        amount: pickNumber(doc.TotalAmount) || null,
        txnDate: doc.TxnDate || null,
        memo: doc.Memo || null,
        appliedToInvoices: normalizeAppliedTo(doc.AppliedToTxnRet),
      }))
      .filter((p) => p.txnId);

    res.json({
      success: true,
      date,
      count: payments.length,
      payments,
    });
  } catch (error: unknown) {
    const msg =
      error instanceof Error ? error.message : "Failed to search payments";
    console.error(`[QB Search Payments ${date}] Error:`, error);
    res.status(500).json({ error: msg });
  }
}
