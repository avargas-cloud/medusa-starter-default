# POS_ORDERS — Órdenes de Venta (POS App)

| Campo | Detalle |
|-------|---------|
| **Módulo** | Orders |
| **Rutas POS** | `/orders`, `/orders/[id]` |
| **Medusa** | Orders (`GET /admin/orders`) |
| **QB Docs** | Sales Receipt · Sales Order + Invoice |
| **Última revisión** | 2026-03-18 |

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
| QB Ref # | `metadata.qb_sales_order` → `ref_number` (objeto anidado). Fallback a `metadata.qb_invoice.ref_number` y luego a legacy `metadata.qb_sales_order_ref_num`. |
| Customer | `customer.first_name + last_name` |
| Company | `customer.company_name` o `billing_address.company` |
| Email | `customer.email` |
| Payment | `payment_status` (badge coloreado) |
| Fulfillment | `fulfillment_status` (badge coloreado) |
| Total | `total` en dólares |
| Date | `created_at` (format: MMM d, yyyy) |
| Deposit | `metadata.deposit_amount` |
| Paid Amt | `metadata.payment_received` |
| Delivery | `metadata.delivery_method` |
| Channel | `sales_channel.name` |
| QB Synced | Ícono Lucide: ✅ `Check` verde (tiene txn_id en metadata), 🕐 `Clock` ámbar (operación QB pendiente en metadata), ❌ `X` rojo (sin QB sync). Columna centrada. |

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

### Metadata y Backward Compatibility (Herencia de Estimates)
Al convertir un Estimate en Order, la versión anterior de la aplicación guardaba los campos bajo el prefijo `estimate_` (ej. `estimate_lead_time`). El diseño actual utiliza claves agnósticas (ej. `lead_time`, `sales_rep`). Para asegurar la visibilidad de documentos antiguos sin necesidad de scripts de migración, la capa de inicialización (`useOrderData.ts`) incluye un fallback automático:

```ts
leadTime: o.metadata?.lead_time ?? o.metadata?.estimate_lead_time ?? '',
paymentTerms: o.metadata?.payment_terms ?? o.metadata?.estimate_payment_terms ?? '',
orderType: o.metadata?.order_type ?? o.metadata?.estimate_order_type ?? '',
salesRep: o.metadata?.sales_rep ?? o.metadata?.estimate_rep ?? '',
```

### Acciones disponibles

| Acción | Descripción |
|--------|-------------|
| **Create Sales Receipt** | Pago inmediato → QB Sales Receipt |
| **Create QB Sales Order** | On account → QB Sales Order |
| **Fulfill Items** | Crear shipment parcial o total |
| **Receive Payment** | Abrir módulo Capture Payment (ver POS_CAPTURE_PAYMENT.md) |
| **Duplicate** | Clona la orden como nuevo Estimate via `posStore.startDuplicate()`. Navega a `/estimates/new`. Solo disponible cuando la orden tiene al menos 1 ítem. El representante guarda cuando esté listo. |
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
| QB sync corre para órdenes POS | ✅ RESUELTO (2026-03-16): `isPosOrder()` ahora detecta órdenes POS via `metadata.pos_created=true` incluso sin `POS_SALES_CHANNEL_ID` |
| Invoice no creada al fulfillment | POS debe llamar `POST /admin/quickbooks/invoice` manualmente |
| Company no aparece en la tabla | Verificar `customer.company_name` o `billing_address.company` en la orden |
| QB Ref # muestra `—` | La orden no fue sincronizada con QB aún — usar los botones de sync en el detalle |
| Tax incorrecto al confirmar estimate | ✅ RESUELTO (2026-03-16): `convert-force` ahora lee `metadata.tax_mode` para aplicar FL 7% o EXEMPT 0% |
| Tax no se actualiza al editar orden | ✅ RESUELTO (2026-03-16): `post-edit-sync` y `apply-discount-force` ahora respetan `pos_tax_rate=0` para EXEMPT |
| Payment Pending vs Order Total Mismatch | ✅ RESUELTO (2026-03-17): `convert-force` recalcula explícitamente el `payment_collection.amount` basándose en la matemática del POS `(Subtotal - Discount) + Tax`. |

---

## Changelog — Marzo 19, 2026

### Patch de Asignación de Inventario (Allocation / Backorders)

**Problema:**
Al intentar asignar (allocate) inventario a ítems de una orden desde el POS, o al agregar un ítem nuevo (`add-item-force`), los productos sin inventario (0 stock) no se reservaban (quedaban como "Not allocated"), incluso si tenían habilitada la opción de "Continue selling when out of stock" (`allow_backorder = true`).

**Origen 1 (El error silencioso de consulta):**
El backend usaba `remoteQuery` o la REST API `/admin/inventory-items?variant_id[]=` con parámetros y operadores estructuralmente inválidos para Medusa v2 (`$where` en remoteQuery o filtros no soportados en REST). Al atrapar (`catch`) este fallo silenciosamente, el backend reportaba que el ítem era un *unmanaged product* y lo saltaba.

**Solución 1:**
Se refactorizó la consulta de `inventory_item_id` en las tres rutas clave (`allocate-items`, `add-item-force`, y `convert-force`) para utilizar el motor nativo de Medusa v2 de manera correcta:
```typescript
const variantData = await query.graph({
    entity: "variant",
    fields: ["id", "inventory_items.inventory_item_id"],
    filters: { id: variant_id }
})
```

**Origen 2 (Validación estricta de stock en 0):**
Una vez resuelto el identificador del inventario, la función nativa `createReservationsWorkflow` arrojaba un "Not enough stock available" para ítems en 0, **ignorando el switch `allow_backorder` de la base de datos**; y asimismo las rutas como `convert-force` estaban utilizando *loops HTTP `fetch` a sí mismas* muy frágiles.

**Solución 2:**
En Medusa v2, el workflow de reservas exige que la excepción de stock se pase de forma explícita en el *volante de vuelo* de la propia reserva. Se inyectó contundentemente el booleano `allow_backorder: true` de la siguiente manera, reemplazando cualquier `fetch` rústico por el llamado a los core-flows universales:
```typescript
const { createReservationsWorkflow } = require("@medusajs/core-flows")

await createReservationsWorkflow(req.scope).run({
    input: {
        reservations: [{
            line_item_id, inventory_item_id, location_id, quantity,
            allow_backorder: true // 👈 Evita validación 0 stock en POS durante Confirm Order y Save
        }],
    },
})
```

---

## Changelog — Marzo 17, 2026

### Patch Matemático de Payment Collections (Order Total Mismatch)

**Problema:**
Al convertir un "Estimate" a "Order", el monto pendiente ("Payment Pending") registrado automáticamente por Medusa v2 difería del gran total mostrado en pantalla. Ejemplo: Un subtotal de $89 con un descuento de 5% ($4.45) y un impuesto de 7% (calculado posterior al descuento = $5.92) suma el total de `$90.47`. Sin embargo, Medusa creaba la recolección de pago (`payment_collection`) por `$84.55`.

**Origen:**
La arquitectura _Core_ de Medusa aplica el impuesto sobre el subtotal bruto (`Gross Subtotal * Tax`), y de ahí resta los descuentos. Por ende, generaba una colección de pago olvidando rastrear la forma en que los componentes del POS (vía _metadata.computed_total_) computan el impuesto sobre el subtotal neteado (`(Subtotal - Discount) + Tax`).

**Solución Implementada:**
1. **Ruta `convert-force.ts`**: Se integró una función auxiliar (`fixPaymentCollection`) que intercepta la base de datos subyacente de la orden durante la conversión final (`order_payment_collection` `->` `payment_collection`).
2. Calcula la matemática verdadera vía `subtotal - discount_total + tax_total`.
3. Ejecuta una actualización SQL directa `UPDATE payment_collection SET amount = $1 WHERE id = $2` ignorando el valor que haya inyectado temporalmente el Workflow nativo de Medusa.
4. Con esto, tanto `metadata.computed_total`, la interfaz del POS y la tabla subyacente de pagos cuadran siempre en `$90.47`, sin editar o fracturar la librería `@medusajs/core-flows`.

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

### Transferencia de Propiedad en Orders ("Transfer Ownership")

**Problema:** Al igual que en los Estimates, el POS mostraba el campo de cliente como modificable en las Órdenes, pero al intentar Guardar los metadatos y direcciones asociadas a un nuevo cliente, Medusa rechazaba silenciosamente el cambio de `customer_id` original de la Orden. Adicionalmente, la API nativa `orders/:id/transfer` de Medusa requiere aceptación asincrónica del cliente mediante Tokens via Email.

**Solución Implementada (Marzo 14, 2026):**
- **Unified Transfer API:** Se inyectó el endpoint custom `POST /admin/pos-transfer` que resuelve el modulo de Orders directamente, permitiendo reescribir `customer_id` y `email` en la base de datos sin requerimientos asíncronos.
- **Hook de Intercepción (`useOrderActions.ts`):** En el proceso de edición transparente (`handleSave`), el UI detecta si `doc.customerId !== order.customer_id`. Si difieren, ejecuta este forced endpoint cambiando el dueño instantáneamente *antes* de proseguir con la volcada masiva de direcciones física (Shipping/Billing Address) y metadata de la orden. Todo en un solo click.

### Notas de Ordenes Dinámicas ("Virtual Row Notes") y Guardias de Seguridad

**Regla de Guardado Habilitado (Save Button):**
El botón de "Save" en `DocumentToolbar` **siempre está habilitado** permitiendo forzar un guardado en cualquier instante. La propiedad `isDirty` originada por Zustand/Zod se reserva **únicamente como un indicador visual** (naranja/ámbar) para alertar al usuario que los cambios de la pantalla actual en sus renglones difieren de los de la base de datos de Medusa. 

- **Print/Email Guards:** La vista de Orders cuenta con la misma protección estricta sobre el `DocumentToolbar.tsx`. Si se edita la orden de alguna forma (encendiendo la luz naranja `isDirty = true`), los botones de "Print" y "Email" fallarán con un `toast.error` forzando de todas maneras al operador al dar click en el botón Save antes de poder compartir información no grabada.
- **Paginación Vertical del Documento:** Para evitar derrames (overflows), el *Notes* global de la orden tampoco se diagrama en un bloque cerrado y fijo. El renderizador (`BlockRenderer`) lo empuja como la **última línea mágica de tipo ítem de factura** (`**_NOTE_**`). De esa manera el motor de impresión del navegador expande la celda del 100% hasta la siguiente página en caso de exceder su largo predeterminado. (Se describe más en `POS_ESTIMATES.md`).

---

### Columna Dinámica de "Invoiced Qty" y "Backordered Qty" (Marzo 17, 2026)
- Se inyectó el sub-campo `+items.fulfilled_quantity` en el hook local (`useOrderData.ts`) leyéndolo de la BD nativa de Medusa donde se guardan los fulfillments.
- En el UI local `LineItemsTable`, sí `fulfilled_quantity` es recibido u operado, altera "Invoiced Qty" y deduce el "Backordered Qty" a partir de `quantity` menos `fulfilled_quantity`.

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
    taxMode: (o.metadata?.tax_mode === 'florida' || o.metadata?.tax_mode === 'exempt') ? o.metadata.tax_mode : 'florida',
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

### B.1 handleSave — Order Edit Flow (via post-edit-sync)

Las órdenes confirmadas SÍ se pueden editar a través del POS. El flujo completo:

1. Actualiza items (add/remove/update) via `add-item-force`, `update-item-force`, `delete-item-force`
2. Actualiza shipping via `add-shipping-force` (SQL directo — bypass del workflow con null tax provider)
3. Aplica promociones via `apply-discount-force` (recibe `pos_tax_rate` para insertar tax lines correctas)
4. Llama a `post-edit-sync` con `pos_tax_amount`, `pos_tax_rate` para corregir tax lines y `order_summary`

```ts
// post-edit-sync body:
{
    discount_type, discount_value,
    pos_discount_amount,
    pos_total,           // incluye tax + shipping
    pos_tax_amount,      // 0 para EXEMPT, >0 para FL
    pos_tax_rate,        // 0 para EXEMPT, 7 para FL — siempre enviar
}
// ⚠️ pos_tax_amount=0 es válido (EXEMPT) — SIEMPRE enviarlo aunque sea 0
// Antes de este fix (2026-03-16), pos_tax_amount: tax > 0 ? tax : undefined
// enviaba undefined para EXEMPT → la actualización de tax lines se saltaba
```

### B.1.1 Anti-Patrón React Query (Marzo 2026 Fix)
Anteriormente, la acción local de `handleSave` intentaba parchear la caché local en memoria usando `queryClient.setQueryData(['order', id], ...)`. Si bien esto protegía contra ciertos parpadeos de React, generaba un **bug de re-hidratación** donde metadata (como el `tax_mode` modificado a 0%) se revertía temporalmente en la UI porque no había sido cubierto por el parcheo estático.

**Flujo actual y correcto:**
Al finalizar el árbol de guardado, siempre se fuerza una **descarga autoritativa** vaciando el query key directo con la red:
```ts
// Se prohíbe el uso de setQueryData. En su lugar forzamos el request original:
queryClient.invalidateQueries({ queryKey: ['order', resolvedId] })
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
  "tax_mode": "florida",         // 'florida' | 'exempt' — 'auto' ELIMINADO (2026-03-16)
  "pos_created": true,            // Flag para QB subscriber: skip sync para órdenes POS
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

## I. Exact Medusa v2 Math & Rounding Rules (Parity fix)

The Medusa v2 calculation engine does NOT apply discounts and taxes globally to the summed cart total. It accumulates them strictly **line-by-line using integer cents**.

To achieve 100% parity between the POS frontend and the Medusa backend, the following algorithm **must** be used inside the POS state (`posStore.ts` and `computeEffectivePrice` payload builders):

1. **Calculate Cents:** All calculations must convert the base unit price to cents first (`Math.round(price * 100)`).
2. **Line Discounts (Unit-Level Rounding):** Line discounts apply directly to the unit price in cents. Round the result of `(unitPriceCents * discountRate)`, then multiply by `quantity`. Calculate `lineAfterLineDiscountCents`.
3. **Order Discounts (Line-Level Rounding):** The total global order discount (e.g. 5%) is applied proportionally to each item's `lineAfterLineDiscountCents` total. Calculate `Math.round(lineAfterLineDiscountCents * orderDiscountRate)`. Accumulate all these rounded values to get the global `orderDiscountTotalCents`.
4. **Tax Calculation (Aggregate Level):** Tax is applied implicitly on the aggregate taxable total after all discounts are deducted. `taxableAmountCents = afterLineDiscountsSubtotalCents - orderDiscountTotalCents`. Then `Math.round(taxableAmountCents * taxRate)`.
5. **Database Injection (Override Level):** When saving POS global discounts to the Medusa database (e.g., via `posOverrideAdjustmentsWorkflow`), the `amount` passed to Medusa must be strictly truncated to cents (`Math.round(val * 100) / 100`). Preventing Medusa from storing purely floating-point fractions (like `$1.485`) guarantees that Medusa's native `/admin/orders/[id]` Subtotal math yields the exact same 2-decimal precision required by QuickBooks.
6. **Divisor:** Sum the final cents and divide by `100` at the very end to yield the exact POS display values and payload targets.

Failure to follow this exact order of rounding (or using floating-point `toFixed()` mid-calculation) will lead to 1-2 cent discrepancies against the Medusa backend.

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

### 15. Exact Medusa v2 Math & Rounding Rules (Parity fix)

Ver documentación completa en `POS_ESTIMATES.md § F` para las reglas de redondeo.

**Órdenes vs Estimados (Hard Deletion):**
A diferencia de los Estimados, Medusa no siempre limpia las tablas de historial y los ajustes (`adjustments` y `tax_lines`) cuando se ejecutan ediciones en órdenes confirmadas (`post-edit-sync.ts` y `apply-discount-force.ts`).
Como el POS ahora es la única fuente de la verdad para una Orden:
* **The DB Wipe**: El backend ejecuta secuencias `DELETE` en SQL puro (PostgreSQL) cada vez que el POS sobreescribe una orden, eliminando registros obsoletos de `order_change`, `order_change_action`, versiones antiguas de `order_item` / `order_summary`, e inyecciones "soft-deleted" de impuestos.
* **No "Soft Deletes"**: Ya que las Órdenes en POS nunca usan el historial y no son reversibles, este borrado "Hard Delete" previene que los Descuentos se auto-sumen y corrompan los totales de Impuestos en Medusa Admin.

---

## Changelog — Marzo 16, 2026

### 16. Sistema de Tax Completamente Reescrito — 3 Escenas

El sistema de tax para órdenes fue completamente corregido para contemplar las 3 escenas del flujo de ventas POS:

#### Escena 1 — Estimate → Confirmed Order (`convert-force`)

**Problema:** Al confirmar un estimate, `convert-force` siempre aplicaba FL 7% ignorando el `taxMode` seleccionado en el POS.

**Fix en `backend/src/api/admin/draft-orders/[id]/convert-force/route.ts`:**
- Step 7a ahora lee `order.metadata.tax_mode`
- `'exempt'` → inserta tax lines con `code='EXEMPT'`, `rate=0`
- Cualquier otro valor (o `null`) → inserta tax lines con `code='FL'`, `rate=7`
- Elimina duplicados antes de insertar (DELETE + INSERT)

#### Escena 2 — Nueva Orden Directamente desde POS (`add-shipping-force`)

**Problema:** `addDraftOrderShippingMethodsWorkflow` fallaba con `AwilixResolutionError: Could not resolve 'null'` porque `tax_region.provider_id` es null en la DB y Medusa no puede resolver el tax provider.

**Fix en `backend/src/api/admin/draft-orders/[id]/add-shipping-force/route.ts`:**
- Reescrita completamente — reemplaza el workflow roto con SQL directo
- Hace `UPDATE order_shipping_method SET deleted_at = NOW()` para eliminar método anterior
- Hace `INSERT INTO order_shipping_method` con los datos correctos (fetching nombre de la opción via API)
- Elimina todos los imports de Medusa workflows que causaban el error

#### Escena 3 — Editar Tax de una Orden Existente (`post-edit-sync` + `apply-discount-force`)

**Problema 1:** `post-edit-sync` tenía condición `pos_tax_amount > 0` que salteaba el bloque de tax cuando el valor era `0` (EXEMPT). Las líneas FL no se eliminaban.

**Fix en `backend/src/api/admin/orders/[id]/post-edit-sync/route.ts`:**
- Condición cambiada a `pos_tax_amount != null` — captura `0` explícito
- Tax code dinámico: `effectiveRate === 0 ? 'EXEMPT' : 'FL'`
- Tax description dinámico: `'Tax Exempt'` o `'Florida Sales Tax'`

**Problema 2:** `apply-discount-force` siempre insertaba FL 7% hardcodeado, causando un "doble write" innecesario (FL → luego sobreescrito por EXEMPT).

**Fix en `backend/src/api/admin/orders/[id]/apply-discount-force/route.ts`:**
- Acepta nuevo parámetro `pos_tax_rate` en el body
- Hace DELETE de tax lines existentes antes de insertar (clean state)
- Usa `pos_tax_rate` para determinar `code` y `description` correctos
- `post-edit-sync` ahora pasa `pos_tax_rate` a `apply-discount-force` en la llamada interna

**Problema 3 (POS):** `useOrderActions.ts` enviaba `pos_tax_amount: tax > 0 ? tax : undefined` — para EXEMPT, enviaba `undefined`, no triggereaba la actualización de tax lines.

**Fix en `ecopowertech-store-pos/app/(pos)/orders/[id]/hooks/useOrderActions.ts`:**
- `pos_tax_amount: doc.taxMode === 'exempt' ? 0 : (tax > 0 ? tax : undefined)`
- `0` explícito para EXEMPT es válido — el backend lo reconoce como señal de borrar FL lines
- Aplica tanto a `handleSave` como a `handleForceSave`

#### Cambios en posStore / POS State

**`store/posStore.ts`:**
- `taxMode` type: `'auto' | 'florida' | 'exempt'` → `'florida' | 'exempt'` (removido 'auto')
- Default `taxMode`: `'auto'` → `'florida'`

**`app/(pos)/estimates/[id]/hooks/useEstimateData.ts`:**
- Fallback de `taxMode`: `'auto'` → `'florida'`

**`app/(pos)/estimates/[id]/components/CustomerStrip.tsx`:**
- Ahora detecta `is_tax_exempt` en múltiples formatos: `true`, `'true'`, `'True'`, `'yes'`, `'Yes'` → `taxMode = 'exempt'`
- Null o false → `taxMode = 'florida'`

#### QB Sync Guard — `pos_created` Metadata

**Problema:** `isPosOrder()` en `qb-order-subscriber.ts` solo chequeaba `sales_channel_id` via `POS_SALES_CHANNEL_ID` env var. Si no estaba seteada, todas las órdenes POS corrían QB sync.

**Fix en `backend/src/subscribers/qb-order-subscriber.ts`:**
- `isPosOrder()` ahora usa fallback dual:
  1. `POS_SALES_CHANNEL_ID` env var (existente)
  2. `order.metadata.pos_created === true` (nuevo fallback)

**Fix en `ecopowertech-store-pos/app/(pos)/estimates/[id]/lib/estimatePayload.ts`:**
- `buildCreatePayload()` y `buildUpdatePayload()` ahora incluyen `pos_created: true` en el metadata
- Este flag se propaga a las órdenes confirmadas cuando `convert-force` copia el metadata del draft

#### Archivos Modificados (Marzo 16, 2026)

| Archivo | Tipo de Cambio |
|---------|---------------|
| `backend/src/api/admin/draft-orders/[id]/convert-force/route.ts` | Tax mode-aware EXEMPT/FL injection |
| `backend/src/api/admin/draft-orders/[id]/add-shipping-force/route.ts` | Rewrite completo: workflow → SQL directo |
| `backend/src/api/admin/orders/[id]/post-edit-sync/route.ts` | Condición `!= null`, dynamic EXEMPT/FL code |
| `backend/src/api/admin/orders/[id]/apply-discount-force/route.ts` | Acepta `pos_tax_rate`, dynamic code, DELETE antes de INSERT |
| `backend/src/subscribers/qb-order-subscriber.ts` | `isPosOrder()` con fallback `metadata.pos_created` |
| `ecopowertech-store-pos/.../useOrderActions.ts` | EXEMPT sends `pos_tax_amount: 0` explícito |
| `ecopowertech-store-pos/.../posStore.ts` | Removido 'auto' taxMode, default → 'florida' |
| `ecopowertech-store-pos/.../useEstimateData.ts` | Fallback taxMode → 'florida' |
| `ecopowertech-store-pos/.../CustomerStrip.tsx` | is_tax_exempt check multi-format |
| `ecopowertech-store-pos/.../estimatePayload.ts` | `pos_created: true` en metadata |
