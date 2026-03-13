# POS_ORDERS — Órdenes de Venta (POS App)

| Campo | Detalle |
|-------|---------|
| **Módulo** | Orders |
| **Rutas POS** | `/orders`, `/orders/[id]` |
| **Medusa** | Orders (`GET /admin/orders`) |
| **QB Docs** | Sales Receipt · Sales Order + Invoice |
| **Última revisión** | 2026-03-10 |

---

## Tipos de Venta POS

| Tipo | Cuándo usar | Documento QB | Flujo Medusa |
|------|------------|-------------|-------------|
| **Sales Receipt** | Cliente paga en el momento (mostrador) | Sales Receipt | Order capturada inmediatamente |
| **Sales Order** | Cliente paga después (B2B on account) | Sales Order → Invoice | Order → Fulfill → Capture |
| **Estimate → Order** | Cotización aprobada | Estimate → SO → Invoice | Draft → Convert → Fulfill |

---

## Dashboard de Órdenes (`/orders`)

**Archivo:** `ecopowertech-store-pos/app/(pos)/orders/page.tsx`

### Fuente de Datos

- **Primaria:** `GET /admin/orders?limit=500&fields=...` (mismo endpoint del admin panel)
- Reemplaza MeiliSearch para mayor fidelidad de datos (company, metadata, phone)
- Auto-refresh cada 30s + en window focus

### Campos Expandidos en el Fetch

```
id, display_id, status, payment_status, fulfillment_status,
total, created_at, email, metadata,
+customer.first_name, +customer.last_name, +customer.email,
+customer.phone, +customer.company_name,
+billing_address.company,
+sales_channel.name
```

### Columnas de la Tabla

| Columna | Fuente |
|---------|--------|
| # | `display_id` |
| QB Ref # | `metadata.qb_sales_order_ref_num` o `qb_invoice_ref_num` |
| Customer | `customer.first_name + last_name` |
| Company | `customer.company_name` o `billing_address.company` |
| Payment | `payment_status` (badge coloreado) |
| Fulfillment | `fulfillment_status` (badge coloreado) |
| Total | `total` en dólares |
| Date | `created_at` (format: MMM d, yyyy) |

### Tabs (client-side)

| Tab | Criterio | Equivalente QB |
|-----|----------|---------------|
| **All** | Todo (sin cancelled por default) | — |
| **Open** | `not_fulfilled` OR `partially_fulfilled` | Sales Order abierto |
| **Closed** | `fulfilled` OR `shipped` OR `delivered` | Facturado/cerrado |

Cada tab muestra su conteo dinámico en el label.

### Filtros Adicionales

| Filtro | Comportamiento |
|--------|---------------|
| **Show Cancelled** | Pill toggle — oculta `status: canceled` por default |
| **Payment dropdown** | All / Unpaid / Awaiting / Authorized / Paid |

### Búsqueda (client-side)

Busca por: `customer name`, `company`, `email`, `#display_id`, `phone (solo dígitos)`.

```ts
name.includes(q) || email.includes(q) || company.includes(q) ||
`#${o.display_id}`.includes(q) ||
(digits.length > 0 && phone.includes(digits))
```

### Badge Maps

**Payment:**
| Status | Color |
|--------|-------|
| `not_paid` | rojo |
| `awaiting` | ámbar |
| `authorized` | azul |
| `captured` | verde |
| `partially_paid` | ámbar |

**Fulfillment:**
| Status | Color |
|--------|-------|
| `not_fulfilled` | rojo |
| `partially_fulfilled` | ámbar |
| `fulfilled` / `shipped` / `delivered` | verde |

---

## Flow A — Sales Receipt (Pago Inmediato)

```
POS Staff: selecciona productos, cliente paga
│
├── 1. POST /admin/orders
│        { customer_id, items, payment_status: 'captured',
│          sales_channel_id: POS_SALES_CHANNEL_ID }
│        → order.id
│
└── 2. POST /admin/quickbooks/sales-receipt
         { orderId: order.id, paymentMethod: 'Credit Card' | 'Cash' | 'Check' }
         → QB Sales Receipt creado
         → Metadata: qb_sales_receipt_txn_id, qb_sales_receipt_operation_id
```

> El subscriber `qb-order-subscriber.ts` **skipea** automáticamente órdenes del canal POS → no se crea duplicado en QB.

---

## Flow B — Sales Order (On Account)

```
POS Staff: venta a crédito (pagar después)
│
├── 1. [Opcional] Viene de un Estimate convertido (ver POS_ESTIMATES.md)
│    O bien: Order creada directamente con payment_status: 'not_paid'
│
├── 2. POST /admin/quickbooks/order
│        { orderId }
│        → QB Sales Order creado
│        → Metadata: qb_sales_order_ref_num
│
├── 3. [Al despachar] POST /admin/orders/:id/fulfillments
│        → POST /admin/quickbooks/invoice { orderId, fulfillmentId }
│        → QB Invoice creada
│
└── 4. [Al pagar] → ver POS_CAPTURE_PAYMENT.md
```

---

## Detalle de Orden (`/orders/[id]`)

### Acciones disponibles

| Acción | Descripción |
|--------|-------------|
| **Create Sales Receipt** | Pago inmediato → QB Sales Receipt |
| **Create QB Sales Order** | On account → QB Sales Order |
| **Fulfill Items** | Crear shipment parcial o total |
| **Receive Payment** | Abrir módulo Capture Payment (ver POS_CAPTURE_PAYMENT.md) |
| **Cancel Order** | Cancelar + void en QB si aplica |

---

## Multi-Fulfillment (Envíos Parciales)

```
Order #1089 (QB Sales Order)
│
├── Fulfillment 1: Items A, B   → QB Invoice #6180
├── Fulfillment 2: Item C       → QB Invoice #6195
└── Fulfillment 3: Item D       → QB Invoice #6210
```

> Para órdenes POS, el subscriber está skipeado. El POS debe llamar `POST /admin/quickbooks/invoice` por cada fulfillment manualmente.

---

## Cancelación

```
DELETE /admin/quickbooks/sales-receipt  (si era Sales Receipt)
POST   /admin/orders/:id/cancel         (Medusa)
```

> El subscriber **no** voidea Sales Receipts en QB para órdenes POS. La cancelación debe hacerse explícitamente desde el POS.

---

## Metadata QB en Órdenes

```json
{
  "qb_sales_receipt_txn_id": "...",
  "qb_sales_receipt_operation_id": "...",
  "qb_sales_order_ref_num": "6161",
  "qb_so_txn_id": "...",
  "qb_invoice_txn_ids": ["...", "..."],
  "qb_invoice_ref_num": "6136"
}
```

---

## Known Issues

| Issue | Fix |
|-------|-----|
| Sales Receipt sin TxnID inmediato | Bridge async — usar `qb_sales_receipt_operation_id` para polling |
| Subscriber crea duplicado en QB | Verificar `POS_SALES_CHANNEL_ID` en `qb-order-subscriber.ts` |
| Invoice no creada al fulfillment | POS debe llamar `POST /admin/quickbooks/invoice` manualmente |
| Company no aparece en la tabla | Verificar `customer.company_name` o `billing_address.company` en la orden |
| QB Ref # muestra `—` | La orden no fue sincronizada con QB aún — usar los botones de sync en el detalle |

---

## Changelog — Marzo 10, 2026

### Activity Log en Orders

El detalle de orden (`/orders/[id]`) incluye un **Activity Log** (panel derecho, `w-52`) usando el endpoint nativo de Medusa v2:

```
GET /admin/orders/{id}/changes
```

> ❌ NO usar `/admin/notes` — es el endpoint legacy incorrecto.

**Props del componente:**

```tsx
<ActivityLog
    medusaId={order.doc.medusaId}
    metadata={order.order?.metadata}
    createdAt={order.order?.metadata?.confirmed_at ?? order.order?.created_at}
    context="order"
/>
```

**¿Por qué `metadata.confirmed_at` y no `order.created_at`?**

Medusa conserva el `created_at` del draft original cuando se convierte a order. Si un draft fue creado hace 2 semanas y recién se confirmó hoy, el Activity Log mostraría "Order placed: 2 weeks ago" — incorrecto.

La solución: `handleConfirmOrder` escribe `confirmed_at: new Date().toISOString()` en metadata después del `convert-force`. El Activity Log lee ese campo como anchor para el evento "Sales Order created".

**Resolución de usuario:**
- La Activity Log llama a `/api/pos/admin-user?id={userId}` para mostrar el nombre del admin junto a cada evento.

---

### Dos Eventos de Ciclo de Vida Distintos

Una orden que viene de un Estimate tiene **dos eventos diferenciados** en el Activity Log:

| Evento | Cuándo ocurre | Timestamp | Vista donde aparece |
|--------|---------------|-----------|---------------------|
| **"Estimate created"** | Al crear el Draft Order | `order.created_at` | Estimates (`context='estimate'`) |
| **"Sales Order created"** | Al convertir con `convert-force` | `metadata.confirmed_at` | Orders (`context='order'`) |

Esto es el mismo comportamiento que Medusa Admin: los draft orders son cotizaciones de referencia para el cliente; la sales order es el compromiso de compra confirmado.

---

### Items Toolbar en Orders (Read-Only)

A diferencia de Estimates, el toolbar de items en Orders **no tiene botones de acción**:

| Botón | Estimates | Orders |
|-------|-----------|--------|
| `ItemSearch` | ✅ | ✅ |
| `Categories` (agregar productos) | ✅ | ❌ |
| `Comment` (agregar section header) | ✅ | ❌ |
| `Discounts` (BulkDiscountModal) | ✅ | ❌ |
| `Expand` (Maximize2) | ✅ | ✅ |

Los Orders son órdenes confirmadas — modificaciones deben ir por el flujo de Order Edit de Medusa, no por el POS.

**Código del toolbar en `/orders/[id]/page.tsx`:**

```tsx
{/* ROW 3 — Items (read-only toolbar) */}
<div className="flex items-center gap-3">
    <Package className="w-3.5 h-3.5 text-accent" />
    <span>Items ({order.doc.items.length})</span>
    <div className="w-64 flex-shrink-0">
        <ItemSearch />
    </div>
    {/* ← Sin botones de acción aquí → */}
    <button onClick={() => setItemsModalOpen(true)} title="Expanded view">
        <Maximize2 className="w-3.5 h-3.5" />
    </button>
</div>
```

---

### Metadata QB Completa (con `confirmed_at`)

```json
{
  "confirmed_at": "2026-03-10T20:00:00.000Z",
  "qb_sales_receipt_txn_id": "...",
  "qb_sales_receipt_operation_id": "...",
  "qb_sales_order_ref_num": "6161",
  "qb_so_txn_id": "...",
  "qb_invoice_txn_ids": ["...", "..."],
  "qb_invoice_ref_num": "6136"
}
```

---

## REFERENCIA TÉCNICA EXHAUSTIVA

> Esta sección documenta el código fuente completo. Un desarrollador puede implementar o mantener el módulo Orders consultando únicamente este documento.

---

## A. useOrderData — Hidratación desde Medusa

**Archivo:** `app/(pos)/orders/[id]/hooks/useOrderData.ts`

### A.1 Diferencia crítica con Estimates

| Aspecto | Estimates | Orders |
|---------|-----------|--------|
| Endpoint principal | `GET /admin/draft-orders/{id}` | `GET /admin/orders/{id}` |
| Endpoint customer | `GET /admin/orders/{id}` | `GET /admin/orders/{id}` |
| Query key | `['estimate', id]` | `['order', id]` |
| Type en posStore | `'estimate'` | `'order'` |
| Fallback `cart.*` | ✅ necesario | ❌ no aplica (orders tienen `items` directamente) |
| `+cart.*` en fields | ✅ | ❌ |

### A.2 Campos expandidos

```ts
const ORDER_FIELDS = [
    '+items.*', '+items.metadata',
    '+items.variant.*', '+items.variant.metadata', '+items.variant_id',
    '+shipping_address.*', '+billing_address.*',
    '+shipping_methods.*',
    '+customer_id', '+customer.*',
    '+metadata', '+email', '+status',
    '+payment_status',       // 'awaiting' | 'captured' | 'refunded' | etc.
    '+fulfillment_status',   // 'not_fulfilled' | 'fulfilled' | 'shipped' | etc.
    '+currency_code'
].join(',')
// Query: GET /admin/orders/{id}?fields=...
// Query key: ['order', id]   ← staleTime: 60_000ms
```

### A.3 Hydration guard — Orders siempre re-hidratan

A diferencia de Estimates (que tienen un guard `hasLocalWork` para proteger cambios locales no guardados), **en Orders el guard fue eliminado**:

```ts
// useOrderData.ts — sin guard
// Las Orders son read-only en el POS (Save = toast informativo).
// Siempre re-hidratamos desde el servidor para garantizar isDirty=false.
current.hydrateDocument({ ... })  // siempre se ejecuta
```

**¿Por qué se eliminó el guard?**

Las Orders confirmadas no se pueden editar via el POS Store (`handleSave` muestra un toast). El guard `hasLocalWork` estaba causando un **false-positive de isDirty** — si el `draftCache` de localStorage tenía un slot de una sesión anterior con `isDirty: true`, el guard saltaba `hydrateDocument` (que resetea `isDirty=false`) y la orden mostraba el botón Save en ámbar sin ningún cambio real del usuario.

Eliminar el guard garantiza:
- `isDirty` siempre `false` al cargar una orden
- `draftCache` stale de sesiones anteriores no contamina el estado
- Consistencia visual: el botón Save nunca aparece activo sin razón

### A.4 Hydration completa — campos mapeados

```ts
current.hydrateDocument({
    medusaId: o.id,
    type: 'order',                     // ← distingue de 'estimate'
    customerId: hydratedCustomer?.id ?? o.customer_id ?? o.customer?.id ?? null,
    customerName: `${hydratedCustomer.first_name} ${hydratedCustomer.last_name}`,
    customerCompany: hydratedCustomer?.company_name ?? '',
    customerPhone: hydratedCustomer?.phone ?? '',
    customerEmail: o.email ?? hydratedCustomer?.email ?? '',
    estimateStatus: o.status ?? o.metadata?.order_status ?? 'Created',
    // ^ orders usan el campo nativo `o.status` ('pending'|'completed'|'canceled')
    leadTime: o.metadata?.lead_time ?? '',
    paymentTerms: o.metadata?.payment_terms ?? '',
    orderType: o.metadata?.order_type ?? '',
    projectName: o.metadata?.project_name ?? '',
    customerPO: o.metadata?.customer_po ?? '',
    salesRep: o.metadata?.sales_rep ?? '',
    note: o.metadata?.pos_notes ?? '',
    taxMode: o.metadata?.tax_mode ?? 'auto',
    taxEnabled: o.metadata?.tax_enabled ?? true,
    taxRate: o.metadata?.tax_rate ?? 7,
    shippingAddress: mapAddr(o.shipping_address),   // ← sin fallback a cart
    billingAddress: mapAddr(o.billing_address),      // ← sin fallback a cart
    shippingAddressId: null,
    discountType: o.metadata?.discount_type ?? 'percent',
    discountValue: o.metadata?.discount_value ?? 0,
    promotionId: null,
    promotionCode: o.metadata?.promotion_code ?? null,
    commentLines: JSON.parse(o.metadata?.pos_comment_lines ?? 'null') ?? [],
    shippingOptionId: shippingMethod?.shipping_option_id ?? shippingMethod?.shipping_option?.id ?? null,
    shippingOptionName: shippingMethod?.shipping_option?.name ?? shippingMethod?.name ?? null,
    shippingPrice: shippingMethod?.price_incl_tax ?? shippingMethod?.price ?? shippingMethod?.amount ?? 0,
    lastSavedAt: o.metadata?.last_saved_at ?? null,
    items: (o.items ?? [])             // ← orders tienen items directamente, sin cart fallback
        .filter(i => (i.quantity ?? 0) > 0)
        .sort((a, b) => (a.metadata?.sort_order ?? 9999) - (b.metadata?.sort_order ?? 9999))
        .map((i, idx) => ({
            localId: i.id,
            variantId: i.variant_id ?? '',
            productId: i.variant?.product_id ?? '',
            title: i.title ?? '',
            salesDescription:
                i.variant?.metadata?.sales_description
                ?? i.metadata?.sales_description
                ?? undefined,
            variantTitle: i.description ?? i.variant?.title ?? '',
            sku: i.variant?.sku ?? i.variant_sku ?? '',
            thumbnail: i.thumbnail ?? null,
            options: (i.variant?.options ?? [])
                .filter(opt => opt.value && opt.value !== 'Default Title')
                .map(opt => ({ title: opt.option?.title ?? '', value: opt.value })),
            quantity: i.quantity,
            unitPrice: i.metadata?.original_unit_price ?? i.unit_price,
            priceListId: null,
            priceListLabel: 'Default',
            lineDiscount: i.metadata?.line_discount ?? undefined,
            sortOrder: i.metadata?.sort_order ?? idx,
        })),
})
```

### A.5 Batch-fetch de precios (idéntico al de Estimates)

```ts
// GET /admin/draft-orders/{id}/variant-prices?variant_ids[]=xxx&...
// ⚠️ Nota: usa el endpoint de DRAFT-ORDERS aunque sea una Order confirmada.
//    Esto es intencional — el endpoint custom acepta cualquier ID como contexto.
// Enriches availablePrices en cada item del store. NO marca isDirty.
```

---

## B. useOrderActions — Acciones Disponibles

**Archivo:** `app/(pos)/orders/[id]/hooks/useOrderActions.ts`

### B.1 handleSave — Read-Only

```ts
const handleSave = useCallback(async () => {
    toast.info('Orders are read-only in the POS. Please use the Medusa Admin.')
}, [])
// ⚠️ Las Orders confirmadas NO se pueden editar vía POS Store.
// Para editar una Order, usar Order Edit en el Medusa Admin.
```

### B.2 handleEmail

```ts
const handleEmail = useCallback(async () => {
    if (!doc.customerEmail) {
        toast.error('No customer email on this order')
        return
    }
    toast.info(`Email to ${doc.customerEmail} — coming soon`)
    await writeActivityNote(doc.medusaId, {
        event: 'email_sent',
        user: actingUser,
        detail: `to: ${doc.customerEmail}`,
    })
}, [...])
```

### B.3 handleConfirmOrder — No-op

```ts
const handleConfirmOrder = useCallback(async () => {
    toast.info('This is already a confirmed order.')
}, [])
// Las Orders ya están confirmadas — el botón "Confirm" del DocumentToolbar
// muestra este toast en lugar de ejecutar el flujo de conversión.
```

### B.4 writeActivityNote — Diferencia clave con Estimates

```ts
// En Estimates: resource_type = 'draft-order'
// En Orders:    resource_type = 'order'   ← DIFERENTE
await medusaFetch('/api/pos/notes', {
    method: 'POST',
    token,
    body: {
        resource_type: 'order',      // ← Orders usan este tipo
        resource_id: noteId,
        value: encodeActivityNote(payload),
    },
})
// encodingActivityNote(payload) → '__pos_activity__' + JSON.stringify(payload)
// El ActivityLog parser lee las notas de /admin/orders/{id}/changes → las integra al timeline.
```

---

## C. Toolbar de Items — Layout Exacto

**Archivo:** `app/(pos)/orders/[id]/page.tsx` (líneas 93–161)

### C.1 Layout visual

```
┌─────────────────────────────────────────────────────────────────────┐
│ 📦 Items (N) | [🔍 ItemSearch____________] [⊞ Categ] [⚙ Tools] [🏷 Disc] ──────── [↗] │
└─────────────────────────────────────────────────────────────────────┘
```

```tsx
<div className="flex items-center gap-3">
    {/* Ícono + label */}
    <Package className="w-3.5 h-3.5 text-accent flex-shrink-0" />
    <span className="text-xs font-semibold">Items ({doc.items.length})</span>

    {/* Buscador — ancho fijo 256px */}
    <div className="w-64 flex-shrink-0">
        <ItemSearch />
    </div>

    {/* Categories — abre CategoriesModal */}
    <button onClick={() => setCatModalOpen(true)} className="...">
        <LayoutGrid className="w-3 h-3" /> Categories
    </button>

    {/* Tools — DESHABILITADO (placeholder para futuras herramientas) */}
    <button disabled title="Tools (coming soon)" className="opacity-40 cursor-not-allowed ...">
        <Wrench className="w-3 h-3" /> Tools
    </button>

    {/* Discounts — abre BulkDiscountModal (amber) */}
    <button onClick={() => setDiscountModalOpen(true)} disabled={doc.items.length === 0} className="bg-amber-500/10 ...">
        <Tag className="w-3 h-3" /> Discounts
    </button>

    {/* Spacer — empuja Expand al extremo derecho */}
    <div className="flex-1" />

    {/* Expand — abre ItemsExpandedModal */}
    <button onClick={() => setItemsModalOpen(true)} title="Expanded view" className="...">
        <Maximize2 className="w-3.5 h-3.5" />
    </button>
</div>
```

### C.2 Comparativa Estimates vs. Orders

| Botón | Estimates | Orders | Notas |
|-------|:---------:|:------:|-------|
| `ItemSearch` | ✅ | ✅ | Siempre visible |
| `Categories` | ✅ | ✅ | Abre `CategoriesModal` |
| `Comment` | ✅ | ❌ | Solo Estimates (section headers QB) |
| `Tools` | ❌ | ✅ disabled | Placeholder para futuras acciones |
| `Discounts` | ✅ | ✅ | Abre `BulkDiscountModal` |
| `Expand` | ✅ (far right) | ✅ (far right) | Abre `ItemsExpandedModal` |

---

## D. BulkDiscountModal — Wiring en Orders

Orders usan exactamente el mismo `BulkDiscountModal.tsx` que Estimates. La diferencia es que el `onApply` no dispara un save automático — los cambios quedan en el posStore y el usuario debe guardar si desea persistirlos (aunque actualmente el save en Orders es read-only, los descuentos locales se aplican a los cálculos de `computeTotals` visualmente).

```tsx
<BulkDiscountModal
    open={discountModalOpen}
    onClose={() => setDiscountModalOpen(false)}
    items={order.doc.items.map(item => ({
        id: item.localId,
        sku: item.sku ?? undefined,
        title: item.title ?? '',
        description: item.salesDescription ?? null,
        thumbnail: item.thumbnail ?? null,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        existingDiscount: item.lineDiscount ?? null,
    }))}
    onApply={(updates) => {
        updates.forEach(({ itemId, discountType, discountValue }) => {
            const item = order.doc.items.find(i => i.localId === itemId)
            if (item) {
                usePOSStore.getState().updateItemDiscount(item.localId, discountType, discountValue)
            }
        })
    }}
/>
```

---

## E. ActivityLog — Configuración en Orders

```tsx
<ActivityLog
    medusaId={order.doc.medusaId}
    metadata={order.order?.metadata}
    createdAt={
        order.order?.metadata?.confirmed_at   // ← usa confirmed_at (fecha de conversión)
        ?? order.order?.created_at             // ← fallback: created_at del draft original
    }
    context="order"   // ← muestra "Order placed" en lugar de "Estimate created"
/>
```

**¿Por qué `confirmed_at` tiene prioridad?**

Medusa preserva el `created_at` del draft order original al convertirlo. Si el draft se creó hace 2 semanas y se confirmó hoy, el evento ancla "Order placed" aparecería hace 2 semanas — incorrecto. El `confirmed_at` escrito en `handleConfirmOrder` registra el momento exacto de la confirmación.

**Evento ancla para context='order':**

```ts
// En parseOrderChanges():
{
    id: `${orderId}-created`,
    created_at: orderCreatedAt,   // ← se pasa confirmed_at ?? created_at
    title: 'Order placed',
    description: 'Order placed by customer / POS',
    icon: <ShoppingCart className="w-3 h-3" />,
    color: 'text-accent',
}
```

**Evento "Order confirmed" (desde metadata.confirmed_at):**

```ts
// ActivityLog también lee metadata.confirmed_at para mostrar el evento:
const confirmedAt = metadata?.confirmed_at
if (confirmedAt) {
    events.push({
        id: `confirmed-${confirmedAt}`,
        created_at: confirmedAt,
        title: 'Order confirmed',
        description: metadata?.confirmed_order_display_id
            ? `Order #${metadata.confirmed_order_display_id}`
            : 'Estimate converted to Order',
        icon: <ClipboardCheck className="w-3 h-3" />,
        color: 'text-emerald-400',
    })
}
```

---

## F. Layout de Página — 7-Row Stack

**Archivo:** `app/(pos)/orders/[id]/page.tsx`

```
┌─────────────────────────────────────────────────────┐ ┌──────────┐
│ ROW 1: CustomerStrip (Contact | Shipping | Billing) │ │          │
├─────────────────────────────────────────────────────┤ │ Activity │
│ ROW 2: OrderMetaFields (4 dropdowns)                │ │   Log    │
├─────────────────────────────────────────────────────┤ │  w-52    │
│ ROW 3: Items (flex-1 — única zona con scroll)       │ │  w-52    │
│   ┌─ Toolbar ─────────────────────────────────────┐ │ │ flex-    │
│   │ Categories | Tools | Discounts | ─── | Expand │ │ │ shrink-0 │
│   └────────────────────────────────────────────────┘ │ │          │
│   <LineItemsTable />                                 │ │ Timeline │
├─────────────────────────────────────────────────────┤ │ vertical │
│ ROW 4: PromotionStrip                               │ │          │
├──────────────────┬──────────────┬───────────────────┤ │          │
│ ROW 5: NoteArea  │ ROW 6: Ship  │ ROW 7: Summary    │ │          │
│   (flex-3)       │   (flex-2)   │   (w-64)          │ │          │
└──────────────────┴──────────────┴───────────────────┘ └──────────┘
```

**Clases de layout del contenedor principal:**

```tsx
{/* Outer: flex row, full height, no overflow */}
<div className="flex flex-1 min-h-0 px-4 pt-3 pb-3 gap-2 overflow-hidden">

    {/* Left column: 7-row stack */}
    <div className="flex flex-col flex-1 min-h-0 gap-2 overflow-hidden min-w-0">
        {/* ROW 1 */} <CustomerStrip />
        {/* ROW 2 */} <div className="pos-card flex-shrink-0 px-4 py-2.5"><OrderMetaFields /></div>
        {/* ROW 3 */} <div className="pos-card flex flex-col flex-1 min-h-0 overflow-hidden">...</div>
        {/* ROW 4 */} <div className="pos-card flex-shrink-0 px-4 py-2"><PromotionStrip /></div>
        {/* ROW 5+6+7 */}
        <div className="pos-card flex-shrink-0 flex gap-0 divide-x divide-[var(--bg-border)]">
            <div className="flex-[3]"><NoteArea /></div>
            <div className="flex-[2]"><ShippingSection /></div>
            <div className="w-64"><OrderSummary /></div>
        </div>
    </div>

    {/* Right column: Activity Log */}
    <ActivityLog medusaId={...} metadata={...} createdAt={...} context="order" />
</div>
```

---

## G. Estructura de Archivos

```
ecopowertech-store-pos/
├── app/(pos)/orders/
│   ├── page.tsx                        ← Lista de órdenes (GET /admin/orders + MeiliSearch)
│   └── [id]/
│       ├── page.tsx                    ← Detalle de orden (7-row layout + toolbar completo)
│       ├── types.ts
│       ├── components/
│       │   ├── CustomerStrip.tsx       ← Row 1: Contact + Shipping + Billing (read-only display)
│       │   └── [otros componentes visuales del OrderCard]
│       └── hooks/
│           ├── useOrder.tsx            ← Orquestador: combina useOrderData + useOrderActions + useOrderNavigation
│           ├── useOrderData.ts         ← React Query + hydration (GET /admin/orders/{id})
│           ├── useOrderActions.ts      ← Email, WriteNote (resource_type='order'), handleSave (read-only)
│           └── useOrderNavigation.ts  ← Prev/Next entre órdenes (sessionStorage)
└── components/pos/
    ├── ActivityLog.tsx                 ← Compartido con Estimates; context='order' cambia el label ancla
    ├── BulkDiscountModal.tsx           ← Compartido con Estimates; mismo wiring
    ├── CategoriesModal.tsx             ← Compartido con Estimates
    ├── ItemsExpandedModal.tsx          ← Compartido con Estimates
    ├── LineItemsTable.tsx              ← Compartido; headers: Img|SKU|Description|Qty|Stk|Price|Total|%Disc
    ├── OrderSummary.tsx                ← Compartido; usa computeTotals() del posStore
    ├── PromotionStrip.tsx              ← Compartido
    └── ShippingSection.tsx             ← Compartido; en Orders: permite cambiar método de envío
```

---

## H. Metadata completa de una Order POS

```json
{
  "estimate_status": "Created",
  "lead_time": "3-5 business days",
  "payment_terms": "Net 30",
  "order_type": "Standard",
  "project_name": "Office Renovation",
  "customer_po": "PO-2026-001",
  "sales_rep": "John Smith",
  "pos_notes": "Customer requested urgent delivery",
  "tax_mode": "auto",
  "discount_type": "percent",
  "discount_value": 10,
  "promotion_code": "CUSTOM-10%",
  "pos_comment_lines": "[{\"localId\":\"tmp_xxx\",\"text\":\"AREA 1\",\"sortOrder\":0}]",
  "confirmed_at": "2026-03-10T22:42:00.000Z",
  "confirmed_order_display_id": "1042",
  "estimate_sent_at": "2026-03-10T20:00:00Z",
  "estimate_sent_to": "customer@email.com",
  "estimate_sent_by": "admin_user_id",
  "qb_sales_receipt_txn_id": "...",
  "qb_sales_receipt_operation_id": "...",
  "qb_sales_order_ref_num": "6161",
  "qb_so_txn_id": "...",
  "qb_invoice_txn_ids": ["...", "..."],
  "qb_invoice_ref_num": "6136"
}
```

---

## 9. Capture Payment (Order-Level)

### 9.1 Button Location

A **Capture Payment** button (💳 `CreditCard` icon) sits in the `DocumentToolbar` to the right of the **Email** button, visible only when an order is loaded. Clicking it opens `CapturePaymentModal` inline — no navigation required.

### 9.2 CapturePaymentModal (`components/pos/CapturePaymentModal.tsx`)

Self-contained modal that covers the entire payment capture flow for an order.

**Props**

| Prop | Type | Description |
|---|---|---|
| `open` | `boolean` | Controls visibility |
| `onClose` | `() => void` | Called when user closes/cancels |
| `orderId` | `string` | Medusa order UUID |
| `customerId` | `string \| null` | Medusa customer UUID — enables credit section |
| `orderTotal` | `number` | Pre-computed total in dollars (from `computeTotals(doc)`) |
| `orderDisplayId` | `number \| null` | Human-readable order number (e.g. `#1092`) |
| `customerName` | `string \| undefined` | Shown in the order total card for context |
| `onSuccess` | `() => void \| undefined` | Called after successful capture (parent invalidates queries) |

**Features**

- **Order total card** — shows `$XXX.XX`, display ID and customer name.
- **Customer Credit section** (violet, collapsible) — fetches `GET /admin/customers/{id}/credits` when modal opens. Shows available balance, "Apply max" button, and a capped amount field. If credit fully covers the total the payment method section is hidden and a "Fully covered by credit" card is shown.
- **Amount presets** — 30% / 50% / 75% / Full (calculated against the remaining balance after credit).
- **Payment Methods** — Cash, Visa, Mastercard, Discover, Amex, Check, ACH / Wire, Zelle, Other. Reference field placeholder changes contextually (e.g., "Last 4 digits" for cards, "Check #" for check).
- **Mixed ledger** — when both credit and a card payment are combined, a summary card shows both lines and the total collected.
- **Success state** — inline ✅ confirmation (no navigation).

**Capture flow (in order)**

1. `POST /admin/customers/{customerId}/credits/apply` — `{ order_id, amount }` (only if `creditApplied > 0`)
2. `POST /admin/orders/{orderId}` — writes `metadata`: `pos_payment_method`, `pos_payment_reference`, `pos_payment_amount`, `pos_payment_pct`, `pos_credit_applied`, `pos_payment_date`
3. `POST /api/pos/notes` — writes activity log note with event `payment_captured` and detail string

**State wiring (in `orders/[id]/page.tsx`)**

```tsx
const [paymentModalOpen, setPaymentModalOpen] = useState(false)

<DocumentToolbar onPayment={() => setPaymentModalOpen(true)} ... />

<CapturePaymentModal
    open={paymentModalOpen}
    onClose={() => setPaymentModalOpen(false)}
    orderId={order.doc.medusaId ?? ''}
    customerId={order.doc.customerId}
    orderTotal={computeTotals(order.doc).total}
    orderDisplayId={order.order?.display_id ?? null}
    customerName={order.doc.customerName || undefined}
    onSuccess={() => queryClient.invalidateQueries({ queryKey: ['order-changes', order.doc.medusaId] })}
/>
```

---

## 10. Customer History Modal

The **History** toolbar button now opens `CustomerHistoryModal` inline — no navigation to the customer page. Available only when a customer is attached to the order.

### 10.1 Component (`components/pos/CustomerHistoryModal.tsx`)

**Props**

| Prop | Type | Description |
|---|---|---|
| `open` | `boolean` | Controls visibility |
| `onClose` | `() => void` | Close handler |
| `customerId` | `string` | Medusa customer UUID |
| `customerName` | `string \| undefined` | Shown in the modal header |

**Data fetching (lazy — only when `open === true`)**

```
GET /admin/orders?customer_id={id}&limit=50&fields=id,display_id,status,payment_status,total,created_at
GET /admin/draft-orders?customer_id={id}&limit=50&fields=id,display_id,status,total,created_at,...
```

**UI Features** — identical to the Activity section on the Customer detail page:

- Tabs: **All / Estimates / Orders / Open / Closed** (with live counts)
- **Show Cancelled** toggle with badge count
- **Date filter** dropdown: All time / This week / This month / This year / Last year / Specific date range
- Column layout: `Type | # | Date | Items | Total | Status` with colored `StatusBadge`
- Row click: closes modal, then `router.push(/estimates/{id})` or `router.push(/orders/{id})`
- Modal width: `max-w-7xl` (~1280px) — wide enough to show all tabs without truncation

**State wiring (in `orders/[id]/page.tsx`)**

```tsx
const [historyModalOpen, setHistoryModalOpen] = useState(false)

<DocumentToolbar
    onHistory={order.doc.customerId ? () => setHistoryModalOpen(true) : undefined}
    ...
/>

{order.doc.customerId && (
    <CustomerHistoryModal
        open={historyModalOpen}
        onClose={() => setHistoryModalOpen(false)}
        customerId={order.doc.customerId}
        customerName={order.doc.customerName || undefined}
    />
)}
```

---

## 11. Standalone Capture Payment Page (`app/(pos)/capture-payment/page.tsx`)

Accessible from the sidebar under **Capture Payment**. Used when a customer walks in to pay, independent of the order flow.

### Page Layout (3 columns, after customer is selected)

```
┌───────────────────┬──────────────────────────┬──────────────┐
│  LEFT  (~320px)   │  MIDDLE  (flex-1)         │  RIGHT(260px)│
│  Customer card    │  Open orders list         │  Balance     │
│  Order total      │  (scrollable — never      │  Credit      │
│  Amount presets   │  pushes capture btn down) │              │
│  Payment method   │                           │              │
│  Credit summary   │                           │              │
│  [Capture button] │                           │              │
└───────────────────┴──────────────────────────┴──────────────┘
```

The 3-column structure ensures the **Capture button is always visible** regardless of how many open orders the customer has.

---

### Step 1 — Customer Search (full-width, before customer is selected)

- MeiliSearch-backed debounced input (300ms), triggers at ≥ 2 characters.
- Dropdown shows: company, full name, email.
- Once a customer is selected → layout expands to 3 columns.

---

### MIDDLE Column — Open Orders Picker

```
GET /admin/orders?customer_id={id}&limit=20&fields=id,display_id,status,payment_status,total,created_at
```

- Filters to active/unpaid orders only (excludes canceled, completed, captured, fulfilled).
- **Click row** → selects order, auto-fills amount to 100%, pre-shows total in LEFT column.
- **Click selected row again** → deselects the order, clears amount back to manual entry.
- If customer has no open orders → an empty-state card preserves the column width.

---

### LEFT Column — Payment Form

**Order total card** — Shown when an order is selected (or URL-loaded). Displays `$XXX.XX` + order `#display_id`.

**Amount presets** — 30% / 50% / 75% / Full — calculated against remaining balance after credit. Shown only when `orderTotal > 0`. Custom input always available.

**Payment method grid** — 9 options: Cash, Visa, Mastercard, Discover, Amex, Check, ACH / Wire, Zelle, Other.
- Reference field placeholder adapts contextually ("Last 4 digits" for cards, "Check #", etc.)

**Mixed ledger summary** — Shown only when both credit AND additional payment are being collected:
```
Credit applied   −$50.00
visa              $96.45
──────────────────────────
Total           $146.45
```

**Capture button** — `Capture $XX.XX` — always visible at the bottom of the LEFT column regardless of orders displayed in MIDDLE.

---

### RIGHT Column

| Card | Status | Description |
|---|---|---|
| **Customer Balance** | Placeholder | Future AR balance integration |
| **Customer Credit** | Live | Fetches `GET /admin/customers/{id}/credits`, shows available balance, apply max / custom amount. Credit applied is reflected in LEFT column presets and ledger. |

---

### State Persistence (F5-safe)

Three values are saved to `sessionStorage` so a hard refresh does **not** lose in-progress work:

| Key | Value saved |
|---|---|
| `cp_customer` | Full `SelectedCustomer` object (JSON) |
| `cp_order_id` | Selected order UUID string |
| `cp_credit` | Credit amount string (`"50.00"`) |

Cleared automatically on successful capture.

---

### URL Parameter Fallback

| Param | Effect |
|---|---|
| `?orderId=...` | Skips customer search; auto-fills customer + total from Medusa order |
| `?estimateId=...` | Same, but loads from a draft order |

In both cases the MIDDLE column is hidden (no manual order selection needed).

---

### Metadata Written on Capture

```json
{
  "pos_payment_method": "visa",
  "pos_payment_reference": "4242",
  "pos_payment_amount": 96.45,
  "pos_payment_pct": 75,
  "pos_credit_applied": 50.00,
  "pos_payment_date": "2026-03-10T23:15:00.000Z"
}
```

Written to `metadata` on the Medusa order or draft order. If credit was applied, `POST /admin/customers/{id}/credits/apply` is called first.

---

## 12. Changelog — 2026-03-10 (isDirty + Discard)

### 12.1 isDirty / isSaving ahora correctamente wired

**Problema:** `DocumentToolbar` recibía `isDirty={false}` e `isSaving={false}` hardcodeados — el botón Save nunca se iluminaba aunque hubiera cambios.

**Fix:** Ahora se leen del hook `useOrder`:

```tsx
<DocumentToolbar
    onSave={order.handleSave}
    isDirty={order.isDirty}       // ← antes: false hardcodeado
    isSaving={order.isSaving}     // ← antes: false hardcodeado
    ...
/>
```

### 12.2 False-Positive de isDirty al cargar — Fix

**Causa raíz:** El `draftCache` persistido en localStorage podía contener slots de órdenes con `isDirty: true` de sesiones anteriores. El guard `hasLocalWork` en `useOrderData` **saltaba** `hydrateDocument` (que resetea `isDirty=false`) si ese slot existía con datos.

**Fix:** Eliminado el guard `hasLocalWork` en `useOrderData`. Las Orders siempre re-hidratan desde el servidor. Ver sección A.3.

### 12.3 Botón Discard Changes

Agregado al `DocumentToolbar` de Orders con el mismo patrón que Estimates:

```tsx
// orders/[id]/page.tsx
const [discardModalOpen, setDiscardModalOpen] = useState(false)

const handleDiscardClick = () => {
    const hasData = !!order.doc.customerId || order.doc.items.length > 0
    if (hasData) {
        setDiscardModalOpen(true)   // → ConfirmModal
    } else {
        order.handleDiscard()       // → resetDocument() + router.push('/orders')
    }
}

<DocumentToolbar onDiscard={handleDiscardClick} ... />

<ConfirmModal
    isOpen={discardModalOpen}
    type="danger"
    title="Leave Order?"
    message="Go back to the Orders list? Any local changes will be cleared."
    confirmLabel="Leave"
    onConfirm={() => { setDiscardModalOpen(false); order.handleDiscard() }}
    onClose={() => setDiscardModalOpen(false)}
/>
```

**`handleDiscard` (en `useOrderActions.ts`):**

```ts
const handleDiscard = useCallback(() => {
    usePOSStore.getState().resetDocument()
    router.push('/orders')
}, [router])

---

## Changelog — Marzo 11, 2026

### 13. Orders Layout Migration — Parity con Estimates

La página `/orders/[id]` fue migrada para replicar el layout premium **7-row no-scroll** de `/estimates/[id]`. La goal: paridad estética y funcional entre ambas páginas.

**Cambios implementados:**

1. **Layout 7-row idéntico:** Mismo `flex flex-col flex-1 min-h-0 gap-2 overflow-hidden` con todas las rows en el orden correcto:
   - Row 1: `CustomerStrip`
   - Row 2: `OrderMetaFields`
   - Row 3: Items (flex-1, única zona con scroll interno)
   - Row 4: `PromotionStrip`
   - Row 5-7 (grid 4 cols): `NoteArea` (2 cols) | `ShippingSection` (1 col) | `OrderSummary` (1 col)

2. **Activity Log como columna derecha estrecha:** `w-52 flex-shrink-0` — mismo ancho que en Estimates, sin ocupar toda la pantalla

3. **Toolbar de items completo:**
   - Agregado botón **Comment** (`MessageSquare`) para orders — igual que Estimates
   - Nota: Comment en Orders crea headers visuales pero no se sincroniza con QB (Orders son read-only)

4. **`isDirty` y `isSaving` ahora correctamente wired** — antes estaban hardcodeados como `false`

5. **Colores del toolbar (light mode):** Mismos estilos que Estimates para consistencia visual

6. **CustomerStrip en Orders:** Mismos 3 paneles (Contact | Shipping | Billing) en display read-only

**Tabla de comparación final:**

| Feature | Estimates | Orders |
|---------|-----------|--------|
| Layout | 7-row no-scroll | 7-row no-scroll ✅ |
| Activity Log | `w-52` right col | `w-52` right col ✅ |
| Comment button | ✅ | ✅ (visual only) |
| isDirty wired | ✅ | ✅ ✅ |
| Save | Funcional | Toast read-only |
| Confirm Order | Draft → Order | Toast (ya confirmado) |

---

## Changelog — Marzo 13, 2026

### 14. Order Summary — Separación de Descuentos Inline vs. Global

Ver documentación completa en `POS_ESTIMATES.md § 29`.

**Resumen:** El componente compartido `components/pos/OrderSummary.tsx` (usado en Estimates, Orders e Invoices POS) fue actualizado:

- **Item Subtotal** ahora muestra `subtotal - lineDiscountsTotal` — ya absorbe los descuentos inline por ítem
- **Discount** ahora muestra solo `orderDiscount` — el descuento global de la orden

`Order Subtotal`, `Tax` y `Total` no cambian.
