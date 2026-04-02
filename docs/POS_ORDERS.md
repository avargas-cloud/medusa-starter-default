# POS Orders — Órdenes de Venta
> **Tipo**: Technical Reference
> **Repo**: backend
> **Última verificación**: 2026-04-02
> **Estado**: ✅ Current

---

## ¿Qué es y por qué existe?

El módulo Orders del POS maneja ventas confirmadas para clientes. Soporta dos flujos: Sales Receipt (pago inmediato en mostrador) y Sales Order (on account, pago posterior). Ambos se sincronizan con QuickBooks Desktop via el QB Bridge.

---

## Tipos de Venta POS

| Tipo | Cuándo usar | Documento QB | Flujo Medusa |
|------|------------|-------------|-------------|
| **Sales Receipt** | Cliente paga en el momento (mostrador) | Sales Receipt | Order capturada inmediatamente |
| **Sales Order** | Cliente paga después (B2B on account) | Sales Order → Invoice | Order → Fulfill → Capture |
| **Estimate → Order** | Cotización aprobada | Estimate → SO → Invoice | Draft → Convert → Fulfill |

---

## Arquitectura

### Flow A — Sales Receipt (Pago Inmediato)

```
POS Staff: selecciona productos, cliente paga
│
├── 1. POST /admin/orders
│        { customer_id, items, payment_status: 'captured',
│          sales_channel_id: POS_SALES_CHANNEL_ID,
│          metadata: { pos_created: true } }
│        → order.id
│
└── 2. POST /admin/quickbooks/sales-receipt
         { orderId: order.id, paymentMethod: 'Credit Card' | 'Cash' | 'Check' }
         → QB Sales Receipt creado (async)
         → Metadata: qb_sales_receipt_txn_id, qb_sales_receipt_operation_id
```

### Flow B — Sales Order (On Account)

```
POS Staff: venta a crédito
│
├── 1. [Opcional] Viene de Estimate convertido (POST /admin/draft-orders/:id/convert-force)
│    O bien: Order creada con payment_status: 'not_paid'
│
├── 2. POST /admin/quickbooks/order
│        { orderId }
│        → QB Sales Order creado
│
├── 3. [Al despachar] POST /admin/orders/:id/fulfillments
│        → POST /admin/quickbooks/invoice { orderId, fulfillmentId }
│        → QB Invoice creada por fulfillment
│
└── 4. [Al pagar] → ver POS_CAPTURE_PAYMENT.md
```

> El subscriber `qb-order-subscriber.ts` **skipea** automáticamente órdenes del canal POS — no se crea duplicado en QB.

---

## Modelo de Datos / Estructura

### Metadata QB en Órdenes

```json
{
  "pos_created": true,
  "qb_sales_receipt_txn_id": "...",
  "qb_sales_receipt_operation_id": "...",
  "qb_sales_order_ref_num": "6161",
  "qb_so_txn_id": "...",
  "qb_invoice_txn_ids": ["...", "..."],
  "qb_invoice_ref_num": "6136",
  "deposit_amount": 500,
  "payment_received": 1200,
  "delivery_method": "store_pickup | shipping",
  "tax_mode": "FL_7 | EXEMPT",
  "computed_total": 1350.00
}
```

### Fallback de metadata (órdenes convertidas de Estimate)

```typescript
leadTime: o.metadata?.lead_time ?? o.metadata?.estimate_lead_time ?? ''
paymentTerms: o.metadata?.payment_terms ?? o.metadata?.estimate_payment_terms ?? ''
salesRep: o.metadata?.sales_rep ?? o.metadata?.estimate_rep ?? ''
```

---

## API / Interfaces

### Endpoints Medusa nativos usados por POS

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/admin/orders?limit=500&fields=...` | Lista órdenes POS |
| `POST` | `/admin/orders` | Crear orden |
| `POST` | `/admin/orders/:id/fulfillments` | Crear fulfillment |
| `POST` | `/admin/orders/:id/cancel` | Cancelar orden |

### Endpoints custom

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/admin/quickbooks/sales-receipt` | Crear QB Sales Receipt |
| `DELETE` | `/admin/quickbooks/sales-receipt` | Void QB Sales Receipt |
| `POST` | `/admin/quickbooks/order` | Crear QB Sales Order |
| `POST` | `/admin/draft-orders/:id/convert-force` | Convert draft → order con backorder fallback |
| `POST` | `/admin/pos-discount` | Crear descuento custom (nueva promo) + aplicarlo |
| `DELETE` | `/admin/pos-discount` | Remover descuento custom de un draft/order |
| `POST` | `/admin/pos-discount/apply-existing` | Aplicar promo nombrada existente con corrección de qty |
| `GET` | `/admin/pos-promotions` | Listar promociones Medusa disponibles (excluye prefijo POS-DISC) |
| `POST` | `/admin/pos-transfer` | Transferir ownership del orden a otro customer |
| `POST` | `/admin/pos/sync` | Resinc manual QB (estimate, order, invoice, sales_receipt) |

### Campos expandidos en el fetch de lista

```
id, display_id, status, payment_status, fulfillment_status,
total, created_at, email, metadata,
+customer.first_name, +customer.last_name, +customer.email,
+customer.phone, +customer.company_name,
+billing_address.company,
+sales_channel.name
```

---

## Flujo de Implementación (UI)

### Columnas de la Tabla de Órdenes

| Columna | Fuente |
|---------|--------|
| # | `display_id` |
| QB Ref # | `metadata.qb_sales_order?.ref_number` → fallback `metadata.qb_invoice?.ref_number` → legacy `metadata.qb_sales_order_ref_num` |
| Customer | `customer.first_name + last_name` |
| Company | `customer.company_name` o `billing_address.company` |
| Payment | `payment_status` (badge coloreado) |
| Fulfillment | `fulfillment_status` (badge coloreado) |
| QB Synced | `Check` verde (tiene txn_id), `Clock` ámbar (pendiente), `X` rojo (sin sync) |

### Tabs

| Tab | Criterio |
|-----|---------|
| All | Todo (sin cancelled por default) |
| Open | `not_fulfilled` OR `partially_fulfilled` |
| Closed | `fulfilled` OR `shipped` OR `delivered` |

### Estado Read-Only para órdenes canceladas

Cuando `order.status === 'canceled'`:
- Badge rojo "VOIDED" en toolbar
- UI bloqueada: `pointer-events-none opacity-60 grayscale`
- `LineItemsTable` recibe prop `isReadOnly`
- Botones de escritura (Save, Fulfill, Payment) ocultos

---

## POS Discount — Descuentos en Draft Orders

El sistema de descuentos POS trabaja sobre draft orders usando el Medusa Order Edit workflow.

### Flujo: Descuento Nuevo

```
POST /admin/pos-discount
Body: { order_id, discount_type: 'percent'|'fixed', discount_value, existing_promo_code? }

1. Crea promo Medusa con código CUSTOM-DISC-{timestamp}
   - is_automatic: false, is_tax_inclusive: false
   - target_type: 'items' (NO 'order' — evita base incorrecta)
2. Cancela edit pendiente (si existe)
3. Begin draft order edit
4. Remueve promo anterior (si existing_promo_code)
5. Aplica nueva promo
6. Confirma edit
→ Retorna { promotion_code, promotion_id }
```

### Flujo: Aplicar Promo Existente

```
POST /admin/pos-discount/apply-existing
Body: { order_id, promotion_code, promotion_id? }

1. Normaliza promo: status=active, is_tax_inclusive=false, target_type=items
2. Cancela edit pendiente
3. Begin draft order edit
4. Aplica promo via addDraftOrderPromotionWorkflow
5. Ejecuta posOverrideAdjustmentsWorkflow (corrección de qty antes de confirm)
6. Confirma edit
```

**Por qué es necesario `posOverrideAdjustmentsWorkflow`:** El ORM de Medusa usa un snapshot de qty del momento del edit. Como `update-item-force` escribe directo a BD sin pasar por el workflow, el snapshot puede tener qty=1 cuando la cantidad real es qty=2. El workflow intercepta el JSON payload del edit y recalcula los amounts antes del confirm.

### GET Promotiones

```
GET /admin/pos-promotions
→ Lista todas las promos con is_automatic=false
→ Excluye códigos que empiecen con 'POS-DISC' (promos internas de una sola vez)
→ Incluye relation: application_method
```

---

## POS Transfer — Transferir Orden

```
POST /admin/pos-transfer
Body: { id: string, customer_id: string, email?: string }

Actualiza customer_id y email en el Order o Draft Order usando orderModule.updateOrders().
Bypasea el flujo nativo de transfer (que requiere token de aceptación del nuevo cliente).
```

---

## Multi-Fulfillment

```
Order #1089 (QB Sales Order)
│
├── Fulfillment 1: Items A, B   → QB Invoice #6180
├── Fulfillment 2: Item C       → QB Invoice #6195
└── Fulfillment 3: Item D       → QB Invoice #6210
```

Para órdenes POS: el subscriber está skipeado. El POS debe llamar `POST /admin/quickbooks/invoice` manualmente por cada fulfillment.

---

## Reglas Críticas

- El subscriber `qb-order-subscriber.ts` tiene guard `isPosOrder()` — verifica `sales_channel_id` === `POS_SALES_CHANNEL_ID` o `metadata.pos_created === true`
- Para cancelar un Sales Receipt: llamar `DELETE /admin/quickbooks/sales-receipt` ANTES de `POST /admin/orders/:id/cancel`
- `convert-force` lee `metadata.tax_mode` para aplicar FL 7% o EXEMPT 0%
- `payment_collection.amount` se recalcula en `convert-force` con la matemática del POS: `(Subtotal - Discount) + Tax`
- Los descuentos POS usan `target_type: 'items'` — NUNCA `'order'` porque 'order' usa subtotal+tax como base
- `is_tax_inclusive: false` en la promo es crítico para que el % se aplique solo al precio pre-tax

---

## Archivos Clave

| Tipo | Ruta Completa | Propósito |
|------|---------------|-----------|
| Subscriber | `backend/src/subscribers/qb-order-subscriber.ts` | Guard `isPosOrder()` |
| API | `backend/src/api/admin/quickbooks/sales-receipt/route.ts` | POST/DELETE QB Sales Receipt |
| API | `backend/src/api/admin/quickbooks/order/route.ts` | POST QB Sales Order |
| API | `backend/src/api/admin/draft-orders/[id]/convert-force/route.ts` | Convert draft → order con backorder fallback |
| API | `backend/src/api/admin/pos-discount/route.ts` | Crear/eliminar descuentos custom |
| API | `backend/src/api/admin/pos-discount/apply-existing/route.ts` | Aplicar promo existente con corrección |
| API | `backend/src/api/admin/pos-promotions/route.ts` | Listar promos disponibles |
| API | `backend/src/api/admin/pos-transfer/route.ts` | Transferir orden a otro cliente |
| API | `backend/src/api/admin/pos/sync/route.ts` | Manual QB sync |
| Workflow | `backend/src/workflows/pos-discount/workflows.ts` | `posOverrideAdjustmentsWorkflow` |

---

## Historial de Decisiones

- **`isPosOrder()` con doble check** (2026-03-16): Se agregó `metadata.pos_created=true` como fallback porque algunas órdenes antiguas no tenían el `sales_channel_id` correcto en la BD.
- **`convert-force` recalcula `payment_collection.amount`** (2026-03-17): Medusa calculaba el total incorrectamente en órdenes con descuentos + impuestos. El endpoint custom asegura la matemática correcta.
- **Order Edit workflow para discounts** (2026-03): El flujo con `beginDraftOrderEditWorkflow` + `confirmDraftOrderEditWorkflow` es el correcto en Medusa v2. Hay código SQL legacy comentado en `apply-existing` como fallback de referencia.
- **`posOverrideAdjustmentsWorkflow` para corrección de qty** (2026-03-30): Ver comentario en `apply-existing/route.ts`. El SQL force fue la solución inicial; el workflow nativo es la solución actual.
