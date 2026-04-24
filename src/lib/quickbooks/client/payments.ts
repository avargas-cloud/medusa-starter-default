import {
  DRY_RUN,
  bridgeFetch,
  pollRawOperationResult,
  pollOperationResult,
} from "./core";
import {
  QbReceivePaymentPayload,
  QbBridgeResult,
  QbAsyncResult,
} from "./types";

export interface PaymentCurrentState {
  editSequence: string;
  appliedToInvoices: { invoiceId: string; amount: number }[];
}

export interface MergeApplyResult {
  operationId: string;
  newEditSequence: string | null;
  totalAppliedCount: number;
}

/**
 * Records a payment receipt in QuickBooks (async).
 * With autoApply: false, creates an unapplied credit that can be applied to the Invoice later.
 */
export async function receivePaymentInQb(
  payload: QbReceivePaymentPayload
): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    console.log(
      `[QB DRY RUN] Would record payment in QB: $${payload.amount} from ${payload.customerId}`
    );
    return {
      success: true,
      dryRun: true,
      data: {
        operationId: "DRY_RUN",
        txnId: "DRY_RUN_PAYMENT_TXNID",
        refNumber: "DRY_RUN_REF",
      },
    };
  }

  try {
    const body = {
      autoApply: false, // default: keep as open credit for e-commerce flow
      ...payload,
    };
    const data = await bridgeFetch("POST", "/api/payments", body);
    const operationId = data?.operationId;
    if (!operationId)
      throw new Error("Bridge did not return an operationId for Payment");
    return { success: true, data: { operationId } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Applies an existing unapplied ReceivePayment to an invoice via ReceivePaymentMod.
 * Uses POST /api/payments/{creditTxnId}/apply — modifies the existing QB payment in-place
 * rather than creating a new one. Requires EditSequence to avoid creating a duplicate record.
 */
export async function applyPaymentToInvoiceInQb(payload: {
  customerId: string;
  amount: number | string;
  invoiceId: string;
  creditTxnId: string;
  editSequence: string;
  memo?: string;
}): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    console.log(
      `[QB DRY RUN] Would apply payment ${payload.creditTxnId} to invoice ${payload.invoiceId}`
    );
    return { success: true, dryRun: true, data: { operationId: "DRY_RUN" } };
  }

  try {
    const data = await bridgeFetch(
      "POST",
      `/api/payments/${payload.creditTxnId}/apply`,
      {
        customerId: payload.customerId,
        invoiceId: payload.invoiceId,
        amount: payload.amount,
        editSequence: payload.editSequence,
        ...(payload.memo !== undefined ? { memo: payload.memo } : {}),
      }
    );
    const operationId = data?.operationId;
    if (!operationId)
      throw new Error("Bridge did not return an operationId for apply-payment");
    return { success: true, data: { operationId } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Voids a payment entirely in QuickBooks.
 */
export async function voidPaymentInQb(
  paymentTxnId: string
): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    console.log(`[QB DRY RUN] Would void payment ${paymentTxnId}`);
    return {
      success: true,
      dryRun: true,
      data: { operationId: "DRY_RUN", txnId: paymentTxnId },
    };
  }

  try {
    const data = await bridgeFetch(
      "POST",
      `/api/payments/${paymentTxnId}/void`,
      {}
    );
    const operationId = data?.operationId;
    if (!operationId)
      throw new Error("Bridge did not return an operationId for void-payment");
    return { success: true, data: { operationId, txnId: paymentTxnId } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Fetches the CURRENT live state of a ReceivePayment from QB:
 * - fresh EditSequence
 * - the full AppliedToTxnRet list (which invoices it currently pays, and how much)
 *
 * Used as the first step of mergeApplyPaymentInQb — you must know the current state
 * before issuing a ReceivePaymentMod, because AppliedToTxnMod is REPLACE-ALL semantics
 * in QB SDK (any application not included in the Mod gets silently unapplied).
 */
export async function fetchPaymentCurrentState(
  creditTxnId: string,
  log: (msg: string) => void = console.log
): Promise<PaymentCurrentState> {
  const res = await bridgeFetch("GET", `/api/payments/${creditTxnId}`);
  const operationId: string = res?.operationId || res?.operation?.id;
  if (!operationId) {
    throw new Error("Bridge did not return an operationId for payment query");
  }

  const raw = await pollRawOperationResult(operationId, log);
  const msgs = raw?.QBXML?.QBXMLMsgsRs ?? raw?.QBXMLMsgsRs ?? raw ?? {};
  const retRaw =
    msgs?.ReceivePaymentQueryRs?.ReceivePaymentRet ??
    raw?.ReceivePaymentQueryRs?.ReceivePaymentRet ??
    raw?.ReceivePaymentRet ??
    null;

  if (!retRaw) {
    throw new Error(
      `QB returned no ReceivePaymentRet for TxnID=${creditTxnId}`
    );
  }

  const ret: any = Array.isArray(retRaw) ? retRaw[0] : retRaw;
  const editSequence: string | undefined = ret?.EditSequence;
  if (!editSequence) {
    throw new Error(`QB response for TxnID=${creditTxnId} has no EditSequence`);
  }

  const appliedRaw = ret?.AppliedToTxnRet;
  const appliedArr: any[] = appliedRaw
    ? Array.isArray(appliedRaw)
      ? appliedRaw
      : [appliedRaw]
    : [];

  const appliedToInvoices = appliedArr
    .map((a) => ({
      invoiceId: String(a?.TxnID || ""),
      amount: parseFloat(String(a?.Amount ?? "0")) || 0,
    }))
    .filter((a) => a.invoiceId && a.amount > 0);

  return { editSequence: String(editSequence), appliedToInvoices };
}

/**
 * Merge-applies a ReceivePayment to an invoice WITHOUT unapplying any existing
 * applications. Internally:
 *   1. Queries the live payment to get fresh EditSequence + current applied list.
 *   2. Merges the new application into that list (if invoiceId already exists,
 *      overwrites the amount; otherwise appends).
 *   3. Sends a single ReceivePaymentMod with all applications via the bridge's
 *      /merge-apply endpoint.
 *
 * IMPORTANT: callers MUST wrap this in `withQbLockResult(paymentTxnId, ...)` to
 * prevent race conditions. Two concurrent merge-applies on the same payment would
 * both read the same "before" state and one would clobber the other.
 */
export async function mergeApplyPaymentInQb(payload: {
  customerId: string;
  amount: number | string;
  invoiceId: string;
  creditTxnId: string;
  memo?: string;
  log?: (msg: string) => void;
  onQueued?: (operationId: string) => Promise<void>;
}): Promise<QbBridgeResult<MergeApplyResult>> {
  const log = payload.log ?? console.log;

  if (DRY_RUN) {
    log(
      `[QB DRY RUN] Would merge-apply payment ${payload.creditTxnId} to invoice ${payload.invoiceId}`
    );
    return {
      success: true,
      dryRun: true,
      data: {
        operationId: "DRY_RUN",
        newEditSequence: null,
        totalAppliedCount: 1,
      },
    };
  }

  const newAmount = Number(payload.amount);
  if (!Number.isFinite(newAmount) || newAmount <= 0) {
    return {
      success: false,
      error: `Invalid amount: ${payload.amount}`,
    };
  }

  try {
    // ── Step 1: fetch live state ───────────────────────────────────────────
    const state = await fetchPaymentCurrentState(payload.creditTxnId, log);
    log(
      `[QB] 🔎 Payment ${payload.creditTxnId} current state: EditSeq=${state.editSequence}, applied to ${state.appliedToInvoices.length} invoice(s)`
    );

    // ── Step 2: merge the new application into the list ────────────────────
    const merged = [...state.appliedToInvoices];
    const existingIdx = merged.findIndex(
      (a) => a.invoiceId === payload.invoiceId
    );
    if (existingIdx >= 0) {
      merged[existingIdx] = {
        invoiceId: payload.invoiceId,
        amount: newAmount,
      };
    } else {
      merged.push({ invoiceId: payload.invoiceId, amount: newAmount });
    }

    // ── Step 3: send the Mod with full list ────────────────────────────────
    const enqueueRes = await bridgeFetch(
      "POST",
      `/api/payments/${payload.creditTxnId}/merge-apply`,
      {
        customerId: payload.customerId,
        editSequence: state.editSequence,
        applications: merged,
        ...(payload.memo !== undefined ? { memo: payload.memo } : {}),
      }
    );

    const operationId: string = enqueueRes?.operationId;
    if (!operationId) {
      throw new Error("Bridge did not return operationId for merge-apply");
    }

    // Notify caller that the operation is enqueued so it can write a `submitted`
    // pipeline row before we block on polling. This prevents orphaned `pending` rows
    // if the process crashes during the poll.
    if (payload.onQueued) {
      await payload.onQueued(operationId);
    }

    // ── Step 4: poll for Mod completion to capture new EditSequence ────────
    const modResult = await pollOperationResult(operationId, log);
    const newEditSequence = modResult.editSequence || null;

    return {
      success: true,
      data: {
        operationId,
        newEditSequence,
        totalAppliedCount: merged.length,
      },
    };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * Applies a QB Credit Memo to an Invoice by creating a new ReceivePayment (Add)
 * with SetCredit. Used when customer_payment.type === 'credit_memo'.
 * Unlike mergeApplyPaymentInQb, this does NOT query an existing ReceivePayment —
 * the creditMemoTxnId belongs to a CreditMemo record, not a ReceivePayment.
 */
export async function applyCreditMemoToInvoiceInQb(payload: {
  customerId: string;
  creditMemoTxnId: string;
  invoiceTxnId: string;
  amount: number;
  refNumber?: string;
  memo?: string;
  log?: (msg: string) => void;
  onQueued?: (operationId: string) => Promise<void>;
}): Promise<QbBridgeResult<MergeApplyResult>> {
  const log = payload.log ?? console.log;

  if (DRY_RUN) {
    log(
      `[QB DRY RUN] Would apply credit memo ${payload.creditMemoTxnId} to invoice ${payload.invoiceTxnId}`
    );
    return {
      success: true,
      dryRun: true,
      data: { operationId: "DRY_RUN", newEditSequence: null, totalAppliedCount: 1 },
    };
  }

  try {
    const enqueueRes = await bridgeFetch("POST", "/api/payments", {
      customerId: payload.customerId,
      totalAmount: 0,
      invoiceId: payload.invoiceTxnId,
      paymentAmount: 0,
      creditTxnId: payload.creditMemoTxnId,
      amount: payload.amount,
      ...(payload.refNumber ? { refNumber: payload.refNumber } : {}),
      ...(payload.memo ? { memo: payload.memo } : {}),
    });

    const operationId: string = enqueueRes?.operationId;
    if (!operationId)
      throw new Error("Bridge did not return operationId for credit-memo apply");

    if (payload.onQueued) {
      await payload.onQueued(operationId);
    }

    const addResult = await pollOperationResult(operationId, log);
    return {
      success: true,
      data: {
        operationId,
        newEditSequence: addResult?.editSequence || null,
        totalAppliedCount: 1,
      },
    };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * Unapplies a payment from a specific invoice in QuickBooks.
 * This instructs QBXML to send a ReceivePaymentMod setting the PaymentAmount for the target invoice to 0.00.
 * Requires the EditSequence to be supplied (fetch via query first).
 */
export async function unapplyPaymentFromInvoiceInQb(payload: {
  creditTxnId: string;
  invoiceId: string;
  editSequence: string;
}): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    console.log(
      `[QB DRY RUN] Would unapply payment ${payload.creditTxnId} from invoice ${payload.invoiceId} (Seq: ${payload.editSequence})`
    );
    return { success: true, dryRun: true, data: { operationId: "DRY_RUN" } };
  }

  try {
    const data = await bridgeFetch(
      "POST",
      `/api/payments/${payload.creditTxnId}/unapply`,
      {
        invoiceId: payload.invoiceId,
        EditSequence: payload.editSequence,
      }
    );
    const operationId = data?.operationId;
    if (!operationId)
      throw new Error(
        "Bridge did not return an operationId for unapply-payment"
      );
    return { success: true, data: { operationId } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
