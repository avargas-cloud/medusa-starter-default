import {
  DRY_RUN,
  bridgeFetch,
  pollOperationResult,
  pollRawOperationResult,
} from "./core";
import { QbCreateCheckPayload, QbBridgeResult, QbAsyncResult } from "./types";

/**
 * Creates a Write Check in QuickBooks (async fire-and-poll).
 * Used when issuing a physical refund to a customer.
 */
export async function createCheckInQb(
  payload: QbCreateCheckPayload
): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    console.log(
      `[QB DRY RUN] Would create Write Check for customer ${payload.customerId}` +
        ` — amount $${payload.amount.toFixed(2)}`
    );
    return {
      success: true,
      dryRun: true,
      data: {
        operationId: "DRY_RUN",
        txnId: "DRY_RUN_CHECK_TXNID",
        refNumber: "DRY_RUN_REF",
      },
    };
  }

  try {
    const body = {
      AccountRef: { ListID: payload.bankAccountListId },
      PayeeEntityRef: { ListID: payload.customerId },
      TxnDate: payload.date,
      RefNumber: payload.refNumber,
      Memo: payload.memo,
      ExpenseLineAdd: [
        {
          AccountRef: {
            FullName: payload.expenseAccountName ?? "Accounts Receivable",
          },
          Amount: payload.amount.toFixed(2),
          Memo: payload.memo,
        },
      ],
    };
    const data = await bridgeFetch("POST", "/api/checks", body);
    const operationId = data?.operationId;
    if (!operationId)
      throw new Error("Bridge did not return an operationId for Write Check");
    return { success: true, data: { operationId } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Voids an existing Write Check in QuickBooks.
 */
export async function voidCheckInQb(
  checkTxnId: string
): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    return {
      success: true,
      dryRun: true,
      data: { operationId: "DRY_RUN", txnId: checkTxnId },
    };
  }

  try {
    const data = await bridgeFetch(
      "POST",
      `/api/checks/${checkTxnId}/void`,
      {}
    );
    const operationId = data?.operationId;
    if (!operationId)
      throw new Error("Bridge did not return an operationId for void-check");
    return { success: true, data: { operationId, txnId: checkTxnId } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Fetches the CURRENT live state of a Check from QB — fresh EditSequence.
 * Always query fresh before a CheckMod: QB bumps the EditSequence on every
 * edit/reconcile, so any cached value is unreliable (same policy as
 * updatePaymentTxnDateInQb in payments.ts).
 */
export async function fetchCheckCurrentState(
  checkTxnId: string,
  log: (msg: string) => void = console.log
): Promise<{ editSequence: string; txnDate: string | null }> {
  const res = await bridgeFetch("GET", `/api/checks/${checkTxnId}`);
  const operationId: string = res?.operationId || res?.operation?.id;
  if (!operationId) {
    throw new Error("Bridge did not return an operationId for check query");
  }

  const raw = await pollRawOperationResult(operationId, log);
  const msgs = raw?.QBXML?.QBXMLMsgsRs ?? raw?.QBXMLMsgsRs ?? raw ?? {};
  const retRaw =
    msgs?.CheckQueryRs?.CheckRet ??
    raw?.CheckQueryRs?.CheckRet ??
    raw?.CheckRet ??
    null;
  const ret = Array.isArray(retRaw) ? retRaw[0] : retRaw;
  if (!ret?.EditSequence) {
    throw new Error(
      `Check query for ${checkTxnId} returned no CheckRet/EditSequence`
    );
  }
  return {
    editSequence: String(ret.EditSequence),
    txnDate: ret.TxnDate ? String(ret.TxnDate) : null,
  };
}

/**
 * Header-only CheckMod: moves the check's TxnDate and/or bank AccountRef.
 * The bridge builder emits NO expense-line elements, so the AR-offset line
 * (and its CustomerRef) is preserved. Queries QB fresh for the EditSequence
 * first — a stale-3200 failure simply retries with a fresh query.
 */
export async function updateCheckInQb(
  checkTxnId: string,
  changes: { date?: string; bankAccountListId?: string },
  log: (msg: string) => void = console.log
): Promise<QbBridgeResult<QbAsyncResult>> {
  if (!changes.date && !changes.bankAccountListId) {
    return { success: false, error: "CheckMod requires date or bank account" };
  }
  if (DRY_RUN) {
    console.log(
      `[QB DRY RUN] Would modify check ${checkTxnId}: ` +
        `date=${changes.date ?? "unchanged"} bank=${changes.bankAccountListId ?? "unchanged"}`
    );
    return {
      success: true,
      dryRun: true,
      data: { operationId: "DRY_RUN", txnId: checkTxnId },
    };
  }

  try {
    const state = await fetchCheckCurrentState(checkTxnId, log);
    const modResp = await bridgeFetch("PUT", `/api/checks/${checkTxnId}`, {
      EditSequence: state.editSequence,
      ...(changes.date ? { TxnDate: changes.date } : {}),
      ...(changes.bankAccountListId
        ? { AccountRef: { ListID: changes.bankAccountListId } }
        : {}),
    });
    const operationId = modResp?.operationId;
    if (!operationId)
      throw new Error("Bridge did not return an operationId for check mod");
    return { success: true, data: { operationId, txnId: checkTxnId } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Polls for the result of a previously queued Write Check operation.
 */
export async function pollCheckResult(
  operationId: string,
  log: (msg: string) => void = console.log
): Promise<QbAsyncResult> {
  return pollOperationResult(operationId, log);
}

/** One LinkedTxn aggregate from a CheckRet (IncludeLinkedTxns query). */
export interface CheckLinkedTxn {
  txnId: string;
  txnType: string;
}

/**
 * Pure parser: extracts the LinkedTxn list from a CheckRet.
 * Returns null when the CheckRet carries NO LinkedTxn key at all — that means
 * the bridge predates IncludeLinkedTxns (capability missing), which callers
 * MUST distinguish from "linked list present but empty/no ReceivePayment".
 */
export function extractCheckLinkedTxns(
  checkRet: unknown
): CheckLinkedTxn[] | null {
  const ret = (
    Array.isArray(checkRet) ? checkRet[0] : checkRet
  ) as Record<string, unknown> | null;
  if (!ret || !("LinkedTxn" in ret)) return null;
  const rawList = ret.LinkedTxn;
  const arr: unknown[] = Array.isArray(rawList) ? rawList : [rawList];
  const out: CheckLinkedTxn[] = [];
  for (const item of arr) {
    const l = item as Record<string, unknown> | null;
    if (l?.TxnID) {
      out.push({ txnId: String(l.TxnID), txnType: String(l.TxnType ?? "") });
    }
  }
  return out;
}

/**
 * Queries the check in QB and returns its LinkedTxn list (or null when the
 * bridge doesn't return LinkedTxn — old bridge without IncludeLinkedTxns).
 * Used by the revert-refund flow to resolve the $0 apply ReceivePayment:
 * QBXML quirk — a zero-amount ReceivePaymentAdd applied entirely from credits
 * may create NO ReceivePayment txn (its AddRs Ret has no TxnID), in which case
 * voiding the check alone frees the credit.
 */
export async function fetchCheckLinkedTxns(
  checkTxnId: string,
  log: (msg: string) => void = console.log
): Promise<CheckLinkedTxn[] | null> {
  const res = await bridgeFetch("GET", `/api/checks/${checkTxnId}`);
  const operationId: string = res?.operationId || res?.operation?.id;
  if (!operationId) {
    throw new Error("Bridge did not return an operationId for check query");
  }
  const raw = await pollRawOperationResult(operationId, log);
  const msgs = raw?.QBXML?.QBXMLMsgsRs ?? raw?.QBXMLMsgsRs ?? raw ?? {};
  const retRaw =
    msgs?.CheckQueryRs?.CheckRet ??
    raw?.CheckQueryRs?.CheckRet ??
    raw?.CheckRet ??
    null;
  if (!retRaw) {
    throw new Error(`Check query for ${checkTxnId} returned no CheckRet`);
  }
  return extractCheckLinkedTxns(retRaw);
}
