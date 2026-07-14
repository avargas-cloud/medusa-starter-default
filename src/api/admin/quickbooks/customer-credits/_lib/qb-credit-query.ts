import {
  bridgeFetch,
  POLL_INTERVAL_MS,
  MAX_POLL_ATTEMPTS,
} from "../../../../../lib/quickbooks/client/core";

/**
 * Live-query helpers for a customer's UNAPPLIED QuickBooks credits.
 *
 * Two flavours of "credit that already exists only in QB":
 *   - CreditMemo   with CreditRemaining > 0
 *   - ReceivePayment with UnusedPayment  > 0  (an over-payment / floating deposit)
 *
 * These are used to IMPORT (create) a redeemable POS store-credit that points at
 * the existing QB TxnID — never to mint a new QB document. See
 * `project_qb_only_credit_redemption` memory + the import route.
 */

export type QbCreditDocType = "credit_memo" | "payment";

export interface QbCustomerCredit {
  doc_type: QbCreditDocType;
  txn_id: string;
  ref_number: string | null;
  customer_list_id: string | null;
  customer_name: string | null;
  /** Original document total (display only). */
  total: number;
  /** Unapplied balance still available to redeem (this is what gets imported). */
  remaining: number;
  txn_date: string | null;
  memo: string | null;
}

export function pickNumber(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const n = parseFloat(String(value));
  return Number.isFinite(n) ? n : 0;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function runDirectQuery(
  qbxml: string
): Promise<Record<string, unknown>> {
  const enqueueRes = await bridgeFetch("POST", "/api/sync/direct-query", {
    qbxml,
  });
  const operationId: string =
    enqueueRes?.operationId || enqueueRes?.operation_id;
  if (!operationId) throw new Error("Bridge did not return operationId");

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const statusRes = await bridgeFetch(
      "GET",
      `/api/sync/status/${operationId}`
    );
    const op = statusRes?.operation;
    if (!op) continue;
    if (op.status === "completed") {
      return op.result as Record<string, unknown>;
    }
    if (op.status === "failed") {
      throw new Error(`QB query failed: ${op.error || "Unknown error"}`);
    }
  }
  throw new Error(
    "QB query timed out — QuickBooks Desktop may be offline or QBWC not connected"
  );
}

function extractRet(
  rawResult: Record<string, unknown>,
  rsElement: string,
  retElement: string
): Record<string, any>[] {
  const qbMsgs: Record<string, unknown> =
    (rawResult as any)?.QBXML?.QBXMLMsgsRs ??
    (rawResult as any)?.QBXMLMsgsRs ??
    rawResult;
  const retRaw: unknown =
    (qbMsgs as any)?.[rsElement]?.[retElement] ??
    (rawResult as any)?.[rsElement]?.[retElement] ??
    (rawResult as any)?.[retElement] ??
    null;
  if (!retRaw) return [];
  return Array.isArray(retRaw) ? retRaw : [retRaw];
}

// ─── Credit Memos (CreditRemaining > 0) ──────────────────────────────────────

export function buildCreditMemoQuery(opts: {
  listId?: string;
  txnId?: string;
}): string {
  const filter = opts.txnId
    ? `<TxnID>${escapeXml(opts.txnId)}</TxnID>`
    : `<EntityFilter><ListID>${escapeXml(opts.listId ?? "")}</ListID></EntityFilter>`;
  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<?qbxml version="10.0"?>`,
    `<QBXML><QBXMLMsgsRq onError="stopOnError">`,
    `<CreditMemoQueryRq requestID="1">`,
    filter,
    `</CreditMemoQueryRq>`,
    `</QBXMLMsgsRq></QBXML>`,
  ].join("");
}

export function parseCreditMemos(
  rawResult: Record<string, unknown>
): QbCustomerCredit[] {
  return extractRet(rawResult, "CreditMemoQueryRs", "CreditMemoRet")
    .map((doc): QbCustomerCredit => {
      const total = pickNumber(doc.TotalAmount);
      // CreditRemaining is present when the memo is partially/unapplied; when a
      // memo is fully unapplied QB may omit it, so fall back to the total.
      const remaining =
        doc.CreditRemaining !== undefined
          ? pickNumber(doc.CreditRemaining)
          : total;
      return {
        doc_type: "credit_memo",
        txn_id: doc.TxnID || "",
        ref_number: doc.RefNumber || null,
        customer_list_id: doc.CustomerRef?.ListID || null,
        customer_name: doc.CustomerRef?.FullName || null,
        total,
        remaining,
        txn_date: doc.TxnDate || null,
        memo: doc.Memo || null,
      };
    })
    .filter((c) => c.txn_id && c.remaining > 0.0001);
}

// ─── Receive Payments (UnusedPayment > 0) ────────────────────────────────────

export function buildReceivePaymentQuery(opts: {
  listId?: string;
  txnId?: string;
}): string {
  const filter = opts.txnId
    ? `<TxnID>${escapeXml(opts.txnId)}</TxnID>`
    : `<EntityFilter><ListID>${escapeXml(opts.listId ?? "")}</ListID></EntityFilter>`;
  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<?qbxml version="10.0"?>`,
    `<QBXML><QBXMLMsgsRq onError="stopOnError">`,
    `<ReceivePaymentQueryRq requestID="1">`,
    filter,
    `</ReceivePaymentQueryRq>`,
    `</QBXMLMsgsRq></QBXML>`,
  ].join("");
}

export function parsePayments(
  rawResult: Record<string, unknown>
): QbCustomerCredit[] {
  return extractRet(rawResult, "ReceivePaymentQueryRs", "ReceivePaymentRet")
    .map((doc): QbCustomerCredit => {
      const total = pickNumber(doc.TotalAmount);
      const remaining = pickNumber(doc.UnusedPayment);
      return {
        doc_type: "payment",
        txn_id: doc.TxnID || "",
        ref_number: doc.RefNumber || null,
        customer_list_id: doc.CustomerRef?.ListID || null,
        customer_name: doc.CustomerRef?.FullName || null,
        total,
        remaining,
        txn_date: doc.TxnDate || null,
        memo: doc.Memo || null,
      };
    })
    .filter((c) => c.txn_id && c.remaining > 0.0001);
}
