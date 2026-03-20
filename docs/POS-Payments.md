# POS Payments Module

## Overview

The Payments module is a customer-level AR (Accounts Receivable) ledger built on top of Medusa v2. Every payment — POS or web checkout — creates a `CustomerPayment` record that can be applied to one or more invoices.

---

## Data Models

### `CustomerPayment` (`customer_payment`)

| Field | Type | Notes |
|---|---|---|
| `id` | `cpay_*` | Primary key |
| `customer_id` | text | Required — no orphan payments |
| `source` | `web \| pos` | Web = created by subscriber; POS = staff created |
| `type` | `payment \| refund \| credit_memo` | |
| `amount` | bigNumber | In cents (USD) |
| `method` | enum | `cash, check, card, ach, zelle, credit_memo, stripe, other` |
| `reference` | text? | Check #, last4, Stripe charge ID |
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
Subscriber `finance-payment-captured` fires on `payment.captured` → creates `CustomerPayment` (source: `web`, status: `applied`, locked to the order).

---

## Frontend (`ecopowertech-store-pos`)

| Route | Description |
|---|---|
| `/payments` | List of all payments — search, filter by status, sort |
| `/payments/:id` | Detail: balance summary, credit statement, apply/refund actions |
| `/capture-payment` | Redirect → `/payments` |

### Key Components (`components/pos/payments/`)

| File | Role |
|---|---|
| `PaymentHeader.tsx` | Header strip: customer name, status, prev/next nav, action buttons |
| `PaymentSummaryCard.tsx` | Left panel: balance stats, details, customer info |
| `CreditStatement.tsx` | Right panel: applications table with running balance |
| `CustomerSelectModal.tsx` | MeiliSearch customer picker (shown before New Payment) |
| `ApplyCreditModal.tsx` | Pick invoice + amount → POST `/:id/apply` |
| `RefundModal.tsx` | Enter amount + notes → POST `/:id/refund` |

### Shared Library (`lib/payments.ts`)

- Types: `CustomerPayment`, `PaymentApplication`, `PaymentMethod`, `PaymentStatus`
- Display maps: `METHOD_LABELS`, `STATUS_COLORS`, `STATUS_LABELS`
- Nav utils: `savePaymentNavList`, `getPaymentNavList` (localStorage)
- API helpers: `fetchPayments`, `fetchPayment`, `createPayment`, `applyCredit`, `refundPayment`

---

## Changelog — Marzo 20, 2026

### Introducción del Módulo "Transactions" y Event Bus

**Problema:**
Medusa nativamente y nuestro módulo `CustomerPayment` inicial trataban a todos los pagos como entidades 100% aisladas. Sin embargo, en un ambiente POS uncajero puede seleccionar "Cobrar", y el sistema recibe `$200` en efectivo al mismo tiempo que deduce `$50` de un *Store Credit* previo, todo para apagar el saldo de 2 Invoices diferentes a la vez. Al carecer de una agrupación padre, la auditoría del cierre de caja (o la auditoría del propio recibo físico del cliente) resultaba en líneas huérfanas imposibles de vincular. A su vez, QuickBooks carecía de un *Trigger* centralizado para saber cuándo exportar el abono.

**Solución Implementada:**
1. **El concepto de Transaction ID (`transaction_id`):** En lugar de crear una tabla SQL nueva y masiva, la arquitectura fue abstraída y resuelta elegantemente a nivel de Frontend inyectando un agrupador universal en la propiedad `metadata` del JSON Payload (tanto en `POST /payments` como en `POST /:id/apply`).
   - Siempre que se presione el botón gigantesco verde de "Capture / Finish Order", la aplicación genera un **`transaction_id` amigable estilo base36 (`txn_01H...`)**.
   - Si se crean 1 o más records de `CustomerPayment` y/o `PaymentApplication` en esa fracción de segundo, _todos_ llevarán calcado ese id en `metadata.transaction_id`.
   - El POS expone la ruta `/transactions` que simplemente consume la base de pagos pero los procesa con Javascript en batch, logrando inferir que "$200 Cash + $50 Store Credit" formaron el `txn_01H...` total de `$250`.
   - **Referencia Amigable:** El recibo y las interfaces muestran el decoded ID (ej: *Ref No. 1042X*) ahorrando usar UUIDs ilegibles para el cliente de mostrador.

2. **Event Bus Emitted (QuickBooks Sync):**
   - El `route.ts` del admin api `/admin/finance/payments` y su par `/apply` ahora inyectan `req.scope.resolve(Modules.EVENT_BUS)`.
   - Tras grabarse el pago exitosamente en la BD subyacente de Finance module, lanzan `await eventBus.emit({ name: "pos.payment.created", data: { id } })` (o `applied`).
   - Esto habilita limpiamente a que los _Subscribers_ asyncrónicos puedan recoger el evento en background, leer qué invoice fue pagado, y enviar el respectivo JSON contra la cola de `bridge-server` hacia QuickBooks Desktop sin frenar ni un milisegundo al cajero en la pantalla principal.

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
  modules/finance/
    models/
      customer-payment.ts
      payment-application.ts
  subscribers/
    finance-payment-captured.ts   Web payment sync

ecopowertech-store-pos/
  app/(pos)/payments/
    page.tsx                List page
    [id]/page.tsx           Detail page (orchestrator)
  components/pos/payments/
    PaymentHeader.tsx
    PaymentSummaryCard.tsx
    CreditStatement.tsx
    CustomerSelectModal.tsx
    ApplyCreditModal.tsx
    RefundModal.tsx
  lib/payments.ts           Shared types + API helpers
```
