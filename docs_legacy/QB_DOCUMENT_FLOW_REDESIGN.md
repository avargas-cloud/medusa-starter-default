# QB Document Flow Redesign — IMPLEMENTED

**Status:** FULLY IMPLEMENTED (March 2026)

**Last Updated:** 2026-03-28

**Area:** POS & QuickBooks Order Flow Architecture

---

## Overview

This document describes the **actual implemented** QuickBooks document flow for all order types (Web, POS, Estimates, etc.). The flow has been optimized to:
- Eliminate unnecessary QB documents
- Prevent race conditions in async processing
- Handle POS customers immediately when they purchase with payment
- Delay Sales Order creation for unconfirmed POS estimates

---

## Implemented Decision Tree

### 1. Web Order (order.placed)

```
order.placed event
└── Web channel?
    └── YES → handleOrderPlaced (subscriber)
        └── Create Sales Order immediately in QB ✅
        └── Write to qb_order_pipeline (step='sales_order', status='submitted')
```

**Rationale:** Web orders are deliberate purchases — always create a Sales Order immediately.

---

### 2. POS Order (order.placed, POS channel)

```
order.placed event
└── POS channel?
    ├── YES → isPosOrder() check in subscriber
    │   └── SKIP subscriber (order not processed yet)
    │       └── Wait for qb-pos-sync cron (every 30 min)
    │
    └── qb-pos-sync cron
        └── Order created 1-24 hours ago?
            ├── YES + NO qb_sales_order_txn_id + NO in-flight op?
            │   └── handleOrderPlaced(isCron=true) → Create Sales Order
            │       └── Write to qb_order_pipeline
            │
            └── Otherwise: skip (already processed or too recent)
```

**Why the delay?** POS walk-in customers often take products immediately, triggering fulfillment + payment within seconds. Creating a Sales Order for 1 second (before it's converted to Invoice) is wasteful. The 1-hour grace period allows:
- Walk-in purchases to complete the full flow (Order → Fulfillment → Payment → Invoice)
- Unconfirmed estimates to sit for analysis before syncing
- Manual intervention if the customer cancels

**Race Condition Prevention:** The cron checks `hasPendingInvoiceOp()` — if a Sales Receipt or Invoice is already submitted to the bridge and not yet confirmed, the cron skips Sales Order creation.

---

### 3. POS Estimate / Draft Order

```
order.created (with status='draft')
└── NEVER fires 'draft_order.created' event in Medusa v2

    Instead:
    └── qb-pos-sync cron (every 30 min, 1-24h window)
        └── is_draft_order=true?
            ├── YES + NO qb_estimate_txn_id?
            │   └── handleDraftOrderCreated(isCron=true) → Create QB Estimate
            │       └── Write to qb_order_pipeline (step='estimate')
            │
            └── Otherwise: skip (already has estimate, or not a draft)

    BUT if draft is confirmed (convert-force):
    └── is_draft_order=false (set on same record)
        └── Cron's `WHERE is_draft_order=true` excludes it
            └── No QB Estimate created (correct! It's now a real order with SO)
```

**Why this works:**
- Medusa v2 has no native `draft_order.created` event (it's dead code in the subscriber)
- Estimates are only created via the cron after 1+ hour
- This prevents QB Estimates for estimates that are immediately confirmed
- If a draft is converted via `convert-force`, the `is_draft_order` flag changes, and the cron skips it

---

### 4. POS Sales Receipt (Full Payment, Immediate Fulfillment)

```
pos.sales_receipt.created event (or fulfillment_created for POS)
└── Sales Receipt Qualification Guard:
    ├── Check if order has existing qb_sales_order_txn_id → YES
    │   └── Fall back to handleFulfillmentCreated
    │       └── Create QB Invoice (linked to Sales Order) instead ✅
    │
    ├── Check if order has existing qb_estimate_txn_id → YES
    │   └── Fall back to handleFulfillmentCreated
    │       └── Create QB Invoice (linked to Estimate) instead ✅
    │
    └── No existing SO or Estimate?
        └── processSalesReceiptInQb()
            └── Create QB Sales Receipt ✅
            └── Set qb_so_txn_id = "SKIPPED_SALES_RECEIPT" (sentinel)
            └── Write to qb_order_pipeline (step='sales_receipt', status='submitted')
```

**Rationale:**
- If a Sales Receipt is created but the cron already created a Sales Order, creating both is redundant
- The guard detects this race condition and creates an Invoice instead (linked to the SO)
- The sentinel `SKIPPED_SALES_RECEIPT` prevents the cron from creating a duplicate Sales Order later
- This maintains QB document integrity: Orders → Invoices, never duplicate SO + SR

**Example race condition prevented:**
1. POS order created at 11:55am
2. Cron runs at 12:00pm → Creates Sales Order (order is 5 minutes old, within 1-24h window)
3. Customer takes product immediately → `order.fulfillment_created` fires
4. Handler tries to create Sales Receipt → **Guard detects SO**, creates Invoice instead
5. Result: One QB SO → One QB Invoice (correct) ❌ NOT: SO + Sales Receipt + Invoice

---

### 5. POS Invoice (Partial Payment, or Non-Immediate)

```
order.fulfillment_created (POS order)
└── is_sales_receipt=false (partial or deferred payment)?
    └── handleFulfillmentCreated()
        ├── Check for qb_sales_order_txn_id
        │   ├── YES → Create QB Invoice (linked to Sales Order)
        │   └── NO → Skip (will be retried by cron once SO is created)
        └── Write to qb_order_pipeline (step='invoice')
```

---

### 6. Pipeline Tracking (New)

```
Every QB handler (Sales Order, Invoice, Sales Receipt, Payment, Estimate, etc.)
└── After submitting to bridge:
    └── writePipelineRow({
        orderId, step, status='submitted', bridgeOpId, payload
    })

    └── qb-pipeline-consolidator cron (every 2 min)
        └── SELECT status='submitted' from qb_order_pipeline LIMIT 50
            ├── GET /api/sync/status/{operationId} from bridge
            ├── If completed:
            │   └── confirmPipelineRow(txnId, refNumber, result)
            │   └── cacheEditSequence(entityType, txnId, editSeq)
            └── If failed:
                └── failPipelineRow(error)
```

**Purpose:**
- Single source of truth for all QB operations
- Avoids repeated DB queries for operation status
- Enables retry logic and audit trails
- Caches EditSequence for subsequent operations on the same QB doc

---

## Metadata Shape Evolution

### Old Shape (Flat, Pre-2026)

```json
{
  "qb_list_id": "ABC123",
  "qb_sales_order_txn_id": "SO-001",
  "qb_sales_order_ref": "6175",
  "qb_estimate_txn_id": "EST-001",
  "qb_invoice_txn_id": "INV-001",
  "qb_payment_txn_id": "PMT-001"
}
```

### New Shape (Nested, 2026+)

```json
{
  "qb_list_id": "ABC123",
  "qb_sales_order": {
    "txn_id": "SO-001",
    "ref_number": "6175",
    "operation_id": "op_xyz",
    "synced_at": "2026-03-28T10:30:00Z"
  },
  "qb_estimate": {
    "txn_id": "EST-001",
    "ref_number": "EST-001",
    "operation_id": "op_abc",
    "synced_at": "2026-03-28T10:25:00Z"
  },
  "qb_invoices": [
    {
      "txn_id": "INV-001",
      "ref_number": "INV-001",
      "operation_id": "op_def",
      "synced_at": "2026-03-28T10:35:00Z"
    }
  ],
  "qb_payments": [
    {
      "txn_id": "PMT-001",
      "ref_number": "PMT-001",
      "operation_id": "op_ghi",
      "synced_at": "2026-03-28T10:40:00Z"
    }
  ]
}
```

**Backward Compatibility:**
- Helper functions in `qb-metadata-types.ts` read both shapes
- Old orders continue to work
- New operations write nested shape
- Gradual migration over time (no bulk update needed)

---

## Sentinels & Flags

| Flag | Value | Meaning | Set By |
|------|-------|---------|--------|
| `qb_so_txn_id` | `"SKIPPED_SALES_RECEIPT"` | Sales Receipt was created directly; don't create SO in cron | `handle-sales-receipt-created.ts` |
| `is_draft_order` | `false` | Draft was converted; cron should not create Estimate | `convert-force` endpoint |
| `pos_created` | `true` | POS marked this order; subscriber skips fulfillment sync | POS frontend (legacy) |

---

## Cron Jobs

### `qb-pos-sync` (every 30 minutes)

Handles delayed Sales Order/Estimate creation for POS orders/estimates not processed immediately.

```
For each POS order/estimate created 1-24 hours ago:
  ├── No qb_sales_order_txn_id?
  ├── No qb_estimate_txn_id?
  ├── No in-flight invoice/sales-receipt (checked via hasPendingInvoiceOp)?
  └── Process via handleOrderPlaced(isCron=true) or handleDraftOrderCreated(isCron=true)
```

### `qb-pipeline-consolidator` (every 2 minutes)

Polls bridge for submitted operations and confirms/fails pipeline rows.

```
For each row in qb_order_pipeline WHERE status='submitted':
  ├── GET bridge for operation status
  ├── If complete: confirmPipelineRow() + cache EditSequence
  ├── If failed: failPipelineRow()
  └── Log to Activity Log
```

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `QB_ORDER_FLOW_ENABLED` | `false` | Master feature flag |
| `QB_BRIDGE_URL` | `https://qb.eptbridge.com` | Bridge endpoint |
| `QB_API_KEY` | — | Bridge auth |
| `POS_SALES_CHANNEL_ID` | — | Identifies POS orders for delayed sync |

---

## Testing Checklist

- [ ] Web order → Sales Order created immediately ✅
- [ ] POS order → Sales Order created after 1+ hour (cron) ✅
- [ ] POS order + immediate fulfillment → Sales Receipt → no SO duplicate ✅
- [ ] POS estimate → QB Estimate created after 1+ hour (cron) ✅
- [ ] POS estimate converted → no QB Estimate (correct) ✅
- [ ] Pipeline rows created for all handlers ✅
- [ ] Consolidator polls and confirms pipeline rows ✅
- [ ] Edit Sequence cached and retrieved ✅
- [ ] Race condition: SR in-flight + SO creation attempt → SO skipped ✅
