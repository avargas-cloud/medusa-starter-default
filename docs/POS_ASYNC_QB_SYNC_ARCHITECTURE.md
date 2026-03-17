# POS & QuickBooks Async Sync Architecture (2026 Update)

**Date:** March 2026
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

1. **`order.placed` & `draft_order.created` (Subscriber Guard):**
   - When a web order is placed, the subscriber creates the Sales Order immediately.
   - When a **POS order** is placed, the subscriber detects `isPosOrder(order)` by checking the Sales Channel ID or the metadata flag.
   - **Result:** The subscriber intentionally **SKIPS** creating the Sales Order or Estimate, giving it a 1-hour grace period.

2. **`order.fulfillment_created` (Direct Invoices):**
   - If a POS order is fulfilled immediately (customer takes the product), this event fires.
   - The subscriber attempts to find the linked QuickBooks Sales Order. It won't find one.
   - **Result:** Instead of failing, the subscriber now queries `query.graph` to fetch all line items and discounts, and generates a **Standalone Invoice** directly in QuickBooks.

3. **`order.payment_captured` (Immediate Receipts):**
   - Plays nice with the Standalone Invoice. Logs the payment against the newly created Invoice immediately.

### The Scheduled Job (`qb-pos-sync.ts`)

For POS orders that are **not** fulfilled immediately (e.g., store delivery for tomorrow, or unconfirmed estimates):

- **Cron Schedule:** Runs every 30 minutes (`*/30 * * * *`).
- **Query:** Looks for POS Orders and Draft Orders created **between 1 hour and 24 hours ago**.
- **Condition:** Checks if `metadata.qb_invoices` is empty (meaning no Standalone Invoice was generated).
- **Execution:** Calls the same subscriber logic (`handleOrderPlaced` with an `isCron=true` bypass flag) to finally generate the Sales Order or Estimate in QuickBooks.
- **Logs:** This job uses `QbSyncLogger`, meaning its executions **will appear in the Medusa Admin > QuickBooks > Sync UI** under the "pos_async_sync" operation name.

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
