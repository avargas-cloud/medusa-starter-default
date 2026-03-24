import { DRY_RUN, bridgeFetch, pollOperationResult } from "./core"
import { QbCreateCustomerPayload, QbBridgeResult } from "./types"

/**
 * Creates a customer in QuickBooks via the Bridge.
 * Customer creation is also async — poll for ListID.
 * Returns the QB ListID to store in customer.metadata.qb_list_id
 */
export async function createCustomerInQb(
    payload: QbCreateCustomerPayload
): Promise<QbBridgeResult<{ listId: string }>> {
    if (DRY_RUN) {
        console.log(`[QB DRY RUN] Would create customer in QB:`, payload.Name)
        return { success: true, dryRun: true, data: { listId: "DRY_RUN_ID" } }
    }

    try {
        const data = await bridgeFetch("POST", "/api/customers", payload)

        // Customer creation may be sync (returns ListID directly) or async (returns operationId)
        const listId = data?.ListID || data?.listId || data?.id
        if (listId) {
            return { success: true, data: { listId } }
        }

        // If async, poll for result
        const operationId = data?.operationId
        if (operationId) {
            const result = await pollOperationResult(operationId)
            const resolvedListId = result.txnId // For customers, txnId is actually the ListID
            if (!resolvedListId) throw new Error("Polling completed but no ListID returned")
            return { success: true, data: { listId: resolvedListId } }
        }

        throw new Error("Bridge did not return a ListID or operationId")
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}
