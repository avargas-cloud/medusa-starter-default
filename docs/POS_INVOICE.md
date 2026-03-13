# Invoices — Admin UI
# Guide Completo del Módulo de Invoices

| Campo | Detalle |
|-------|---------|
| **Propósito** | Vista de órdenes de ventas totalmente cumplidas (`fulfilled`) o entregadas (`delivered`). Lista custom sobre el sistema nativo de Medusa — muestra las órdenes que ya llegaron a destino y están listas para facturación/archivo. |
| **Última revisión** | 2026-03-06 (QB Ref # column + arquitectura compartida) |

## Resumen Ejecutivo

✅ **Lista custom** en `/app/orders-2-invoices` — no reemplaza el detalle nativo de Medusa  
✅ **Filtro por fulfillment_status** — muestra `fulfilled` y `delivered` exclusivamente  
✅ **QB Ref # column** — columna en 2da posición (numero de Sales Order o Invoice en QB)  
✅ **Arquitectura compartida** — reutiliza `useOrdersList`, `OrdersTable`, `OrdersControls`, `OrdersFooter` de `sales-orders/`  
✅ **Búsqueda client-side** — por #, nombre, empresa, email y teléfono  
✅ **Sorteo client-side** — por #, fecha, total  
✅ **Paginación** — 20 órdenes por página  
✅ **Detalle via Medusa nativo** — click navega a `/orders/:id` (página nativa de Medusa)  
✅ **Sin botón Create** — las invoices no se crean manualmente; son órdenes que completaron su ciclo  
✅ **QB Widget en detalle** — widget `quickbooks-order-widget.tsx` inyectado en `order.details.before`  

---

## Table of Contents

1. [File Structure](#1-file-structure)
2. [Arquitectura General](#2-arquitectura-general)
3. [Sidebar Config & Ordenamiento](#3-sidebar-config--ordenamiento)
4. [Filtro de Fulfillment](#4-filtro-de-fulfillment)
5. [Componentes Compartidos](#5-componentes-compartidos)
6. [Columnas de la Tabla](#6-columnas-de-la-tabla)
7. [Detail View: Medusa Nativo + QB Widget](#7-detail-view-medusa-nativo--qb-widget)
8. [Lifecycle: Sales Order → Invoice](#8-lifecycle-sales-order--invoice)
9. [QuickBooks Integration en Invoices](#9-quickbooks-integration-en-invoices)
10. [Diferencias clave vs Sales Orders](#10-diferencias-clave-vs-sales-orders)
11. [Known Issues & Gotchas](#11-known-issues--gotchas)

---

## 1. File Structure

```
backend/src/
│
├── admin/
│   ├── routes/
│   │   ├── orders-2-invoices/
│   │   │   └── page.tsx                  ← Entrada de sidebar (config + render)
│   │   │
│   │   ├── invoices/
│   │   │   └── page.tsx                  ← Página original (sin config de sidebar)
│   │   │
│   │   └── sales-orders/                 ← Lógica compartida (hook + components)
│   │       ├── hooks/
│   │       │   └── use-orders-list.ts    ← Hook genérico (reutilizado aquí)
│   │       └── components/
│   │           └── orders-table.tsx      ← Componentes compartidos
│   │
│   └── widgets/
│       └── quickbooks-order-widget.tsx   ← Widget QB en página de detalle nativa
│
└── api/admin/quickbooks/
    └── order/route.ts                    ← POST: sync/re-sync orden como QB Sales Order
```

> **¿Por qué `orders-2-invoices` e `invoices`?**  
> El prefijo numérico controla el orden en la sidebar de Medusa.  
> La lógica real vive en `invoices/` (sin prefijo). `orders-2-invoices/page.tsx` solo  
> reexporta la config y el componente con el nombre correcto para que Medusa lo registre en el lugar correcto.

---

## 2. Arquitectura General

```
orders-2-invoices/page.tsx
    │
    ├── useOrdersList(["fulfilled", "delivered"])
    │       └── /admin/orders?limit=250&fields=...  (fetch único al montar)
    │
    ├── OrdersControls  (search Input + Sort Select)   ← Sin toggle Show Cancelled
    ├── OrdersTable     (grid con 9 columnas, 20 items/página)
    └── OrdersFooter    (count + Prev/Next)
```

La página es **idéntica a Sales Orders** en estructura, con dos diferencias:
1. `fulfillmentFilters = ["fulfilled", "delivered"]` en lugar de `["not_fulfilled", "partially_fulfilled"]`
2. **Sin botón "Create"** — las invoices son read-mostly
3. **Sin toggle Show Cancelled** — actualmente no implementado en Invoices (los `OrdersControls` no reciben `onToggleCancelled`)

---

## 3. Sidebar Config & Ordenamiento

```typescript
// orders-2-invoices/page.tsx
export const config = defineRouteConfig({
    label: "Invoices",
    icon: DocumentText,
    nested: "/orders",
})
```

| Sección | Orden | Página |
|---------|-------|--------|
| Drafts | 1° | `/draft-orders-advanced` (built-in) |
| Sales Orders | 2° | `/orders-1-sales` |
| **Invoices** | 3° | `/orders-2-invoices` ← (esta página) |

---

## 4. Filtro de Fulfillment

### ¿Qué es una "Invoice" en este contexto?

En la terminología EcoPowerTech, un **Invoice** es cualquier orden de Medusa cuyo `fulfillment_status` sea:

| Status | Significado |
|--------|-------------|
| `fulfilled` | El proveedor marcó todos los items como cumplidos |
| `delivered` | Entrega confirmada por el cliente o sistema externo |

### ¿Qué NO aparece en Invoices?

| Fulfillment Status | Aparece en |
|-------------------|------------|
| `not_fulfilled` | Sales Orders |
| `partially_fulfilled` | Sales Orders |
| `fulfilled` | **Invoices** ✅ |
| `delivered` | **Invoices** ✅ |

> **Nota sobre canceladas:** El hook `useOrdersList` filtra `status !== "canceled"` por defecto.  
> Pero en la página de Invoices **no se expone el toggle Show Cancelled** — las canceladas son invisibles.  
> Si se necesita ver invoices canceladas, hacerlo directamente desde Medusa nativo o agregar el toggle.

---

## 5. Componentes Compartidos

Invoices reutiliza **exactamente** los mismos componentes que Sales Orders sin modificación.  
Ver documentación completa en [SALES_ORDERS_UI.md → Sección 5](./SALES_ORDERS_UI.md#5-componentes-compartidos).

### Resumen de uso en Invoices

```tsx
// orders-2-invoices/page.tsx
const InvoicesPage = () => {
    const {
        navigate, loading, sorted, paginated, totalPages,
        search, setSearch, sort, setSort, page, setPage,
    } = useOrdersList(["fulfilled", "delivered"])  // ← filtro diferente

    return (
        <div>
            <Heading>Invoices</Heading>
            <Text>Fully fulfilled and delivered orders. ({sorted.length})</Text>
            {/* SIN botón Create */}

            <OrdersControls
                search={search} onSearchChange={handleSearchChange}
                sort={sort} onSortChange={handleSortChange}
                searchPlaceholder="Search by #, customer, company or email..."
                // SIN showCancelled props → botón no se renderiza
            />
            <OrdersTable
                loading={loading} sorted={sorted} paginated={paginated}
                onRowClick={id => navigate(`/orders/${id}`)}
            />
            <OrdersFooter itemLabel="invoice" ... />
        </div>
    )
}
```

---

## 6. Columnas de la Tabla

Idénticas a Sales Orders. Misma definición de grid CSS.

| # | Header | Fuente | Notas |
|---|--------|--------|-------|
| 1 | Order # | `order.display_id` | `#1089` |
| 2 | QB Ref # | `metadata.qb_sales_order_ref` o `qb_invoice_ref` | Font mono, `—` si aún no sincronizado |
| 3 | Date | `order.created_at` | `Mar 6, 2026` |
| 4 | Company | `customer.company_name` o `shipping_address.company` | Truncado 2 líneas |
| 5 | Customer | `first_name + last_name` o email | Truncado |
| 6 | Payment | `order.payment_status` | Badge de color |
| 7 | Fulfillment | `order.fulfillment_status` | Badge verde (`fulfilled`) o verde (`delivered`) |
| 8 | Channel | `sales_channel.name` | "Default" si es el canal default |
| 9 | Total | `order.total` | Alineado a la derecha, en dólares |

En la columna QB Ref #, las órdenes en Invoices pueden tener:
- `qb_sales_order_ref` — número de Sales Order QB (creado al completar el Draft Order)
- `qb_invoice_ref` — número de Invoice QB (si se generó Invoice en QB Desktop)

---

## 7. Detail View: Medusa Nativo + QB Widget

**Invoices NO tiene página de detalle custom.** Click en fila navega a:

```
/orders/:id  →  Medusa Admin nativo
```

### QuickBooks Order Widget

**Archivo:** `admin/widgets/quickbooks-order-widget.tsx`  
**Zone:** `order.details.before`

Mismo widget que en Sales Orders. En el contexto de Invoices, es especialmente relevante porque aquí se pueden ver los TxnIDs de tipo Invoice:

| Campo metadata | Descripción |
|----------------|-------------|
| `qb_sales_order_txn_id` | TxnID del Sales Order en QB |
| `qb_sales_order_ref` | Número de ref del SO en QB (e.g. "6178") |
| `qb_payment_txn_id` | TxnID del pago en QB (si existe) |
| `qb_invoice_txn_id` | TxnID de la Invoice en QB (si existe) |

**Auto-polling:** Si `qb_sales_order_txn_id` falta, el widget hace polling cada **8 segundos** mostrando `⏳ Pending QB sync...`.

**Botón "Re-sync Sales Order":** Permite forzar la sincronización manual si el subscriber falló.

---

## 8. Lifecycle: Sales Order → Invoice

```
[Sales Order] (orders-1-sales)
    │
    │   fulfillment_status = "not_fulfilled" | "partially_fulfilled"
    │
    ├── [Partial fulfillment]
    │       fulfillment_status → "partially_fulfilled"
    │       → Sigue en Sales Orders
    │
    └── [Full fulfillment]
            fulfillment_status → "fulfilled"
            │
            ▼
    [Invoice] (orders-2-invoices)   ← APARECE AQUÍ
            │
            │   status = "completed" (típicamente)
            │   fulfillment_status = "fulfilled" | "delivered"
            │
            └── [Entrega confirmada]
                    fulfillment_status → "delivered"
                    → Sigue en Invoices (delivered también se muestra)
```

### Transición automática

La aparición de una orden en Invoices es **completamente automática** — no hay acción manual.  
Cuando el personal de fulfillment marca todos los items como "fulfilled" en Medusa:
1. Medusa actualiza `fulfillment_status → "fulfilled"` en la orden
2. La orden deja de aparecer en Sales Orders (ya no cumple el filtro `not_fulfilled | partially_fulfilled`)
3. La orden aparece en Invoices (ahora cumple el filtro `fulfilled | delivered`)

> El siguiente F5 o navegación a la página reflejará el cambio (fetch al montar).

---

## 9. QuickBooks Integration en Invoices

Cuando una orden llega a estado `fulfilled`, el Sales Order en QuickBooks Desktop debería estar en estado **"Closed"** o tener una Invoice asociada. Medusa no automatiza esto directamente — el proceso QB sigue el lifecycle del Draft Order:

```
Draft Order → QB Estimate
    ↓ (convert-force / order.placed event)
Sales Order → QB Sales Order (SO)
    ↓ (fulfillment en Medusa → acción manual en QB)
Invoice → QB Invoice (proceso manual en QB Desktop)
```

### ¿Por qué `qb_invoice_ref` puede existir?

Si el equipo de QB Desktop genera un Invoice desde el Sales Order en QB, el subscriber o proceso de sync puede guardar ese TxnID en `metadata.qb_invoice_txn_id` y `metadata.qb_invoice_ref`. El widget lo muestra si existe.

### Advertencia sobre Cancel en Invoices

Si una orden `fulfilled` se cancela en Medusa:
- El subscriber emite un evento que intenta cerrar el Sales Order o voidear la Invoice en QB
- Activity log registra: `"SO #XXXX closed for Order #XXXX"` o similar
- La orden queda `status: "canceled"` y **desaparece de Invoices** (el filtro oculta canceladas por defecto)
- Para verla, acceder directamente vía Medusa nativo: `/orders/:id`

---

## 10. Diferencias Clave vs Sales Orders

| Aspecto | Sales Orders | Invoices |
|---------|-------------|---------|
| **Ruta sidebar** | `orders-1-sales` | `orders-2-invoices` |
| **fulfillmentFilters** | `["not_fulfilled", "partially_fulfilled"]` | `["fulfilled", "delivered"]` |
| **Botón Create** | ✅ Sí (`/orders/create`) | ❌ No |
| **Toggle Show Cancelled** | ✅ Sí (con counter) | ❌ No (actualmente) |
| **Semántica** | Órdenes en proceso | Órdenes completadas |
| **QB Ref típico** | `qb_sales_order_ref` | `qb_sales_order_ref` + posible `qb_invoice_ref` |
| **itemLabel footer** | `"sales order"` | `"invoice"` |
| **Icon sidebar** | `ShoppingCart` | `DocumentText` |

---

## 11. Known Issues & Gotchas

### Sin Show Cancelled en Invoices

Actualmente la página de Invoices no expone el toggle "Show Cancelled". Si un invoice fue cancelado, no aparece en la lista. Para verlo: acceder a Medusa nativo (`/orders/:id`) directamente.

Para agregar el toggle a Invoices en el futuro, basta con pasar las props opcionales a `OrdersControls`:

```tsx
// En orders-2-invoices/page.tsx — agregar estas props a useOrdersList y OrdersControls:
const { ..., showCancelled, setShowCancelled, cancelledCount } = useOrdersList([...])

<OrdersControls
    ...
    showCancelled={showCancelled}
    onToggleCancelled={() => { setShowCancelled(v => !v); setPage(0) }}
    cancelledCount={cancelledCount}
/>
```

### Órdenes Parcialmente Cumplidas

`partially_fulfilled` aparece en **Sales Orders**, no en Invoices. Una orden solo pasa a Invoices cuando **TODOS** sus items están cumplidos (`fulfilled`).

### Fetch Único al Montar

No hay polling ni subscripción a eventos. Si una orden pasa de `not_fulfilled` a `fulfilled` mientras la página está abierta, el cambio no se refleja hasta que el usuario navegue fuera y regrese (o recargue).

### Precios en Dólares

`/admin/orders` retorna `total` en dólares (no centavos). No dividir por 100.

### Sales Channel "Default"

El nombre `"Default Sales Channel"` se normaliza a `"Default"` en la columna Channel.

---

**Última actualización:** 2026-03-06  
**Versión:** 1.0 — Documentación inicial

---

## Nota: POS Invoice y Order Summary

> Este documento cubre el módulo de **Invoices del Admin Panel** de Medusa (`backend/src/admin/`).
>
> La página de **Invoice del POS** (`ecopowertech-store-pos/app/(pos)/invoices/[id]/page.tsx`) es una entidad separada. Usa el mismo componente compartido `components/pos/OrderSummary.tsx`.
>
> **Marzo 13, 2026:** El Order Summary del POS fue actualizado para separar descuentos inline vs. global. Ver `POS_ESTIMATES.md § 29` para la documentación completa del cambio.
