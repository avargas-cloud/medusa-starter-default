import { DRY_RUN, bridgeFetch } from "./core";
import { QbBridgeResult, QbAsyncResult } from "./types";

/**
 * Reassigns the customer on a QB document (SO or Invoice).
 * Called when Medusa fires a "Transfer Ownership" on an order.
 *
 * @param docType       - 'sales-order' | 'invoice'
 * @param txnId         - QB TxnID of the document
 * @param editSequence  - Fetch this first via GET /api/<docType>/:txnId
 * @param newCustomerId - New customer QB ListID
 */
export async function transferDocumentCustomer(
  docType: "sales-order" | "invoice",
  txnId: string,
  editSequence: string,
  newCustomerId: string,
  log: (msg: string) => void = console.log
): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    log(
      `[QB DRY RUN] Would transfer ${docType} ${txnId} to customer ${newCustomerId}`
    );
    return { success: true, dryRun: true, data: { operationId: "DRY_RUN" } };
  }

  try {
    const endpoint =
      docType === "sales-order" ? "/api/sales-orders" : "/api/invoices";
    const data = await bridgeFetch("PATCH", `${endpoint}/${txnId}/customer`, {
      customerId: newCustomerId,
      EditSequence: editSequence,
    });
    const operationId = data?.operationId;
    if (!operationId)
      throw new Error(
        `Bridge did not return operationId for ${docType} customer transfer`
      );
    log(
      `[QB] ${docType} ${txnId} customer transfer queued → ${newCustomerId} (op: ${operationId})`
    );
    return { success: true, data: { operationId } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
