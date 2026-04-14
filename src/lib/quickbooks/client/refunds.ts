import { DRY_RUN, bridgeFetch, pollOperationResult } from "./core";

export interface RefundSyncPayload {
  refundId: string;
  amount: number;
  originalPaymentTxnId: string;
  customerListId: string;
  bankAccountListId: string;
}

export const qbRefunds = {
  /**
   * Orchestrates a CheckAdd and a zero-dollar ReceivePayment to
   * process a POS refund in QuickBooks.
   */
  async syncRefund(payload: RefundSyncPayload) {
    if (DRY_RUN) {
      console.log(
        `[QB-DRY-RUN] Would sync refund ${payload.refundId} for $${payload.amount}`
      );
      return {
        success: true,
        checkTxnId: "DRY-RUN-CHECK",
        receivePaymentTxnId: "DRY-RUN-RECEIVE-PAYMENT",
      };
    }

    // STEP 1: Create the Check
    const checkData = await bridgeFetch("POST", "/api/sync/enqueue", {
      type: "check",
      action: "add",
      data: {
        AccountRef: { ListID: payload.bankAccountListId },
        PayeeEntityRef: { ListID: payload.customerListId },
        RefNumber: `Ref ${payload.refundId.slice(0, 8)}`,
        Memo: `POS Refund ${payload.refundId}`,
        ExpenseLineAdd: [
          {
            AccountRef: { ListID: "Accounts Receivable" }, // In QB Desktop bridge logic, if ListID is missing it checks FullName, but we should probably use FullName for AR. Let's pass both.
            AccountRefFullName: "Accounts Receivable",
            Amount: payload.amount.toFixed(2),
            Memo: "POS Refund AR offset",
          },
        ],
      },
    });

    if (!checkData.operation_id) {
      throw new Error("Bridge did not return an operation_id for Check sync");
    }

    const checkResult = await pollOperationResult(checkData.operation_id);

    if (
      (checkResult as any).status === "failed" ||
      (!(checkResult as any).result?.checkTxnId &&
        !(checkResult as any).result?.CheckRet?.TxnID)
    ) {
      // In QBXML, CheckRet has TxnID. The operation queue maps it to txnId. Let's extract properly:
      const checkTxnIdRaw =
        (checkResult as any).result?.txnId ||
        (checkResult as any).result?.CheckRet?.TxnID ||
        (checkResult as any).txnId;
      if (!checkTxnIdRaw) {
        throw new Error(
          `Check sync failed or did not return TxnID: ${(checkResult as any).error}`
        );
      }
    }

    // Wait! The operation-queue's polling returns { status: 'completed', txnId: '...', result: ... }
    // We know that `bridgeFetch` for `/api/sync/status` returns { status, result, error, txnId }.
    // Let's use `checkResult as any` to grab `txnId`
    const checkTxnId =
      (checkResult as any).txnId ||
      (checkResult as any).result?.CheckRet?.TxnID;

    // STEP 2: Create the ReceivePayment zero-dollar application
    const rpData = await bridgeFetch("POST", "/api/sync/enqueue", {
      type: "receive-payment",
      action: "add",
      data: {
        customerId: payload.customerListId,
        totalAmount: "0.00",
        paymentAmount: "0.00",
        amount: "0.00",
        invoiceId: checkTxnId,
        creditTxnId: payload.originalPaymentTxnId,
        memo: `POS Refund Application ${payload.refundId}`,
      },
    });

    if (!rpData.operation_id) {
      throw new Error(
        "Bridge did not return an operation_id for ReceivePayment sync"
      );
    }

    const rpResult = await pollOperationResult(rpData.operation_id);
    if ((rpResult as any).status === "failed") {
      throw new Error(
        `ReceivePayment sync failed in QuickBooks: ${(rpResult as any).error}`
      );
    }

    const rpTxnId =
      (rpResult as any).txnId ||
      (rpResult as any).result?.ReceivePaymentRet?.TxnID;

    return {
      success: true,
      checkTxnId: checkTxnId,
      receivePaymentTxnId: rpTxnId,
    };
  },
};
