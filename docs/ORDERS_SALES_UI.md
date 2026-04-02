# Orders — Sales Orders UI
> **Tipo**: Technical Reference
> **Repo**: backend
> **Última verificación**: 2026-04-02
> **Estado**: ✅ Current

---

## ¿Qué es y por qué existe?

Vista personalizada de órdenes confirmadas en el Admin panel de Medusa. Muestra órdenes pendientes o parcialmente cumplidas. No reemplaza la vista de detalle nativa — solo personaliza la lista con filtros adicionales, columna QB Ref # y toggle "Show Cancelled".

---

## Arquitectura General

```
Admin Medusa sidebar:
    1. Drafts   → /draft-orders-advanced    (lista custom + detalle custom)
    2. Sales Orders → /orders-1-sales       (lista custom + detalle NATIVO Medusa)
    3. Invoices → /orders-2-invoices        (lista custom + detalle nativo)

orders-1-sales/page.tsx
    │
    ├── useOrdersList(["not_fulfilled", "partially_fulfilled"])
    │       └── GET /admin/orders?limit=250&fields=...  (fetch único al montar)
    │
    ├── OrdersControls  (search Input + Show Cancelled button + Sort Select)
    ├── OrdersTable     (grid con columnas, 20 items/página)
    └── OrdersFooter    (count + Prev/Next pagination)
```

Todo el filtrado, búsqueda y paginación es **100% client-side**. No hay re-fetch al buscar o paginar.

---

## Sidebar Config & Ordenamiento

```typescript
// orders-1-sales/page.tsx
export const config = defineRouteConfig({
    label: "Sales Orders",
    icon: ShoppingCart,
    nested: "/orders",
})
```

El prefijo numérico en el nombre del directorio controla el orden alfabético que Medusa usa para la sidebar.

---

## Hook: `useOrdersList`

Hook genérico usado por **Sales Orders** e **Invoices**. Recibe `fulfillmentFilters` para determinar qué estados mostrar.

```typescript
export const useOrdersList = (fulfillmentFilters: FulfillmentFilter[]) => {
    // Returns:
    // navigate, orders, loading,
    // search, setSearch, sort, setSort, page, setPage,
    // filtered, sorted, paginated, totalPages,
    // showCancelled, setShowCancelled, cancelledCount
}
```

### Tipos

```typescript
export type FulfillmentFilter =
    | "not_fulfilled"
    | "partially_fulfilled"
    | "fulfilled"
    | "delivered"

export type SortKey =
    | "display_id_desc" | "display_id_asc"
    | "created_at_desc" | "created_at_asc"
    | "total_desc"      | "total_asc"
```

### Fetch

```typescript
const params = new URLSearchParams({
    limit: "250",
    fields: "id,display_id,status,fulfillment_status,payment_status,total,currency_code,created_at,+metadata,+customer.first_name,+customer.last_name,+customer.email,+customer.phone,+customer.company_name,+shipping_address.first_name,+shipping_address.last_name,+shipping_address.phone,+shipping_address.company,+sales_channel.name",
})
const r = await fetch(`/admin/orders?${params}`, { credentials: "include" })
```

> **Un solo fetch al montar.** No hay refetch automático. Si se crea una nueva orden, el usuario debe recargar la página.

### Pipeline de Filtrado

```
orders (250 raw)
    │
    ├── [1] fulfillment_status ∈ fulfillmentFilters     (not_fulfilled | partially_fulfilled)
    ├── [2] status !== "canceled"  (a menos que showCancelled=true)
    ├── [3] search  (client-side: display_id, customer name, company, email, phone)
    │
    ├── sorted  (por SortKey)
    └── paginated (20/página)
```

---

## Columnas de la Tabla

| Columna | Fuente | Descripción |
|---------|--------|-------------|
| # | `display_id` | Número de orden |
| QB Ref # | `metadata.qb_sales_order?.ref_number` → `metadata.qb_invoice?.ref_number` → legacy `metadata.qb_sales_order_ref_num` | Referencia en QuickBooks |
| Customer | `customer.first_name + last_name` | Nombre del cliente |
| Company | `customer.company_name` o `shipping_address.company` | Empresa |
| Payment | `payment_status` badge | Estado de pago |
| Fulfillment | `fulfillment_status` badge | Estado de despacho |
| QB Synced | Check verde / Clock ámbar / X rojo | Tiene `qb_so_txn_id` o `qb_sales_receipt_txn_id` |
| Date | `created_at` | Fecha de creación |
| Total | `total` (Medusa native) | Monto total |

---

## Detail View: Medusa Nativo + QB Widget

El detalle de una Sales Order usa la página nativa de Medusa (`/orders/:id`), enriquecida con un widget custom:

```typescript
// backend/src/admin/widgets/quickbooks-order-widget.tsx
// Inyectado en: order.details.before
```

El widget QB muestra el estado de sincronización con QuickBooks y permite re-sincronizar manualmente.

---

## Lifecycle: Estimate → Sales Order

```
1. Estimate creado (Draft Order)
   → QB Estimate vía POST /admin/quickbooks/draft-order

2. Cliente aprueba → POST /admin/draft-orders/:id/convert-force
   → Medusa Order confirmada
   → metadata copiada del draft (tax_mode, payment_terms, sales_rep, etc.)

3. POST /admin/quickbooks/order { orderId }
   → QB Sales Order creado

4. Staff despacha → POST /admin/orders/:id/fulfillments
   → POST /admin/quickbooks/invoice { orderId, fulfillmentId }
   → QB Invoice creada

5. Cliente paga → ver POS_CAPTURE_PAYMENT.md
```

---

## Archivos Clave

| Tipo | Ruta Completa | Propósito |
|------|---------------|-----------|
| Admin | `backend/src/admin/routes/orders-1-sales/page.tsx` | Entry point con config de sidebar |
| Admin | `backend/src/admin/routes/sales-orders/page.tsx` | Lógica compartida sin config |
| Hook | `backend/src/admin/routes/sales-orders/hooks/use-orders-list.ts` | Hook genérico de lista |
| Comp | `backend/src/admin/routes/sales-orders/components/orders-table.tsx` | OrdersTable, Controls, Footer |
| Widget | `backend/src/admin/widgets/quickbooks-order-widget.tsx` | QB widget en detalle nativo |
| API | `backend/src/api/admin/quickbooks/order/route.ts` | POST: sync como QB Sales Order |

---

## Reglas Críticas

- La lista carga máximo 250 órdenes en un solo fetch al montar — no es adecuado para volúmenes mayores sin paginación server-side
- El detalle usa la UI nativa de Medusa — cambios en el Admin panel de Medusa pueden afectar la vista
- `orders-1-sales` y `orders-2-invoices` usan el mismo hook `useOrdersList` con diferentes `fulfillmentFilters`

---

## Historial de Decisiones

- **Prefijo numérico en directorio** (2026-03-06): Medusa ordena las rutas del sidebar alfabéticamente. El prefijo fuerza el orden Drafts → Sales → Invoices.
- **Lista custom sobre detalle nativo**: El detalle de Medusa es suficientemente rico (historial, fulfillments, payments). Solo la lista necesita customización para mostrar QB Ref # y filtros de estado.
- **Hook genérico `useOrdersList`**: Sales Orders e Invoices tienen el mismo comportamiento de lista — solo difieren en `fulfillmentFilters`. El hook evita duplicación.
