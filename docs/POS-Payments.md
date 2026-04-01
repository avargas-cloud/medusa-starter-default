# POS Payments Module

**Last Updated:** 2026-03-29

The Payments module is a customer-level AR (Accounts Receivable) ledger built on top of Medusa v2. Every payment — POS or web checkout — creates a `CustomerPayment` record that can be applied to one or more invoices.

---

## Data Models

### `CustomerPayment` (`customer_payment`)

| Field | Type | Notes |
|---|---|---|
| `id` | `cpay_*` | Primary key |
| `customer_id` | text | Required — no orphan payments |
| `source` | `web \| pos` | Web = created by subscriber; POS = staff created |
| `type` | `payment \| refund \| credit_memo` | Refunds created from CM void → type: `credit_memo` or `refund` |
| `amount` | bigNumber | In cents (USD) |
| `method` | enum | `cash, check, card, ach, zelle, credit_memo, stripe, other` |
| `reference` | text? | Check #, last4, Stripe charge ID, or CM reference |
| `status` | enum | `available, partially_applied, applied, voided` |
| `received_at` | dateTime | |
| `locked_order_id` | text? | Web payments locked to their order |
| `medusa_payment_synced` | boolean | True once registered in Medusa native Payment Module |

### `PaymentApplication` (`payment_application`)

Links a `CustomerPayment` to a specific `PosInvoice`. One payment can fund multiple invoices.

| Field | Type | Notes |
|---|---|---|
| `id` | `papp_*` | Primary key |
| `payment` | belongsTo `CustomerPayment` | |
| `invoice_id` | text? | Null for web orders (no PosInvoice) |
| `order_id` | text | Always set — denormalized for AR reporting |
| `amount_applied` | bigNumber | Portion of payment used here |
| `applied_at` | dateTime | |
| `voided_at` | dateTime? | Set when application is reversed |

---

## Status Flow

```
available → partially_applied → applied
         ↘              ↗
              voided
```

- **available** — deposit received, not yet applied
- **partially_applied** — some credit used, remainder available
- **applied** — fully consumed
- **voided** — cancelled (before or without use)

---

## Backend API (`/admin/customer-payments`)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/admin/customer-payments` | All payments, enriched with customer name + computed balances |
| `POST` | `/admin/customer-payments` | Create standalone payment (`status: available`) |
| `GET` | `/admin/customer-payments/:id` | Single payment with applications + invoice details |
| `POST` | `/admin/customer-payments/:id/apply` | Apply available balance to an invoice |
| `POST` | `/admin/customer-payments/:id/refund` | Full void or partial refund of available balance |

### POST `/admin/customer-payments`

```json
{
  "customer_id": "cus_xxx",
  "amount": 50000,
  "method": "check",
  "reference": "1042",
  "notes": "Deposit for large order",
  "received_at": "2026-03-18T10:00:00Z",
  "created_by": "staff@company.com"
}
```

### POST `/:id/apply`

```json
{ "invoice_id": "pinv_xxx", "amount": 25000, "applied_by": "staff@company.com" }
```

Validates: amount ≤ available balance, invoice not voided. Updates invoice `balance_due` and payment `status`.

### POST `/:id/refund`

```json
{ "amount": 10000, "notes": "Customer cancelled", "voided_by": "staff@company.com" }
```

If `amount` omitted → voids full available balance. Partial refund creates a new `CustomerPayment` of `type: refund`.

---

## How Payments Are Created

### POS Manual Payment

`POST /admin/invoices/:id/payments` (invoice payment flow) creates:
1. `CustomerPayment` (status: `applied`, source: `pos`)
2. `PaymentApplication` linking to the invoice
3. `InvoicePayment` (historic record)
4. Updates invoice `balance_due` and `status`
5. Registers in Medusa native Payment Module (best-effort)

### Standalone Deposit

`POST /admin/customer-payments` creates a `CustomerPayment` with `status: available`. Staff then applies it later via `POST /:id/apply`.

### Web Checkout

The `orderCreated` hook in `maintain-cart-prices.ts` fires synchronously during `completeCartWorkflow` → creates `CustomerPayment` (source: `web`, status: `available`, locked to the order via `locked_order_id`). The `order.payment_captured` subscriber skips web orders entirely.

---

## Frontend (`ecopowertech-store-pos`)

| Route | Description |
|---|---|
| `/payments` | List of all payments — search, filter by status, sort |
| `/payments/:id` | Detail: balance summary, credit statement, apply/refund actions |
| `/capture-payment` | Redirect → `/payments` |

### Payment Methods — System Defaults

As of April 2026, the list of payment methods shown in all payment modals is **no longer hardcoded**. It is fetched from system-defaults at runtime by the shared hook `hooks/usePaymentMethods.ts`.

- **Source:** `GET /admin/system-defaults` → `context = "Payment Methods"`
- **Hook:** `hooks/usePaymentMethods.ts` — returns `{ id, label, icon, ledger_method, qb_method }[]`
- **Fallback:** If the API fails, the full hardcoded list is used automatically
- **Cache:** Module-level — one fetch per browser session
- **Admin UI:** System Defaults → Payment Methods section (add/edit/delete methods)

Components that use the hook:
- `CapturePaymentModal.tsx`, `CaptureDepositModal.tsx`
- `ChangePaymentMethodModal.tsx` (also derives `ledger_method` from hook)
- `complete-order/PaymentSection.tsx`
- `transactions/new/page.tsx`

### Key Components (`components/pos/payments/`)

| File | Role |
|---|---|
| `PaymentHeader.tsx` | Header strip: customer name, status, prev/next nav, action buttons |
| `PaymentSummaryCard.tsx` | Left panel: balance stats, details, customer info |
| `CreditStatement.tsx` | Right panel: applications table with running balance + void reversals |
| `CustomerSelectModal.tsx` | MeiliSearch customer picker (shown before New Payment) |
| `ApplyCreditModal.tsx` | Pick invoice + amount → POST `/:id/apply` |
| `RefundModal.tsx` | Enter amount + notes → POST `/:id/refund` |

### Shared Library (`lib/payments.ts`)

- Types: `CustomerPayment`, `PaymentApplication`, `PaymentMethod`, `PaymentStatus`
- Display maps: `METHOD_LABELS`, `STATUS_COLORS`, `STATUS_LABELS`
- Nav utils: `savePaymentNavList`, `getPaymentNavList` (localStorage)
- API helpers: `fetchPayments`, `fetchPayment`, `createPayment`, `applyCredit`, `refundPayment`

---

## Credit Memo Refunds & Payment Voids

### Credit Memo Complete

When a credit memo is **completed**, a new `CustomerPayment` is created:

```typescript
// CM complete flow:
const refundPayment = await customerPaymentService.create({
    customer_id: order.customer_id,
    type: 'credit_memo',          // or 'refund' depending on context
    amount: cm.refunded_amount,    // Total refunded (cents)
    method: 'credit_memo',
    status: 'available',           // Refund credit is available to re-apply
    reference: cm.id               // Link back to credit memo
})
```

Additionally, if the CM references a Sales Receipt in QB:

```typescript
// SR-linked CM gets specific metadata:
qb_source: 'sales_receipt'  // Tracks that refund originated from SR
```

### Credit Memo Void

When a credit memo is **voided**, its associated `CustomerPayment` is marked as `voided`:

```typescript
// CM void flow:
const refundPayment = await getPaymentByCreditMemoId(cm.id)
if (refundPayment) {
    await customerPaymentService.void(refundPayment.id, {
        reason: 'Credit memo voided'
    })
}
```

**Result:**
- Status: `voided` with `voided_at` timestamp
- No longer available for application
- UI shows reversal in ledger (negative line)

This ensures the finance ledger stays consistent: a voided CM means its refund credit is no longer valid.

---

## Visual Ledger & Void Reversals

The `CreditStatement.tsx` component renders the full financial history with special handling for voided applications:

```tsx
const ledgerLines: any[] = []
allApps.forEach((app: any) => {
    // Línea real:
    ledgerLines.push({
        id: app.id,
        type: 'application',
        date: app.applied_at,
        changeAmt: Number(app.amount_applied) // Reduce el balance (Resta)
    })

    // Si la DB tiene `voided_at`, creamos artificialmente una Línea Reversal
    if (app.voided_at) {
        ledgerLines.push({
            id: app.id + '_void',
            type: 'void',
            date: app.voided_at,
            changeAmt: -Number(app.amount_applied) // Vuelve a Sumar (Matemática Reversa)
        })
    }
})
```

**Result:** The UI traces the money's full journey:
1. Deposit received: `$500 available`
2. Applied to Invoice A: `$300 → Invoice, $200 available`
3. Deposit voided: `$500 returned → $700 available`

Each transition appears as a separate line in the ledger, creating an audit trail.

---

## Transaction ID & Event Bus

### Event Bus Coordination

The `/admin/finance/payments` endpoints emit events for QuickBooks sync:

```typescript
// After saving payment successfully:
await eventBus.emit({
    name: "pos.payment.created",  // or "pos.payment.applied"
    data: { id: paymentId }
})
```

**Benefit:** Background subscribers can:
- Detect which invoice was paid
- Queue QB Receive Payment without blocking the UI
- Retry independently if QB Bridge is down

### Transaction ID Grouping

When a cashier clicks "Complete Order", the UI generates a `transaction_id`:

```typescript
// Frontend:
const txn_id = generateId()  // base36 format: txn_01H...

// All payments created in this transaction carry:
metadata: { transaction_id: txn_id }
```

**Discovery:**
- `/transactions/:id` endpoint reconstructs the transaction from related payments
- UI shows: "Ref No. 1042X" (human-readable decoded ID)
- Avoids UUIDs in customer receipts

---

## Multi-Payments & Store Credits

### Dynamic Input Capping

When a customer pays with mixed methods (e.g., $200 cash + $50 store credit):

```typescript
// Order total: $250
// Store credit available: $50
// Required cash: $200

// UI behavior:
const requiredCashCents = (total - storeCredit) * 100
// Cash input max capped at requiredCashCents
// % buttons calculate based on remaining balance only
```

### Multi-Source Display

If an invoice receives funds from multiple sources:
- List view: Badge shows `"Mixed"` or `"Multiple"`
- Detail view: `payment_applications` array shows each source with amount
- Connected to transaction receipt via `transaction_id`

---

## Recent Enhancements

### Multi-Payments in Invoice UI

**Problema:**
Previamente la tabla principal de Invoice List y la vista detallada Invoice Receipt intentaban deducir el "Payment Method" asumiendo que un Invoice recibía un sólo pago global, lo cual fallaba si el cliente usaba 50% Cash y 50% Store Credit. Adicionalmente, el `CompleteOrderModal` permitía ingresar montos aleatorios superiores a la deuda en "Cash" causando desajustes contables.

**Solución Implementada:**
1. **Recorte Dinámico de Inputs (Cap):** Las barras de Cash / Card de todos los UI limits (CompleteOrder, CapturePayment) ahora están limitadas lógicamente por un `requiredCashCents`. Si la orden totaliza $1000 y el usuario selecciona $200 de crédito a favor, las cajas limitarán la escritura de montos externos a máximo $800, y los botones de "%" calcularán base a los $800 restantes.
2. **Display Compuesto por Transactions:**
   - Si un Invoice recibe fondos de más de 1 fuente, la columna de listado `/invoices` ahora renderizará `Mixed` u `Other` en el badge de Payments para protegerse.
   - En la vista individual `[/id]`, el array de `payment_applications` se mapea renderizando renglones detallados de "Store Credit Application - ID", así como "Deposit Application" en verde antes de totalizar el gran Total.
   - Al estar unificados bajo un `transaction_id`, el Invoice puede navegar hacia el recibo transaccional de `/transactions/:id` detallando el origen genésico de los fondos y en cuales otras facturas impactaron dichos fondos al mismo tiempo.

---

## Files Reference

```
backend/src/
  api/admin/
    customer-payments/
      route.ts              GET list, POST create
      [id]/
        route.ts            GET detail
        apply/route.ts      POST apply credit
        refund/route.ts     POST refund / void
    pos/sync/route.ts       Finance + QB sync
  modules/finance/
    models/
      customer-payment.ts
      payment-application.ts
    services/
      customer-payment.service.ts
  subscribers/
    finance-payment-captured.ts   Web payment sync

ecopowertech-store-pos/
  app/(pos)/payments/
    page.tsx                List page
    [id]/page.tsx           Detail page (orchestrator)
  components/pos/payments/
    PaymentHeader.tsx
    PaymentSummaryCard.tsx
    CreditStatement.tsx     ← Void reversal logic
    CustomerSelectModal.tsx
    ApplyCreditModal.tsx
    RefundModal.tsx
  lib/payments.ts           Shared types + API helpers
```

---

## Integration with Credit Memos

When a credit memo workflow completes:

1. **PosInvoice Update:** `refunded_amount`, `refunded_shipping` incremented
2. **PosInvoiceItem Update:** `refunded_quantity` incremented
3. **Finance Ledger:** `CustomerPayment` created (type: `credit_memo`)
4. **QB Sync:** Pipeline row written (step: `credit_memo`, async)
5. **Invoice Status:** Auto-transition to `partially_refunded` or `refunded`

When a credit memo is voided:

1. **Inventory Reversal:** Restock quantities
2. **Finance Ledger:** `CustomerPayment` marked `voided`
3. **QB Void:** Pipeline row written (step: `void_credit_memo`, async)
4. **PosInvoice Restore:** `refunded_amount`, `refunded_shipping` decremented
5. **PosInvoiceItem Restore:** `refunded_quantity` decremented
6. **Invoice Status:** Back to `paid`, `partial`, or `issued`

See [POS_INVOICES.md § 3–4](./POS_INVOICES.md#3-credit-memo-complete-flow) for complete CM flow documentation.
