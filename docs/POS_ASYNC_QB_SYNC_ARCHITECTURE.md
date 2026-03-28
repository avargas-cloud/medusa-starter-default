# POS & QuickBooks Async Sync Architecture (2026 Update)

**Date:** March 2026
**Last Updated:** 2026-03-28
**Area:** Medusa Backend / QuickBooks Bridge Integration

## Overview
This document details the architectural shift made to handle Point of Sale (POS) orders, estimates, invoices, and payments in QuickBooks, specifically addressing the requirement to **delay Sales Order creation** for walk-in store customers while allowing immediate payment syncing. It also covers the logic implemented for handling order-level vs. item-level discounts.

---

## 1. Discount Logic in QuickBooks

Medusa supports two types of discounts for QuickBooks synchronization:

### A. Item-Level Discounts (Promotions applied to specific products)
- **Logic:** Handled seamlessly by using the item's discounted `subtotal` divided by `quantity` as the unit price. 
- **QuickBooks Impact:** The item line in QuickBooks will simply show the lower unit price. There is no explicit "Discount" line item.
- **Why:** Avoids polluting the QB invoice with micro-discounts per line, keeping the itemized list clean.

### B. Order-Level Discounts (Cart-wide promotions or coupon codes)
- **Logic:** Handled by creating two explicit line items at the very end of the QuickBooks document:
  1. `Subtotal`: A special QuickBooks Item type that automatically sums all lines above it.
  2. `Discount`: An explicit negative amount line containing the **exact dollar value** of the discount calculated by Medusa.
- **QuickBooks Impact:** Ensures precision. By sending exact dollars instead of percentages, we avoid any edge cases where QuickBooks rounding creates a mismatch with Medusa's exact totals.
- **Where:** This logic is applied consistently across Estimates (`qb-draft-order-subscriber`), Sales Orders (`qb-order-subscriber.ts`), and Direct Invoices (`order-flow-core.ts`).

---

## 2. POS Async Sync Architecture (1-Hour Delay)

Historically, the POS frontend made immediate HTTP calls to `/admin/quickbooks/order` or `/admin/quickbooks/draft-order` to force QuickBooks syncs. 

This approach was problematic because a walk-in retail customer often takes their products immediately (triggering Fulfillment + Payment). Because QB requires a Sales Order before an Invoice, the old flow generated completely unnecessary Sales Orders that lived for exactly 1 second before being converted to Invoices.

### The New Subscriber Flow

Responsibility for QuickBooks sync has shifted entirely to Medusa Event Subscribers:

1. **`order.placed` (Subscriber Guard):**
   - When a web order is placed, the subscriber creates the Sales Order immediately.
   - When a **POS order** is placed, the subscriber detects `isPosOrder(order)` by checking the Sales Channel ID or the metadata flag.
   - **Result:** The subscriber intentionally **SKIPS** creating the Sales Order, giving it a 1-hour grace period.

2. **`draft_order.created` (Never Fires in Medusa v2):**
   - The `qb-draft-order-subscriber.ts` registers for this event, but **Medusa v2 never emits it**.
   - The `handleDraftOrderCreated` function is invoked **only via the `qb-pos-sync` cron** (after 1+ hour) and via the manual sync endpoint (`POST /admin/pos/sync`).
   - The subscriber configuration is effectively dead code; estimates are created on a delay schedule, not on creation.

3. **`order.fulfillment_created` (Direct Invoices / Sales Receipt Qualification):**
   - If a POS order is fulfilled immediately (customer takes the product), this event fires.
   - **Sales Receipt Qualification Guard (March 2026):** Before creating any QB document, the handler checks if a Sales Order or Estimate already exists on the order.
     - If YES → falls back to creating a **QB Invoice** (linked to the existing SO/Estimate) instead of a Sales Receipt
     - If NO → proceeds to create a **QB Sales Receipt** directly, setting the sentinel `qb_so_txn_id = "SKIPPED_SALES_RECEIPT"` to prevent the cron from creating a duplicate SO
   - **Purpose:** Prevents duplicate QB documents when the cron already processed the order while the fulfillment event was in-flight.

4. **`order.payment_captured` (Receive Payment):**
   - Creates a QB Receive Payment (unapplied credit) when a payment is captured.
   - Logs the payment to the Activity Log and stores `qb_payment_txn_id` in metadata.
   - Plays nicely with the Invoice/Sales Receipt. Links payment to the customer's QB record.

### The Scheduled Jobs

#### 1. `qb-pos-sync` (every 30 minutes)

For POS orders that are **not** fulfilled immediately (e.g., store delivery for tomorrow, or unconfirmed estimates):

- **Cron Schedule:** Runs every 30 minutes (`*/30 * * * *`).
- **Query:** Looks for POS Orders and Draft Orders created **between 1 hour and 24 hours ago**.
- **Conditions:**
  - No `qb_sales_order_txn_id` (not already processed)
  - No in-flight operation: `!hasPendingInvoiceOp()` (no SR or Invoice submitted but not yet confirmed)
- **Execution:** Calls the same subscriber logic (`handleOrderPlaced` or `handleDraftOrderCreated` with an `isCron=true` bypass flag) to finally generate the Sales Order or Estimate in QuickBooks.
- **Logs:** This job uses `QbSyncLogger`, meaning its executions **will appear in the Medusa Admin > QuickBooks > Sync UI** under the "pos_async_sync" operation name.
- **Race Condition Fix (March 2026):** Added `hasPendingInvoiceOp()` check to prevent creating a Sales Order while a Sales Receipt is still being processed by QBWC. Previous bug: cron could create SO while SR was submitted but not confirmed.

#### 2. `qb-pipeline-consolidator` (every 2 minutes)

New cron (March 2026) that polls the bridge for operations submitted to `qb_order_pipeline`:

- **Query:** Finds all rows in `qb_order_pipeline` with `status='submitted'` and `bridge_op_id IS NOT NULL` (limit 50 per run).
- **Polling:** For each row, calls `GET /api/sync/status/{operationId}` on the bridge.
- **Confirmation:**
  - If operation completed: calls `confirmPipelineRow(rowId, txnId, refNumber, result)`
  - Caches the QB EditSequence in `qb_edit_sequence_cache` for future operations
  - Logs to Activity Log (Operation completed)
- **Failure Handling:** If operation failed, calls `failPipelineRow(rowId, errorMessage)` and logs to Activity Log.
- **Runs only when:** `QB_ORDER_FLOW_ENABLED=true`

**Utility Functions:**
```typescript
// Writing to pipeline (called by all QB handlers)
writePipelineRow(input: {
    orderId: string
    referenceName: string  // invoice_id, fulfillment_id, etc.
    referenceType: string  // 'invoice', 'fulfillment', 'sales_receipt'
    step: string          // 'estimate', 'sales_order', 'invoice', 'sales_receipt', 'payment'
    status: 'pending' | 'submitted' | 'confirmed' | 'failed' | 'skipped'
    bridgeOpId?: string
    payload?: any
    submittedAt: Date
})

// Reading from cache (before updating a QB document)
getCachedEditSequence(entityType: string, qbId: string): string | null

// Invalidating cache
invalidateEditSequence(entityType: string, qbId: string): void

// Confirming a row (called by consolidator)
confirmPipelineRow(rowId: string, txnId: string, refNumber: string, result: any)

// Failing a row
failPipelineRow(rowId: string, error: string)
```

---

## 3. Required Frontend Cleanup

Because the backend now natively handles this 1-hour delay and directly generates standalone invoices on fulfillment, the POS frontend codebase no longer needs customized `.fetch()` calls to the QB plugins.

**Actions to take in `ecopowertech-store-pos`:**
1. Remove explicit API calls to `POST /admin/quickbooks/order` upon Checkout confirmation.
2. Remove explicit API calls to `POST /admin/quickbooks/draft-order` upon Estimate creation.
3. The POS should strictly stick to standard Medusa core APIs:
   - Create Order / Draft Order
   - Create Fulfillment
   - Capture Payment
4. The Backend will securely orchestrate everything else.
