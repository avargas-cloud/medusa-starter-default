# POS_ARCHITECTURE — EcoPowerTech Store POS

**Last Updated:** 2026-03-29

| Campo | Detalle |
|-------|---------|
| **App URL** | `https://pos.ecopowertech.com` (Next.js 15) |
| **Backend** | Medusa v2 — `https://api.ecopowertech.com` |
| **QB Bridge** | `https://qb.eptbridge.com` |
| **Version** | v1.1 |

---

## Descripción General

El **EcoPowerTech POS** es una aplicación Next.js 15 standalone para el equipo interno de ventas (store staff). Se conecta directamente al backend Medusa v2 y al QuickBooks Bridge para operaciones de venta en tienda.

```
pos.ecopowertech.com (Next.js 15)
│
├── Auth: Bearer JWT vía Medusa /auth/user/emailpass
├── Search: MeiliSearch (product, customer, order lookup)
├── Data: Medusa v2 API (admin + store endpoints)
└── QB: QuickBooks Bridge via /admin/quickbooks/*
```

---

## Módulos — Documentación Detallada

| Módulo | Ruta POS | Documento |
|--------|----------|-----------|
| 🔐 Authentication | `/login`, `/reset-password` | [POS_AUTH.md](./POS_AUTH.md) |
| 📊 Dashboard | `/dashboard` | [POS_DASHBOARD.md](./POS_DASHBOARD.md) |
| 🧾 Estimates | `/estimates`, `/estimates/[id]` | [POS_ESTIMATES.md](./POS_ESTIMATES.md) |
| 📦 Orders | `/orders`, `/orders/[id]` | [POS_ORDERS.md](./POS_ORDERS.md) |
| 🧾 Invoices | `/invoices`, `/invoices/[id]` | [POS_INVOICES.md](./POS_INVOICES.md) |
| 🔄 Credit Memos (Returns) | `/returns` (admin) | [POS_INVOICES.md § 3–4](./POS_INVOICES.md#3-credit-memo-complete-flow) |
| 💳 Capture Payment | `/capture-payment` | [POS_CAPTURE_PAYMENT.md](./POS_CAPTURE_PAYMENT.md) |
| 👤 Customers | `/customers`, `/customers/[id]` | [POS_CUSTOMERS.md](./POS_CUSTOMERS.md) |
| 📋 Inventory | `/inventory` | [POS_INVENTORY.md](./POS_INVENTORY.md) |
| 👥 Users | `/users` | [POS_USERS.md](./POS_USERS.md) |
| 🏭 Vendors | `/vendors` | [POS_VENDORS.md](./POS_VENDORS.md) |
| 🔗 QuickBooks | N/A (backend integration) | [POS_QUICKBOOKS.md](./POS_QUICKBOOKS.md) |

---

## Arquitectura de Sales Channels

```
Medusa Sales Channels
│
├── POS (POS_SALES_CHANNEL_ID = sc_15154EAF0D194265ADD21AAD2D)
│     └── pos.ecopowertech.com
│           ├── Sales Receipt → QB Bridge directamente
│           ├── Sales Order (on account) → QB Bridge directamente
│           └── qb-order-subscriber.ts SKIPEADO para canal POS
│
└── Web Store (WEB_STORE_SALES_CHANNEL_ID = sc_01KFH7QCHT364SX242A69ZR435)
      └── store.ecopowertech.com
            └── qb-order-subscriber.ts → QB sync automático
```

**Principio clave:** La discriminación es por `sales_channel_id` — sin metadata adicional.
**Subscriber guard:** `isPosOrder()` en `qb-order-subscriber.ts` skipea los 5 event handlers para órdenes POS.

---

## Estado de Implementación

| Fase | Estado | Descripción |
|------|--------|-------------|
| Fase 1 — POS Source Guard | ✅ Completo | `isPosOrder()` + guard en 5 event handlers |
| Fase 2 — QB Sales Receipt | ✅ Completo | `POST/DELETE /admin/quickbooks/sales-receipt` |
| Fase 3 — Credit Ledger | ✅ Completo | `customer_credit_ledger` table + 3 endpoints |
| Fase 4 — Auth & Password Reset | ✅ Completo | Bearer JWT, SQL surgery reset flow |
| Fase 5 — Payments & Finance | ✅ Completo | Multi-invoice payment screen, credit memo refunds |
| Fase 6 — Per-Fulfillment Invoicing | ✅ Completo | PDF por fulfillment, QB Invoice manual |
| Fase 7 — User Management | 🟡 Pendiente | POS-only user profiles, admin invite |

---

## Variables de Entorno

### Backend (`backend/.env`)

| Variable | Dev | Prod | Descripción |
|----------|-----|------|-------------|
| `POS_URL` | `http://localhost:3001` | `https://pos.ecopowertech.com` | URL del POS (para links de email) |
| `POS_SALES_CHANNEL_ID` | `sc_15154EAF...` | mismo | Canal POS para subscriber guard |
| `WEB_STORE_SALES_CHANNEL_ID` | `sc_01KFH7Q...` | mismo | Canal Web |
| `JWT_SECRET` | `supersecret` | (seguro) | Secret para JWT de reset |
| `SENDGRID_API_KEY` | — | `SG.xxx` | API key SendGrid |
| `SENDGRID_FROM` | — | `noreply@ecopowertech.com` | Sender de emails |
| `QB_ORDER_FLOW_ENABLED` | `true` | `true` | Habilitar QB sync |
| `QB_BRIDGE_URL` | — | `https://qb.eptbridge.com` | QB bridge |
| `QB_API_KEY` | — | `mQb-xxx` | Auth del bridge |
| `DATABASE_URL` | `postgres://...` | mismo | PostgreSQL |

### POS Frontend (`ecopowertech-store-pos/.env`)

| Variable | Descripción |
|----------|-------------|
| `NEXT_PUBLIC_MEDUSA_URL` | URL del backend (`http://localhost:9000`) |
| `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY` | Publishable key — requerida para endpoints `/store/` |
| `NEXT_PUBLIC_SALES_CHANNEL_ID` | `POS_SALES_CHANNEL_ID` |
| `NEXT_PUBLIC_MEILISEARCH_HOST` | Host MeiliSearch |
| `NEXT_PUBLIC_MEILISEARCH_SEARCH_KEY` | Search key MeiliSearch |

---

## File Structure (Vista General)

```
backend/src/
├── subscribers/
│   └── qb-order-subscriber.ts          ← isPosOrder() guard
├── api/
│   ├── admin/
│   │   ├── quickbooks/{sales-receipt,draft-order,order}/
│   │   ├── invoices/{id}/void/route.ts
│   │   ├── pos/credit_memos/{id}/{complete,void}/route.ts
│   │   └── pos/sync/route.ts            ← Manual sync with intelligent void routing
│   │   └── customers/[id]/credits/{route,apply/route}.ts
│   └── store/
│       └── users/
│           ├── pos-reset-password/route.ts
│           └── pos-reset-confirm/route.ts
└── scripts/create-credit-ledger.sql

ecopowertech-store-pos/
├── app/
│   ├── (auth)/{login,reset-password}/
│   └── (pos)/{dashboard,estimates,orders,invoices,capture-payment,
│              customers,inventory,users,vendors,returns}/
├── lib/
│   ├── medusa.ts                        ← medusaFetch (Bearer JWT)
│   ├── pos-store.ts                     ← Zustand store with draftCache
│   └── qb.ts                            ← QB metadata extraction
├── components/pos/
│   ├── VoidDocumentModal.tsx            ← Confirmation modal for voids
│   └── payments/
│       ├── CreditStatement.tsx          ← Ledger with void reversals
│       └── ...
└── middleware.ts                        ← PUBLIC_PATHS guard
```

---

## Draft Cache (draftCache) — Safe Print Snapshots

The POS uses a Zustand store `posStore.draftCache` to temporarily hold print metadata without modifying the active document:

```typescript
// In posStore (Zustand):
interface DraftCache {
    [key: string]: Record<string, any>
}

// Usage:
setDraftCache(prev => ({
    ...prev,
    [`print_invoice_${invoice.id}`]: {
        _print_subtotal: invoice.subtotal,
        _print_discount: invoice.discount,
        _print_shipping: invoice.shipping,
        _print_tax:      invoice.tax,
        _print_total:    invoice.total,
        _print_amount_paid: invoice.amount_paid,
        _print_balance_due: invoice.balance_due,
    }
}))
```

**Design Goals:**
- **No mutations:** Active document is never modified.
- **No isDirty flag:** Printing doesn't mark document as edited.
- **Snapshot fidelity:** Print totals come directly from the database.
- **Temporary storage:** Cleared after print navigation.

**File:** `ecopowertech-store-pos/lib/pos-store.ts` (Zustand store definition)

---

## Void Document Confirmation Modal

The `VoidDocumentModal.tsx` component enforces safe void operations by requiring users to type **"VOID"** (all caps) before confirming. This applies to:

- **Invoices** — Full void of the entire invoice with financial rollback
- **Credit Memos** — Reversal of refund with inventory restock
- **Sales Receipts** — Void immediate payment transaction
- **Sales Orders** — Close pending order

Each document type displays context-specific warning bullets explaining the consequences of the void.

**File:** `ecopowertech-store-pos/components/pos/VoidDocumentModal.tsx`

---

## QB Pipeline & Void Tracking

All QB operations (create, void, update) are tracked in `qb_order_pipeline` with full status lifecycle:

- `pending` → `submitted` → `confirmed`
- `pending` → `submitted` → `failed`

**Void operations specifically:**
- `void_invoice` — triggered by `POST /admin/invoices/:id/void`
- `void_credit_memo` — triggered by `POST /admin/pos/credit_memos/:id/void`
- `void_sales_receipt` — triggered by POS cancellation
- `void_sales_order` — triggered by order cancel handler

Each void row captures:
- `medusa_ref_number` (e.g., INV-1234, CM-567)
- `qb_ref_number` (QB-assigned reference)
- `qb_txn_id` (QB transaction ID being voided)
- Full status history and error messages

See [QB_PIPELINE_ARCHITECTURE.md](./QB_PIPELINE_ARCHITECTURE.md) for complete pipeline documentation.

---

## Intelligent Void Routing (Manual Sync)

The `POST /admin/pos/sync` endpoint now auto-detects voided documents:

```typescript
// Frontend detects:
if (estimateStatus === 'voided' || status === 'voided') {
    // Auto-pass action: 'void' to sync endpoint
}

// Backend intelligently routes:
if (type === 'credit_memo' && (status === 'voided' || action === 'void')) {
    // Call voidCreditMemoInQb (background, non-blocking)
    // Write pipeline row with void tracking
} else if (type === 'invoice' && status === 'voided') {
    // Detect void scenario and set syncModalAction = 'void'
}
```

**Benefit:** Users no longer receive "Only completed CMs can be synced" errors. The system intelligently routes voided documents to their respective QB void handlers.

---

## Gotchas Críticos

| Issue | Fix |
|-------|-----|
| `authModule.updateProvider()` crea identity zombie | Usar SQL surgery en `/pos-reset-confirm` — ver [POS_AUTH.md](./POS_AUTH.md) |
| Admin user con 401 en `/admin/users/me` | Agregar `user_id` a `auth_identity.app_metadata` — ver [POS_AUTH.md](./POS_AUTH.md) |
| POS cancel no voidea en QB | Llamar `DELETE /admin/quickbooks/sales-receipt` explícitamente |
| `x-publishable-api-key` faltante en `/store/` | Leer de `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY` |
| Subscriber actúa en órdenes POS | Verificar `POS_SALES_CHANNEL_ID` env var en backend |
| Void modal accepts anything | MUST type exactly **"VOID"** (case-sensitive) |
| `voidCreditMemoInQb` returns wrong format | Fixed: now returns `{ success: true, data: result }` |
| Invoice sync shows false green checkmark | Fixed: requires `qb_txn_id` (not just `qb_ref_number`) for `'synced'` status |

---

## Integration Points

### Backend → QB Bridge

All QB operations go through the bridge via REST:
- Direct Execution (fire-and-forget, non-blocking)
- Background threads (setTimeout) prevent blocking HTTP response
- Pipeline tracking enables polling and failure recovery

### POS Frontend → Backend

- Admin API endpoints: `/admin/quickbooks/*`, `/admin/invoices/*`, `/admin/pos/*`
- Store API endpoints: `/store/products`, `/store/customers` (via publishable key)
- Bearer JWT authentication with session cookies

### Finance Ledger → Payments & Credits

When a credit memo is completed/voided:
1. Inventory is restocked/reversed
2. QB sync is triggered (background)
3. Refund is created in Medusa native Payment Module
4. Finance Ledger entry created via `CustomerPayment`
5. PosInvoice `refunded_amount` / `refunded_shipping` updated
6. PosInvoiceItem `refunded_quantity` updated

---

**Version:** 1.1 — Complete architecture as of 2026-03-29
