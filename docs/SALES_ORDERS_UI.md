# Sales Orders — Admin UI
# Guide Completo del Módulo de Sales Orders

| Campo | Detalle |
|-------|---------|
| **Propósito** | Vista de órdenes de ventas confirmadas que están pendientes de cumplimiento o parcialmente cumplidas. Lista personalizada sobre el sistema nativo de Medusa, con filtros de búsqueda, paginación, referencia a QuickBooks y filtro "Show Cancelled". |
| **Última revisión** | 2026-03-06 (Show Cancelled filter + QB Ref # column) |

## Resumen Ejecutivo

✅ **Lista custom** en `/app/orders-1-sales` — no es un reemplazo del detalle nativo, solo de la lista  
✅ **Filtro por fulfillment_status** — muestra `not_fulfilled` y `partially_fulfilled` exclusivamente  
✅ **Oculta canceladas por defecto** — `status !== "canceled"` a menos que el usuario active "Show Cancelled"  
✅ **Show Cancelled toggle** — botón en la barra de controles con counter de órdenes canceladas  
✅ **QB Ref # column** — columna en 2da posición con el número de Sales Order o Invoice en QuickBooks  
✅ **Búsqueda client-side** — por #, nombre de cliente, empresa, email y teléfono  
✅ **Sorteo client-side** — por # más reciente/antiguo, fecha y total  
✅ **Paginación** — 20 órdenes por página  
✅ **Detalle via Medusa nativo** — click en fila navega a `/orders/:id` (página nativa de Medusa)  
✅ **Botón "Create Sales Order"** — navega a `/orders/create` (página nativa de Medusa)  
✅ **QB Widget en detalle** — widget `quickbooks-order-widget.tsx` inyectado en `order.details.before`  

---

## Table of Contents

1. [File Structure](#1-file-structure)
2. [Arquitectura General](#2-arquitectura-general)
3. [Sidebar Config & Ordenamiento](#3-sidebar-config--ordenamiento)
4. [Hook: useOrdersList](#4-hook-useorderslist)
5. [Componentes Compartidos](#5-componentes-compartidos)
6. [Filtros & Lógica de Datos](#6-filtros--lógica-de-datos)
7. [Columnas de la Tabla](#7-columnas-de-la-tabla)
8. [Detail View: Medusa Nativo + QB Widget](#8-detail-view-medusa-nativo--qb-widget)
9. [QuickBooks Integration](#9-quickbooks-integration)
10. [Lifecycle Completo: Draft → Sales Order](#10-lifecycle-completo-draft--sales-order)
11. [Known Issues & Gotchas](#11-known-issues--gotchas)

---

## 1. File Structure

```
backend/src/
│
├── admin/
│   ├── routes/
│   │   ├── orders-1-sales/
│   │   │   └── page.tsx                  ← Entrada de sidebar (config + render)
│   │   │
│   │   └── sales-orders/                 ← Lógica compartida con Invoices
│   │       ├── page.tsx                  ← Página original (sin config de sidebar)
│   │       ├── hooks/
│   │       │   └── use-orders-list.ts    ← Hook genérico de lista de órdenes
│   │       └── components/
│   │           └── orders-table.tsx      ← OrdersTable, OrdersControls, OrdersFooter
│   │
│   └── widgets/
│       └── quickbooks-order-widget.tsx   ← Widget QB en página de detalle nativa
│
└── api/admin/quickbooks/
    └── order/route.ts                    ← POST: sync orden como QB Sales Order
```

> **¿Por qué dos páginas (`orders-1-sales` y `sales-orders`)?**
> El prefijo numérico (`orders-1-sales`) fuerza el orden en la sidebar de Medusa.
> La lógica real vive en `sales-orders/` para no duplicar código con `invoices/`.

---

## 2. Arquitectura General

```
orders-1-sales/page.tsx
    │
    ├── useOrdersList(["not_fulfilled", "partially_fulfilled"])
    │       └── /admin/orders?limit=250&fields=...  (fetch único at mount)
    │
    ├── OrdersControls  (search Input + Show Cancelled button + Sort Select)
    ├── OrdersTable     (grid con 9 columnas, 20 items/página)
    └── OrdersFooter    (count + Prev/Next pagination)
```

Todo el filtrado, búsqueda y paginación es **100% client-side**. Se hace un solo fetch de hasta 250 órdenes al montar el componente. No hay re-fetch al buscar o cambiar de página.

---

## 3. Sidebar Config & Ordenamiento

```typescript
// orders-1-sales/page.tsx
export const config = defineRouteConfig({
    label: "Sales Orders",
    icon: ShoppingCart,
    nested: "/orders",
})
```

| Sección | Orden | Página |
|---------|-------|--------|
| Drafts | 1° | `/draft-orders-advanced` (built-in) |
| **Sales Orders** | 2° | `/orders-1-sales` ← (esta página) |
| Invoices | 3° | `/orders-2-invoices` |

El prefijo numérico en el nombre del directorio controla el orden alfabético que Medusa usa para registrar rutas en la sidebar.

---

## 4. Hook: useOrdersList

**Archivo:** `sales-orders/hooks/use-orders-list.ts`

Hook genérico usado por **Sales Orders** e **Invoices**. Recibe un array de `fulfillmentFilters` que determina qué órdenes mostrar.

### Firma

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

> ⚠️ **Un solo fetch al montar.** No hay refetch automático. Si se crea una nueva orden, el usuario debe recargar la página.

### Pipeline de Filtrado

```
orders (250 raw)
    │
    ├── [1] fulfillment_status ∈ fulfillmentFilters     (e.g. not_fulfilled | partially_fulfilled)
    ├── [2] status !== "canceled"  (si showCancelled === false)
    ├── [3] búsqueda por nombre / email / empresa / # / teléfono
    └── [4] sort → paginate (PAGE_SIZE = 20)
```

### showCancelled State

```typescript
const [showCancelled, setShowCancelled] = useState(false)  // default: ocultas

// Cuenta el total de canceladas (independiente del filtro activo)
const cancelledCount = useMemo(() =>
    orders.filter(o => o.status === "canceled").length,
    [orders]
)

// Se aplica ANTES de la búsqueda
.filter(o => showCancelled || o.status !== "canceled")
```

> **Nota:** `status` (de la orden) y `fulfillment_status` son campos distintos.  
> Una orden puede tener `status: "canceled"` y `fulfillment_status: "not_fulfilled"` simultáneamente.  
> El Show Cancelled filtra por `status`, no por `fulfillment_status`.

### Sort Options

| Valor | Etiqueta |
|-------|---------|
| `display_id_desc` | # (Newest first) — **default** |
| `display_id_asc` | # (Oldest first) |
| `created_at_desc` | Date (Newest) |
| `created_at_asc` | Date (Oldest) |
| `total_desc` | Total (High → Low) |
| `total_asc` | Total (Low → High) |

---

## 5. Componentes Compartidos

**Archivo:** `sales-orders/components/orders-table.tsx`  
Usado por **Sales Orders** e **Invoices** sin modificación.

### OrdersTable

| Prop | Tipo | Descripción |
|------|------|-------------|
| `loading` | `boolean` | Muestra "Loading orders..." |
| `sorted` | `OrderListItem[]` | Lista completa filtrada (para count) |
| `paginated` | `OrderListItem[]` | Slice de la página actual |
| `onRowClick` | `(id: string) => void` | Navegación al detalle |

### OrdersControls

| Prop | Tipo | Descripción |
|------|------|-------------|
| `search` | `string` | Valor actual del input |
| `onSearchChange` | `(v: string) => void` | Callback |
| `sort` | `SortKey` | Sort activo |
| `onSortChange` | `fn` | Callback |
| `showCancelled` | `boolean?` | Estado del toggle (opcional) |
| `onToggleCancelled` | `() => void?` | Callback del toggle (opcional) |
| `cancelledCount` | `number?` | N para el label del botón |
| `searchPlaceholder` | `string?` | Placeholder del input |

> Si `onToggleCancelled` no se pasa, el botón **no se renderiza**. Esto permite que Invoices no tenga el toggle (actualmente no lo tiene).

### OrdersFooter

Muestra count total + paginación Prev/Next. Solo renderiza botones si `totalPages > 1`.

```
[12 sales orders]                    [← Prev]  [Next →]
```

---

## 6. Filtros & Lógica de Datos

### Búsqueda

Soporta búsqueda simultánea por:
- Nombre completo (`first_name + last_name`)
- Email del customer
- Nombre de company (`company_name` o `shipping_address.company`)
- Teléfono (normaliza dígitos, quita -()/spaces)
- `#display_id`

```typescript
const isPhoneSearch = /^[\d\s\-()]+$/.test(search.trim())
// → búsqueda de teléfono usa comparación numérica pura
```

### QB Ref # Column

```typescript
const qbRef = (
    order.metadata?.qb_sales_order_ref ??
    order.metadata?.qb_invoice_ref ??
    null
) as string | null
```

La segunda columna muestra:
- El número de Sales Order en QB (`qb_sales_order_ref`) si existe
- O el número de Invoice QB (`qb_invoice_ref`) como fallback
- `—` si no hay ninguno (orden aún no sincronizada)

### Monedas

```typescript
// Medusa v2 /admin/orders devuelve los totales YA en dólares (no centavos)
const formatCurrency = (amount: number, currency = "usd") =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: 2 })
    .format(amount)
```

> ⚠️ A diferencia de `/admin/draft-orders`, la API `/admin/orders` retorna precios en **dólares**, no en centavos.

---

## 7. Columnas de la Tabla

Grid CSS: `grid-cols-[80px_110px_110px_minmax(120px,1fr)_minmax(120px,1fr)_120px_120px_110px_110px]`

| # | Header | Fuente | Notas |
|---|--------|--------|-------|
| 1 | Order # | `order.display_id` | `#1089` |
| 2 | QB Ref # | `metadata.qb_sales_order_ref` o `qb_invoice_ref` | Font mono, `—` si no hay |
| 3 | Date | `order.created_at` | `Mar 6, 2026` |
| 4 | Company | `customer.company_name` o `shipping_address.company` | Truncado 2 líneas |
| 5 | Customer | `first_name + last_name` o email | Truncado |
| 6 | Payment | `order.payment_status` | Badge de color |
| 7 | Fulfillment | `order.fulfillment_status` | Badge de color |
| 8 | Channel | `sales_channel.name` | "Default" si es Default Sales Channel |
| 9 | Total | `order.total` | Alineado a la derecha |

### Badge Colors

**Payment Status:**

| Status | Color |
|--------|-------|
| `not_paid`, `awaiting` | 🟠 Orange |
| `captured`, `paid` | 🟢 Green |
| `refunded`, `partially_refunded` | 🔵 Blue |
| `canceled` | 🔴 Red |

**Fulfillment Status:**

| Status | Color |
|--------|-------|
| `not_fulfilled` | 🟠 Orange |
| `partially_fulfilled` | 🔵 Blue |
| `fulfilled` | 🟢 Green |

---

## 8. Detail View: Medusa Nativo + QB Widget

**Sales Orders NO tiene página de detalle custom.** El click en una fila navega a:

```
/orders/:id  →  Medusa Admin nativo
```

### QuickBooks Order Widget

**Archivo:** `admin/widgets/quickbooks-order-widget.tsx`  
**Zone:** `order.details.before`

Inyectado automáticamente en la cabecera de cada orden confirmada. Muestra:

- QB Sales Order Number (`qb_sales_order_ref`)
- QB TxnID (`qb_sales_order_txn_id`)
- QB Payment TxnID (`qb_payment_txn_id`)
- QB Invoice TxnID (`qb_invoice_txn_id`)

**Botón "Re-sync Sales Order":**  
Llama a `POST /admin/quickbooks/order` con `{ orderId }`.  
Útil para: re-sincronización manual, o conversión de Estimate → Sales Order si el subscriber falló.

**Auto-polling:**  
Mientras `qb_sales_order_txn_id` esté ausente en metadata, el widget hace polling cada **8 segundos**.  
Muestra badge `⏳ Pending QB sync...` hasta que detecta el TxnID.  
Se detiene automáticamente al recibir el TxnID. El botón `↻ Refresh` también está disponible manualmente.

---

## 9. QuickBooks Integration

### Flujo automático (Order Placed Event)

Cuando un Draft Order se convierte a Sales Order mediante `convert-force`:

```
1. Medusa emite evento `order.placed`
2. qb-order-subscriber.ts captura el evento
3. Si el draft tenía QB Estimate (qb_estimate_txn_id en metadata):
       → QB convierte Estimate → Sales Order (en QB Desktop)
   Si no:
       → QB crea Sales Order directo
4. Metadata de la orden se actualiza con:
       qb_sales_order_txn_id, qb_sales_order_ref,
       qb_payment_txn_id, qb_invoice_txn_id
```

> ⚠️ **NUNCA llamar QB sync manualmente desde `convert-force`.** Causaba Sales Orders duplicadas en QB. El subscriber lo maneja automáticamente vía el evento `order.placed`.

### Flujo manual (Re-sync desde widget)

```
POST /admin/quickbooks/order  { orderId: "order_01ABC" }
    │
    ├── Si tiene qb_estimate_txn_id → ConvertEstimate a SO en QB
    └── Si no → CreateSalesOrder directo en QB
```

### Cancel Order → QB

Cuando una orden de Medusa se cancela:

```
order.canceled evento
    └── subscriber cierra Sales Order en QB (o voidea Invoice)
        → Activity log: "SO #6176 closed for Order #1087"
```

---

## 10. Lifecycle Completo: Draft → Sales Order

```
[Draft Order] (draft-orders-advanced)
    │
    ├── Usuario presiona "Convert to Order"
    │       → POST /admin/draft-orders/:id/convert-force
    │               → Medusa crea la orden confirmada
    │               → Evento order.placed
    │                       → qb-order-subscriber.ts
    │                               → QB SO creada automáticamente
    │
    ▼
[Sales Order] (orders-1-sales)      ← aparece aquí
    │
    │   fulfillment_status = "not_fulfilled"
    │   status = "pending"
    │
    ├── [Fulfillment completado]
    │       fulfillment_status → "partially_fulfilled"  (sigue en Sales Orders)
    │       fulfillment_status → "fulfilled"            → pasa a Invoices
    │
    └── [Cancelación]
            status → "canceled"
            → oculta de Sales Orders por defecto
            → visible con "Show Cancelled" toggle
            → QB: Sales Order cerrada
```

---

## 11. Known Issues & Gotchas

### `status` vs `fulfillment_status`

Son campos independientes en Medusa v2. Una orden puede estar:

- `status: "canceled"` + `fulfillment_status: "not_fulfilled"` — cancelada antes de cumplir
- `status: "completed"` + `fulfillment_status: "fulfilled"` — completada normalmente

El filtro de fulfillment_status determina en qué página aparece la orden.  
El filtro de status determina si está visible u oculta con Show Cancelled.

### Precios en Dólares (no centavos)

`/admin/orders` retorna `total` en dólares. Diferente a `/admin/draft-orders` que usa centavos.  
No aplicar división por 100.

### Un Solo Fetch

El hook hace el fetch una sola vez al montar. Para ver órdenes nuevas, el usuario debe recargar la página (F5 o navegar fuera y volver).

### Canceladas con QB Ref

Una orden cancelada puede seguir teniendo `qb_sales_order_ref` en metadata. Ese número es el del Sales Order cerrado en QuickBooks. No se borra al cancelar.

### Default Sales Channel

El nombre `"Default Sales Channel"` se normaliza a `"Default"` en la columna Channel para mayor legibilidad.

---

**Última actualización:** 2026-03-06  
**Versión:** 1.0 — Documentación inicial + Show Cancelled filter
