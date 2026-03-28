# POS_ARCHITECTURE — EcoPowerTech Store POS
# Índice General del Sistema POS

| Campo | Detalle |
|-------|---------|
| **App URL** | `https://pos.ecopowertech.com` (Next.js 15) |
| **Backend** | Medusa v2 — `https://api.ecopowertech.com` |
| **QB Bridge** | `https://qb.eptbridge.com` |
| **Última revisión** | 2026-03-06 — v1.1 |

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
| Fase 5 — Receive Payment UI | 🟡 Pendiente | Multi-invoice payment screen |
| Fase 6 — Per-Fulfillment Invoicing | 🟡 Pendiente | PDF por fulfillment, QB Invoice manual |
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
│   │   └── customers/[id]/credits/{route,apply/route}.ts
│   └── store/
│       └── users/
│           ├── pos-reset-password/route.ts
│           └── pos-reset-confirm/route.ts
└── scripts/create-credit-ledger.sql

ecopowertech-store-pos/
├── app/
│   ├── (auth)/{login,reset-password}/
│   └── (pos)/{dashboard,estimates,orders,capture-payment,
│              customers,inventory,users,vendors}/
├── lib/medusa.ts                        ← medusaFetch (Bearer JWT)
└── middleware.ts                        ← PUBLIC_PATHS guard
```

---

## Draft Cache (draftCache) — Safe Print Snapshots (Marzo 28, 2026)

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

## Gotchas Críticos

| Issue | Fix |
|-------|-----|
| `authModule.updateProvider()` crea identity zombie | Usar SQL surgery en `/pos-reset-confirm` — ver [POS_AUTH.md](./POS_AUTH.md) |
| Admin user con 401 en `/admin/users/me` | Agregar `user_id` a `auth_identity.app_metadata` — ver [POS_AUTH.md](./POS_AUTH.md) |
| POS cancel no voidea en QB | Llamar `DELETE /admin/quickbooks/sales-receipt` explícitamente |
| `x-publishable-api-key` faltante en `/store/` | Leer de `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY` |
| Subscriber actúa en órdenes POS | Verificar `POS_SALES_CHANNEL_ID` env var en backend |

---

**Versión:** 1.1 — Phases 1–4  |  **Docs:** Ver módulos individuales arriba
