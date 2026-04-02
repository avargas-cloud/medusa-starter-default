# Document Numbering System
> **Type**: Technical Reference
> **Repo**: backend
> **Last verified**: 2026-04-02
> **Status**: Current

---

## What it is and why it exists

The document numbering system assigns human-readable sequential numbers to POS estimates and orders. These numbers appear on printed documents and in the POS UI:

- **Estimates (Draft Orders)**: `E{display_id}` — e.g., `E1268`
- **Orders (Placed Orders)**: `S{sequence}` — e.g., `S1042`

Numbers are stored in `order.metadata.document_number`. The system is implemented as a **subscriber** that reacts to Medusa order events.

---

## Architecture

```
order.updated (with status=draft) → document-number-subscriber
    → metadata.document_number = "E{display_id}"  (if not already set)

order.placed → document-number-subscriber
    → SELECT nextval('custom_order_seq')
    → metadata.document_number = "S{seq}"
    → metadata.original_estimate_number = "E{old}" (if converted from estimate)
```

The subscriber runs via an atomic JSON merge (`COALESCE(metadata, '{}') || $1::jsonb`) to avoid race conditions with other subscribers writing to metadata simultaneously.

---

## Estimate Numbering (`E-prefix`)

Estimates use Medusa's built-in `display_id` field (auto-incremented by Medusa itself). The subscriber simply formats it:

```
document_number = "E" + order.display_id
```

This means `E1268` = draft order with `display_id = 1268`. No custom sequence is needed — Medusa manages this.

### Why not use a custom sequence for estimates?

The code comments explain: a custom sequence (`custom_estimate_seq`) was previously used but caused **sequence gaps** when POS orders bypassed the QB estimate step (converted directly to Sales Receipts without going through QuickBooks as an Estimate first). Using Medusa's native `display_id` avoids this problem.

---

## Order Numbering (`S-prefix`)

Orders use a **PostgreSQL custom sequence** (`custom_order_seq`):

```sql
SELECT nextval('custom_order_seq')
```

The result is formatted as `S{number}`. This is separate from Medusa's `display_id` to allow independent numbering of Sales Orders that doesn't depend on the draft order numbering.

### Conversion tracking

When a draft order (estimate `E1268`) is placed as an order:
1. The new `S{seq}` number is assigned
2. The old estimate number is preserved as `metadata.original_estimate_number = "E1268"`

This allows tracing a Sales Order back to its original estimate.

---

## Tax Fix Subscriber

A separate subscriber (`tax-fix-subscriber.ts`) fires on the same events to remove **duplicate tax lines** created when both the POS Tax Provider and Medusa's native tax engine both create tax lines:

- Fires on: `order.placed`, `order-edit.confirmed`
- Action: `DELETE FROM order_line_item_tax_line WHERE code NOT IN ('FL', 'FL-SHIPPING', 'EXEMPT')`
- Always soft-fails — never blocks the order flow

**Why this is necessary**: Medusa's native tax engine can create a `"manual"` tax line alongside the POS tax provider's `"FL"` line, causing double-counting in the admin UI. The subscriber cleans up the duplicate.

**Important limitation**: `order_line_item_tax_line` stores only the tax rate, not the dollar amount. The dollar amount shown in Medusa admin is computed as `rate × unit_price × qty`, which ignores discounts. The POS UI uses `metadata.computed_total` (set by the POS `computeTotals` function) which correctly accounts for discounts.

---

## Google OAuth Deduplication Subscriber

`google-oauth-dedup.ts` fires on `customer.created` and prevents duplicate accounts when a customer logs in with Google OAuth for an email that already exists.

**Flow:**
1. New customer created via Google OAuth
2. Subscriber finds existing customer with same email
3. Re-links `auth_identity` record to the existing (master) customer
4. Reassigns any orders from new → master customer
5. Soft-deletes the duplicate new customer

**Soft-fails**: never blocks customer creation, only logs errors if dedup fails.

---

## Subscriber List Reference

| File | Events | Purpose |
|------|--------|---------|
| `document-number-subscriber.ts` | `order.updated`, `order.placed` | Assigns E/S document numbers |
| `tax-fix-subscriber.ts` | `order.placed`, `order-edit.confirmed` | Removes duplicate tax lines |
| `google-oauth-dedup.ts` | `customer.created` | Merges duplicate OAuth accounts |
| `auto-capture-web-payment.ts` | payment events | Auto-captures web payments |
| `customer-meilisearch-sync.ts` | customer events | Syncs customer data to MeiliSearch |
| `finance-payment-captured.ts` | payment events | Records payment in finance ledger |
| `finance-refund-created.ts` | refund events | Records refund in finance ledger |
| `order-notifications.ts` | order events | Sends email notifications |
| `product-thumbnail-sync.ts` | product events | Syncs thumbnails |
| `protect-managed-options.ts` | product option deleted | Logs post-deletion (cannot block) |
| `qb-draft-order-subscriber.ts` | order events | Queues draft orders for QB sync |
| `qb-metadata-init-subscriber.ts` | order events | Initializes QB metadata fields |
| `qb-order-subscriber.ts` | order events | Queues orders for QB sync |
| `qb-payment-subscriber.ts` | payment events | Queues payments for QB sync |

---

## Key Files

| Type | Full Path | Purpose |
|------|-----------|---------|
| Document Numbering | `backend/src/subscribers/document-number-subscriber.ts` | E/S number assignment |
| Tax Fix | `backend/src/subscribers/tax-fix-subscriber.ts` | Duplicate tax line cleanup |
| OAuth Dedup | `backend/src/subscribers/google-oauth-dedup.ts` | Google OAuth account deduplication |

---

## Rules

- **Never** reset `custom_order_seq` in production — it would cause duplicate document numbers
- The subscriber checks `if (meta.document_number) return` — numbers are assigned once and never changed (immutable after first assignment)
- Conversion tracking (`original_estimate_number`) is preserved by the patch object before the update
- `workerMode: "shared"` in `medusa-config.ts` is **critical** — without it subscribers do not load
