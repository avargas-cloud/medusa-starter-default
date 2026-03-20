# POS Transactions Module

## Overview

The Transactions module is a logical grouping mechanism designed to solve the complexity of mixed checkout events. In a comprehensive B2B/Retail POS environment, a single "Checkout" or "Capture Deposit" action by a cashier can generate multiple independent financial records in the backend:
1. Creating a new Store Credit (`CustomerPayment` of type `payment`).
2. Consuming an existing Store Credit (`PaymentApplication` referencing a prior deposit).
3. Paying off multiple specific invoices at once.

To ensure cashiers and managers can view the "big picture" of what happened in front of the customer, all these discrete records are linked together using a shared `metadata.transaction_id` (e.g., `txn_...`).

---

## Data Linkage Architecture

Transactions do not have their own dedicated database table. Instead, they are an aggregation of `CustomerPayment` and `PaymentApplication` records tied together by the same `transaction_id`.

### Generation

1. When a checkout event begins (e.g., clicking "Capture" on a deposit, or "Create Invoice"), the frontend application generates a unique `transaction_id`.
   - The ID uses a friendly reference format tailored for POS receipts (e.g., `txn_01H...`).
2. This `transaction_id` is automatically injected into the `metadata` payload of:
   - `POST /admin/finance/payments`
   - `POST /admin/finance/payments/:id/apply`
3. The event bus (`pos.payment.created`, `pos.payment.applied`) can listen to these events and identify the entire batch if needed for external system syncing (like QuickBooks).

### Properties of a Transaction

When queried on the frontend, the UI aggregates the payments grouped by `transaction_id` to compute the following snapshot:
- **Date:** Extracted from the earliest `created_at` or `received_at` of the grouped payments.
- **Reference Number:** The base36 decoded/friendly representation of the transaction ID.
- **Total Cash Captured:** The sum of all new money received (where `payment.type === 'payment'` and it's not a credit consumption).
- **Store Credits Applied:** The sum of all `payment_applications` that drew from historically existing credits.
- **Invoices Affected:** An array of unique `invoice_id`s that received funds during the transaction, complete with amounts applied and resulting balances.

---

## Frontend Implementation

| Route | Description |
|---|---|
| `/transactions` | The primary list view displaying all historical checkout events. Supports searching by friendly reference ID, amount, and date filtering. |
| `/transactions/:id` | The "Digital Receipt" view. Shows the exact breakdown of cash/card received, specific Store Credits consumed (with their original IDs), and Invoices affected. |

### Key Components

- **`TransactionsTable`**: Aggregates raw `/admin/finance/payments` data. Because the backend doesn't have a `GET /transactions` endpoint, the frontend relies on TanStack Query to fetch payments and group them by `metadata.transaction_id`.
- **`TransactionSummary`**: Displays the high-level totals (Total Cash, Total Credits).
- **`ReceiptBreakdown`**: Iterates over the `applications` and standalone payments to present a printable receipt format for the cashier.

---

## Legacy Records Fallback

For older payments created before the Transactions module was introduced, the frontend gracefully falls back to using the individual `CustomerPayment.id` as the transaction ID. This ensures the Transactions UI remains functional for historical data without requiring complex database migrations.
