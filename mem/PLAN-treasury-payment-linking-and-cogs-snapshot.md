# PLAN — Treasury: link every payment to its order + freeze COGS inputs

*Created 2026-05-29 · Owner: a.vargas@ecopowertech.com · Status: IMPLEMENTED + PUSHED (backend bdf25a05, store-pos 6c54f7d). Sandbox-verified. Awaiting Railway prod migration.*

## Origin / user concern

User asked whether `/accounting/treasury` snapshots data per day or recomputes live.
Core worry: a **closed day's COGS must not drift** when product average cost changes
later (from receiving POs). Only edits to invoices/payments **of that day** should move
a day. Over three messages the user surfaced a unifying theme:

> Several payment-capture paths capture real money but do **not** create a real
> `payment_application` link to the order (only `metadata` / `locked_order_id`).
> They must be **truly linked** (the mechanism built ~2026-05-28).

## Findings (current state)

- Treasury is **LIVE recompute** every load. Snapshot table `treasury_distribution_log`
  is audit-only (manual). `daily/route.ts` resolves `__pg_connection__` → `loadDailyReport`.
- COGS for **invoiced** sales is ALREADY frozen: `pos_invoice_item.average_unit_cost`
  captured at invoice creation; treasury reads it first (`load-sales-by-application.ts`
  `COST_FALLBACK_EXPR`).
- **GAP**: the `order_lines` CTE (order-only apps, `invoice_id=null`) sets
  `average_unit_cost = NULL` and reads **live** `product_variant.metadata`
  (`ORDER_COST_FALLBACK_EXPR`, load-sales-by-application.ts:50-54, 116-151). This is the
  only drift source.
- Treasury attributes by day on `customer_payment.received_at`, joining
  `payment_application` (`type='payment'`, `method<>'credit_memo'`).

### Payment-capture paths that create `customer_payment` but NO `payment_application`
1. **Web** — `subscribers/finance-payment-captured.ts` (customer_payment source=web,
   locked_order_id, no application). Web orders **never** get a PosInvoice → permanent
   order-only → permanent live-cost drift. Most important case.
2. **POS order deposit** — `api/admin/orders/[id]/capture-deposit/route.ts` (customer_payment
   source=pos + `order.metadata.deposits[]`, no application). Explicit NOTE says "does NOT
   create a PaymentApplication".
3. **Estimate/draft deposit** — `api/store/draft-orders/capture-deposit/route.ts` (same
   pattern; `order_id` already exists in body).

### QB / AR safety (verified)
- Creating order-only `payment_application` is **SAFE**: order-only apps are never enqueued
  to QB; web orders post to QB via their own path (or not at all); `createPaymentApplications`
  emits no events / triggers no subscriber.
- Rebind: `subscribers/payment-application-rebind.ts` fires on `pos.invoice.created`,
  converts dangling order-only apps to invoice-bound (prorated). Web never invoices → stays
  order-only forever.
- **AR display change**: balance route computes available credit = `amount - Σapplied - refunds`.
  Linking a deposit order-only makes it show as **earmarked to the order** (available credit → 0,
  AR net of deposit) instead of floating credit. This is what "linkear de verdad" means.
- `scripts/fix/fix-web-payments.ts` (deletes web apps) must be **retired** after Pieza 0.

## Decisions (confirmed with user)
- **D1 — rebind cost**: after an order-only deposit is invoiced, Treasury uses the **invoice**
  frozen cost (simple). Day shifts once at invoicing (an invoice event), never from PO receipts.
- **D2 — schema**: store frozen cost as a nullable **JSONB `cost_snapshot`** column on
  `payment_application` (not a child table).
- **D3 — web linking**: YES, auto-create order-only application for web payments.
- Start order: **Pieza 0 (linking) first**, built on the cost_snapshot foundation.

## Implementation plan

### Step 1 — Foundation
- Migration `src/modules/finance/migrations/Migration<ts>.ts`:
  `ALTER TABLE payment_application ADD COLUMN IF NOT EXISTS cost_snapshot jsonb NULL;`
- Model: add `cost_snapshot: model.json().nullable()` to `payment-application.ts`.
- Shared helper `src/lib/finance/build-order-cost-snapshot.ts`:
  `buildOrderCostSnapshot(pg, orderId) → { lines: [{line_id, variant_id, sku, quantity,
  unit_cost_cents, is_china}], captured_at }`. Raw SQL mirroring treasury's order-line cost
  + `is_sourced_via_agent` origin. (pg via `__pg_connection__`.)

### Step 2 — Pieza 0: link captures (web + POS deposit + estimate deposit)
For each of the 3 paths: after `createCustomerPayments`, build snapshot + call
`createPaymentApplications({ payment_id, invoice_id:null, order_id, amount_applied,
applied_at, applied_by, cost_snapshot, metadata:{source} })`.
- Web (finance-payment-captured.ts): amount_applied = full payment; idempotent on
  medusa_payment_id (already guarded). Keep status 'available' (order-only rule).
- Deposits: keep the `order.metadata.deposits[]` snapshot for UI; add the real link.
- No QB enqueue anywhere. Retire `fix-web-payments.ts`.

### Step 3 — Pieza 1: freeze + read
- `handle-order-apply.ts`: capture cost_snapshot on the order-only app.
- `load-sales-by-application.ts` `order_lines` CTE: read per-line cost from the app's
  `cost_snapshot` first; fall back to live metadata only when absent (legacy rows).

### Step 4 — Pieza 2: surface unattributed payments
- Helper `load-unattributed-payments.ts`: type=payment, status<>voided, method<>credit_memo,
  received_at in day, with Σ(non-voided applications) < amount. Return list (customer, amount,
  applied, unapplied, method, source).
- Add `unattributed_payments` to `TreasuryDailyReport` + warning `UNATTRIBUTED_PAYMENTS`.
- Frontend panel on `store-pos/app/(pos)/accounting/treasury/page.tsx`.
- After linking, residual = guest checkout (no customer_id → skipped) + unapplied POS deposits.

### Step 5 — Verify (cero regresiones)
- `yarn type-check`; `verify-*.ts` scripts; destructive tests in Docker **sandbox**
  (`back-sb` 9099) never prod; confirm reconciliation invariant (Σsplits == net cash) holds;
  Verification Report in chat.

## Open notes / risks
- Backfill of historical order-only apps without cost_snapshot: optional best-effort script
  (captures TODAY's cost → stops future drift, does not retro-correct). Treasury keeps live
  fallback for null snapshots.
- Guest web checkout (no customer_id) is skipped by finance-payment-captured → will appear in
  Pieza 2 as unattributed (expected).
- Double-check `amount_applied` clamping for deposits that exceed order total (surplus stays
  available credit, per existing handleOrderApply semantics).
