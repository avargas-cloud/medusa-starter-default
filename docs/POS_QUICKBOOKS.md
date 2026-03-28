# POS_QUICKBOOKS — Integración QuickBooks

| Campo | Detalle |
|-------|---------|
| **Módulo** | QuickBooks Integration (backend) |
| **Bridge URL** | `https://qb.eptbridge.com` |
| **Protocolo** | QBXML via QB Desktop SDK |
| **Última revisión** | 2026-03-28 |

---

## Arquitectura

```
POS (Next.js)
│
└── Backend (Medusa v2)
      │
      ├── /admin/quickbooks/*  ← API endpoints POS llama
      │
      └── QB Bridge (qb.eptbridge.com)
            │
            └── QuickBooks Desktop (local, en la oficina)
                  └── QBXML → QB SDK → QB .QBW file
```

El **QB Bridge** es un servicio Node.js que corre localmente (en la red de la empresa) y usa el SDK de QuickBooks Desktop para transformar llamadas REST → QBXML → QB.

---

## Documentos QB por Flujo

| Situación | POS Doc | QB Doc | Notas |
|-----------|---------|---------|-------|
| Venta web con pago inmediato | Order | Sales Order → Invoice | Web order: SO creado inmediatamente |
| Venta POS con pago inmediato (< 1hr) | Order | Sales Receipt | Cron no crea SO (sentinel SKIPPED_SALES_RECEIPT) |
| Venta POS con pago inmediato (> 1hr) | Order | Sales Order + Invoice | Cron crea SO primero, luego handler crea Invoice |
| Venta POS SIN pago inmediato | Order | Sales Order | Cron crea SO después de 1+ horas |
| Venta on account (B2B) | Order | Sales Order → Invoice | Pago diferido |
| Cotización (< 1hr) | (no QB) | (nada) | Estimado reciente, no se synca a QB |
| Cotización (1-24hr) | (no QB) | Estimate | Cron crea Estimate después de 1+ hora |
| Cotización aprobada/convertida | Order | Estimate → Sales Order | El cron detecta `is_draft_order=false`, skippea Estimate |
| Pago recibido | Capture Payment | Receive Payment | Vinculado al customer, sin aplicar |
| Ajuste de crédito | Credit Ledger entry | (manual en QB) | Future feature |

---

## Endpoints Backend → QB Bridge

### Sales Receipt

```
POST   /admin/quickbooks/sales-receipt
Body:  { orderId, paymentMethod: 'Cash'|'Credit Card'|'Check' }
→ Crea QB Sales Receipt
→ Response: { operationId, success }

DELETE /admin/quickbooks/sales-receipt
Body:  { orderId }
→ Voidea QB Sales Receipt
```

### Sales Order

```
POST   /admin/quickbooks/order
Body:  { orderId }
→ Crea QB Sales Order (o re-sync si ya existe)

POST   /admin/quickbooks/invoice
Body:  { orderId, fulfillmentId }
→ Crea QB Invoice para un fulfillment específico
```

### Estimates

```
POST   /admin/quickbooks/draft-order
Body:  { orderId }
→ Crea/re-sync QB Estimate

DELETE /admin/quickbooks/draft-order
Body:  { txnId }
→ Desactiva QB Estimate (IsActive = false)
```

### Receive Payment

```
POST   /admin/quickbooks/receive-payment
Body:  { orderId, amount, paymentMethod }
→ Crea QB Receive Payment contra Invoice del orderId
```

---

## Cliente QB (`ensureCustomerInQb`)

Antes de crear cualquier documento QB, el backend verifica/crea el customer en QB:

```typescript
// lib/quickbooks/order-flow-core.ts
async function ensureCustomerInQb(customer, sql) {
    if (customer.metadata?.qb_customer_id) {
        return customer.metadata.qb_customer_id
    }
    // Crear customer en QB y guardar ListID en metadata
    const qbCustomerId = await createCustomerInQb(customer)
    await updateCustomerMetadata(customer.id, { qb_customer_id: qbCustomerId })
    return qbCustomerId
}
```

---

## Metadata QB en Órdenes

### Forma Antigua (Flat — Backward Compat, pre-2026)

```json
{
  "qb_list_id": "ABC123",
  "qb_sales_order_txn_id": "67890",
  "qb_sales_order_ref": "SO-1234",
  "qb_estimate_txn_id": "11111",
  "qb_estimate_ref": "EST-001",
  "qb_sales_receipt_txn_id": "12345",
  "qb_invoice_txn_id": "22222",
  "qb_payment_txn_id": "33333",
  "qb_synced_at": "2026-03-28T10:30:00Z"
}
```

### Forma Nueva (Nested — 2026+)

```json
{
  "qb_list_id": "ABC123",
  "qb_sales_order": {
    "txn_id": "67890",
    "ref_number": "SO-1234",
    "operation_id": "op_xyz",
    "synced_at": "2026-03-28T10:30:00Z"
  },
  "qb_estimate": {
    "txn_id": "11111",
    "ref_number": "EST-001",
    "operation_id": "op_abc",
    "synced_at": "2026-03-28T10:25:00Z"
  },
  "qb_invoices": [
    {
      "txn_id": "22222",
      "ref_number": "INV-001",
      "operation_id": "op_def",
      "synced_at": "2026-03-28T10:35:00Z"
    }
  ],
  "qb_payments": [
    {
      "txn_id": "33333",
      "ref_number": "PMT-001",
      "operation_id": "op_ghi",
      "synced_at": "2026-03-28T10:40:00Z"
    }
  ]
}
```

### Sentinelas Especiales

| Campo | Valor | Significado |
|-------|-------|-------------|
| `qb_so_txn_id` | `"SKIPPED_SALES_RECEIPT"` | Sales Receipt fue creada directamente sin SO previo; NO crear SO en cron |
| `is_draft_order` | `false` | Draft order fue convertido; NO crear Estimate en cron |

---

## Subscriber Guard

`qb-order-subscriber.ts` skipea de forma explícita los eventos de facturación para órdenes originadas en el POS para prevenir colisiones asíncronas:

```typescript
// Aplicado dentro del caso "order.fulfillment_created"
const query = container.resolve("query")
const { data: [fetchedOrder] } = await query.graph({
    entity: "order",
    fields: ["metadata"],
    filters: { id: orderIdStr }
})

if (fetchedOrder?.metadata?.pos_created) {
    logger.info(`[QB-ORDER] ⏭️ Skipping order.fulfillment_created for POS order ${orderIdStr}...`)
    break // Abandona el listener
}
```

> **Por qué:** El POS llama los endpoints QB directamente usando un patrón **Direct Execution background thread** (`setTimeout` dentro del handler REST) garantizando su ejecución sincrónica contra QuickBooks. El subscriber asíncrono BullMQ queda reservado estrictamente para el Web Store.

---

## Prevención de Colisiones (Concurrency & Locks)

Un escenario crítico superado en la arquitectura POS es cuando **múltiples vendedores cobran órdenes exactamente al mismo tiempo**. El sistema está blindado contra *"Race Conditions"* y datos superpuestos mediante 3 capas mecánicas:

1. **Direct Execution (Node.js):** Al evitar la cola nativa de eventos de Medusa (BullMQ) —la cual tiene un bug estructurado de pérdida de payloads bajo alta carga— cada orden dispara su propio hilo en Node.js que nunca se "droppea".
2. **SQLite FIFO Queue (QB Bridge):** Cuando Medusa dispara 4 peticiones a la vez (Ej: Factura A, Factura B, Pago A, Pago B), el Bridge de QB no colapsa a QuickBooks Desktop. El Bridge es una base de datos SQLite ultra-rápida (tabla `operations`) que actúa como cola transaccional. Anota ambas facturas secuencialmente (`Pending`). QB WebConnector realiza Long-Polling (cada 20s) y procesará la petición #1, y al terminar, se llevará la petición #2.
3. **Long-Polling TxnID Awaiter:** El `pos.payment.applied` **nunca se enviará al Bridge de QB** hasta que el código verifique que la factura padre ya existe y retorne su `TxnID`. 
   - *Mecánica:* El hilo del Pago en Medusa ejecuta un ciclo iterativo (`for(i=0; i<20; i++)`) pausando 20 segundos entre intentos (hasta 400s totales). Recién cuando QuickBooks reporta haber digerido exitosamente el `Invoice` (y el TxnID es inyectado de vuelta a la metadata de la orden), el `Payment` se libera e ingresa al Bridge como `Pending`. Esto prohíbe errores de sincronización (Ej Error 3140 o huérfanos).

---

## Manejo de Errores QB

| Error | Causa | Fix |
|-------|-------|-----|
| Error 3175 | QB abierto en modo edición (locked record) | Cerrar edición en QB Desktop y reintentar |
| `operationId` sin `txnId` | Bridge async — QB no respondió aún | Polling con `operationId` hasta obtener `txnId` |
| Customer no encontrado en QB | `qb_customer_id` en metadata inválido | Re-crear customer con `POST /quickbooks/customer` |
| Bridge timeout | QB Desktop cerrado o bridge caído | Verificar servicio bridge en servidor local |

---

## Variables de Entorno

| Variable | Descripción |
|----------|-------------|
| `QB_BRIDGE_URL` | URL del QB bridge (`https://qb.eptbridge.com`) |
| `QB_API_KEY` | API key del bridge (`mQb-xxx`) |
| `QB_ORDER_FLOW_ENABLED` | `true` para habilitar sync QB. `false` → endpoints devuelven `{ skipped: true }` |
| `POS_SALES_CHANNEL_ID` | Identifica órdenes del POS para skipear en subscriber |
