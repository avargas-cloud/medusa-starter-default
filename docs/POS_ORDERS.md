# POS_ORDERS — Órdenes de Venta (POS App)

| Campo | Detalle |
|-------|---------|
| **Módulo** | Orders |
| **Rutas POS** | `/orders`, `/orders/[id]` |
| **Medusa** | Orders (`GET /admin/orders`) |
| **QB Docs** | Sales Receipt · Sales Order + Invoice |
| **Última revisión** | 2026-03-07 |

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
