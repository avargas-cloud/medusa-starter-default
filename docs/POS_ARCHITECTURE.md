# EcoPowerTech POS — Architecture Overview
> **Tipo**: Technical Reference
> **Repo**: backend
> **Última verificación**: 2026-04-02
> **Estado**: ✅ Current

---

## ¿Qué es y por qué existe?

El **EcoPowerTech POS** es una aplicación Next.js 15 para el equipo interno de ventas (store staff). Se conecta al backend Medusa v2 y al QuickBooks Bridge para operaciones de venta en tienda física, permitiendo Sales Receipts, Sales Orders, Estimates y gestión de clientes.

---

## Arquitectura

```
pos.ecopowertech.com (Next.js 15)
│
├── Auth: Bearer JWT vía /auth/user/emailpass (Medusa admin actor)
├── Search: MeiliSearch — productos (índice inventory), clientes (índice customers)
├── Data: Medusa v2 Admin API (/admin/*) + Store API (/store/*)
└── QB: QuickBooks Bridge via /admin/quickbooks/*
```

### Sales Channels

```
Medusa Sales Channels
│
├── POS (POS_SALES_CHANNEL_ID = sc_15154EAF0D194265ADD21AAD2D)
│     └── pos.ecopowertech.com
│           ├── Sales Receipt → QB Bridge (directo)
│           ├── Sales Order (on account) → QB Bridge (directo)
│           └── qb-order-subscriber.ts SKIPEADO para canal POS
│
└── Web Store (WEB_STORE_SALES_CHANNEL_ID = sc_01KFH7QCHT364SX242A69ZR435)
      └── store.ecopowertech.com
            └── qb-order-subscriber.ts → QB sync automático
```

**Principio clave:** La discriminación es por `sales_channel_id` (y `metadata.pos_created=true` como fallback). El subscriber `isPosOrder()` skipea los event handlers para órdenes POS.

---

## Módulos POS

| Módulo | Ruta POS | Documento |
|--------|----------|-----------|
| Authentication | `/login`, `/reset-password` | [POS_AUTH.md](./POS_AUTH.md) |
| Dashboard | `/dashboard` | [POS_DASHBOARD.md](./POS_DASHBOARD.md) |
| Estimates | `/estimates`, `/estimates/[id]` | [POS_ESTIMATES.md](./POS_ESTIMATES.md) |
| Orders | `/orders`, `/orders/[id]` | [POS_ORDERS.md](./POS_ORDERS.md) |
| Invoices | `/invoices`, `/invoices/[id]` | [POS_INVOICES.md](./POS_INVOICES.md) |
| Credit Memos (Returns) | `/returns` | [POS_INVOICES.md](./POS_INVOICES.md) |
| Capture Payment | `/capture-payment` | [POS_CAPTURE_PAYMENT.md](./POS_CAPTURE_PAYMENT.md) |
| Customers | `/customers`, `/customers/[id]` | [POS_CUSTOMERS.md](./POS_CUSTOMERS.md) |
| Inventory | `/inventory` | [POS_INVENTORY.md](./POS_INVENTORY.md) |
| Users | `/users` | [POS_USERS.md](./POS_USERS.md) |
| Vendors | `/vendors` | [POS_VENDORS.md](./POS_VENDORS.md) |
| Templates | `/templates` | [POS_TEMPLATES.md](./POS_TEMPLATES.md) |
| Accounting | `/accounting` | [POS_TRANSACTIONS.md](./POS_TRANSACTIONS.md) |
| Transactions | `/transactions` | [POS_TRANSACTIONS.md](./POS_TRANSACTIONS.md) |
| Payments | `/payments` | [POS_TRANSACTIONS.md](./POS_TRANSACTIONS.md) |
| Returns | `/returns` | [POS_INVOICES.md](./POS_INVOICES.md) |
| QuickBooks | N/A (backend) | [POS_QUICKBOOKS.md](./POS_QUICKBOOKS.md) |

---

## Features Extras (sin ruta propia)

| Feature | Implementación | Documento |
|---------|---------------|-----------|
| POS Discount | `POST /admin/pos-discount` | [ORDERS_DRAFT_ESTIMATES.md](./ORDERS_DRAFT_ESTIMATES.md) |
| POS Promotions | `GET /admin/pos-promotions` | [ORDERS_DRAFT_ESTIMATES.md](./ORDERS_DRAFT_ESTIMATES.md) |
| POS Transfer | `POST /admin/pos-transfer` | [POS_ORDERS.md](./POS_ORDERS.md) |
| Note Presets | `GET/POST /admin/note-presets` | [ORDERS_DRAFT_ESTIMATES.md](./ORDERS_DRAFT_ESTIMATES.md) |
| Backlighting Link | `POST /admin/draft-orders/:id/set-bl-link` | ver código |
| Estimate Options | `GET /admin/estimate-options` | ver [POS_ESTIMATES.md](./POS_ESTIMATES.md) |

---

## Estado de Implementación

| Fase | Estado | Descripción |
|------|--------|-------------|
| Fase 1 — POS Source Guard | ✅ Completo | `isPosOrder()` + guard en 5 event handlers |
| Fase 2 — QB Sales Receipt | ✅ Completo | `POST/DELETE /admin/quickbooks/sales-receipt` |
| Fase 3 — Credit Ledger | ✅ Completo | `customer_credit_ledger` table + endpoints |
| Fase 4 — Auth & Password Reset | ✅ Completo | Bearer JWT, SQL surgery reset flow |
| Fase 5 — Payments & Finance | ✅ Completo | Multi-invoice payment screen, credit memo refunds |
| Fase 6 — Per-Fulfillment Invoicing | ✅ Completo | PDF por fulfillment, QB Invoice manual |
| Fase 7 — User Management | ✅ Completo | POS-only user profiles, invite flow |
| Fase 8 — POS Discounts | ✅ Completo | Promotions via Order Edit workflow |
| Fase 9 — Document Templates | ✅ Completo | Template wizard, `pos_document_template` table |
| Fase 10 — Note Presets | ✅ Completo | `note_presets` table, 4 grupos de presets |
| Fase 11 — Credit Memos | ✅ Completo | `credit_memos` module, sync QB |

---

## Draft Cache (draftCache) — Safe Print Snapshots

El POS usa un Zustand store `posStore.draftCache` para almacenar metadata de impresión sin modificar el documento activo:

```typescript
// Patrón de uso (pos-store.ts):
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

**Principios:**
- No mutaciones al documento activo
- Sin flag `isDirty` por impresión
- Totales provienen directamente de la base de datos
- Se limpia después de navegar al print

---

## QB Pipeline & Void Tracking

Todas las operaciones QB se trackean en `qb_order_pipeline`:

- `pending` → `submitted` → `confirmed`
- `pending` → `submitted` → `failed`

Operaciones de void: `void_invoice`, `void_credit_memo`, `void_sales_receipt`, `void_sales_order`

Cada fila captura: `medusa_ref_number`, `qb_ref_number`, `qb_txn_id`, historial de estado.

---

## Variables de Entorno

### Backend (`backend/.env`)

| Variable | Descripción |
|----------|-------------|
| `POS_SALES_CHANNEL_ID` | Canal POS para subscriber guard |
| `WEB_STORE_SALES_CHANNEL_ID` | Canal Web Store |
| `POS_URL` | URL del POS (para links de email) |
| `QB_BRIDGE_URL` | URL del QB Bridge |
| `QB_API_KEY` | Auth del bridge |
| `SENDGRID_API_KEY` | Email notifications |
| `JWT_SECRET` | Secret para JWT de reset e invite |

### POS Frontend (`store-pos/.env`)

| Variable | Descripción |
|----------|-------------|
| `NEXT_PUBLIC_MEDUSA_URL` | URL del backend |
| `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY` | Requerida para endpoints `/store/` |
| `NEXT_PUBLIC_SALES_CHANNEL_ID` | POS Sales Channel ID |
| `NEXT_PUBLIC_MEILISEARCH_HOST` | Host MeiliSearch |
| `NEXT_PUBLIC_MEILISEARCH_SEARCH_KEY` | Search key MeiliSearch |
| `NEXT_PUBLIC_STOREFRONT_URL` | URL storefront (links LIVE en inventario) |

---

## Reglas Críticas

| Issue | Fix |
|-------|-----|
| `authModule.updateProvider()` crea identity zombie | Usar SQL surgery en `/store/users/pos-reset-confirm` |
| Admin user con 401 en `/admin/users/me` | Agregar `user_id` a `auth_identity.app_metadata` |
| POS cancel no voidea en QB | Llamar `DELETE /admin/quickbooks/sales-receipt` explícitamente |
| `x-publishable-api-key` faltante en `/store/` | Leer de `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY` |
| Subscriber actúa en órdenes POS | Verificar `POS_SALES_CHANNEL_ID` env var en backend |
| Void modal rechaza input incorrecto | MUST type exactly **"VOID"** (case-sensitive) |
| Invoice sync muestra falso checkmark | Requiere `qb_txn_id` (no solo `qb_ref_number`) para status `'synced'` |
| POS discount qty mismatch | `apply-existing` usa `posOverrideAdjustmentsWorkflow` para corregir antes del confirm |

---

## Archivos Clave

| Tipo | Ruta Completa | Propósito |
|------|---------------|-----------|
| Subscriber | `backend/src/subscribers/qb-order-subscriber.ts` | `isPosOrder()` guard — skipea QB sync para canal POS |
| API | `backend/src/api/admin/pos/sync/route.ts` | Manual QB sync con void routing inteligente |
| API | `backend/src/api/admin/pos/credit_memos/route.ts` | CRUD credit memos |
| API | `backend/src/api/admin/pos-discount/route.ts` | Crear y eliminar descuentos POS |
| API | `backend/src/api/admin/pos-discount/apply-existing/route.ts` | Aplicar promo existente con corrección de qty |
| API | `backend/src/api/admin/pos-promotions/route.ts` | Listar promociones disponibles |
| API | `backend/src/api/admin/pos-transfer/route.ts` | Transferir orden a otro cliente |
| API | `backend/src/api/admin/note-presets/route.ts` | CRUD presets de notas |
| API | `backend/src/api/admin/estimate-options/route.ts` | Opciones de dropdowns para estimates |
| API | `backend/src/api/admin/quickbooks/sales-receipt/route.ts` | POST/DELETE QB Sales Receipt |
| API | `backend/src/api/admin/quickbooks/draft-order/route.ts` | POST QB Estimate |
| API | `backend/src/api/admin/quickbooks/order/route.ts` | POST QB Sales Order |
| API | `backend/src/api/store/users/pos-reset-password/route.ts` | Password reset request |
| API | `backend/src/api/store/users/pos-reset-confirm/route.ts` | Password reset confirm (SQL surgery) |
| Módulo | `backend/src/modules/pos-user/` | Tabla whitelist de staff POS |
| Módulo | `backend/src/modules/invoices/` | Facturas POS con snapshots inmutables |
| Módulo | `backend/src/modules/credit_memos/` | Notas de crédito |
| Módulo | `backend/src/modules/finance/` | Ledger financiero por cliente |
| Módulo | `backend/src/modules/document-templates/` | Templates de documentos POS |

---

## Historial de Decisiones

- **Sales Channels como discriminador**: Más limpio que metadata — el `sales_channel_id` ya existe en el objeto orden sin necesidad de campos extras. El `metadata.pos_created=true` se usa como fallback para órdenes legacy.
- **draftCache en Zustand**: Se eligió sobre llamar `setDocument()` para evitar marcar el documento como "dirty" al imprimir. La impresión es read-only por diseño.
- **SQL surgery en reset-confirm**: Medusa `authModule.updateProvider()` crea una segunda identity en lugar de actualizar la existente, generando "zombies". El SQL directo evita este bug del framework.
- **Order Edit workflow para discounts** (2026-03): El flujo correcto para aplicar promos a draft orders es: cancelar edit pendiente → begin edit → apply promo → confirm. Las mutaciones directas a SQL se preservan como comentario de fallback pero no se usan.
- **`posOverrideAdjustmentsWorkflow` para qty mismatch** (2026-03): El ORM de Medusa usa un snapshot de qty que puede estar desactualizado cuando `update-item-force` escribe directamente a BD. El workflow intercepta el payload del edit antes del confirm y lo corrige.
