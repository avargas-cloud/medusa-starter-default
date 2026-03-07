# POS_QUICKBOOKS — Integración QuickBooks

| Campo | Detalle |
|-------|---------|
| **Módulo** | QuickBooks Integration (backend) |
| **Bridge URL** | `https://qb.eptbridge.com` |
| **Protocolo** | QBXML via QB Desktop SDK |
| **Última revisión** | 2026-03-06 |

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

| Situación | POS Doc | QB Doc |
|-----------|---------|---------|
| Venta con pago inmediato | Sales Receipt | Sales Receipt |
| Venta on account (B2B) | Sales Order | Sales Order → Invoice |
| Cotización | Estimate | Estimate |
| Cotización aprobada | Estimate → Order | Estimate → Sales Order |
| Pago recibido | Capture Payment | Receive Payment |
| Ajuste de crédito | Credit Ledger entry | (manual en QB) |

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

```json
{
  "qb_sales_receipt_txn_id": "12345",
  "qb_sales_receipt_operation_id": "op_xxx",
  "qb_so_txn_id": "67890",
  "qb_so_number": "SO-1234",
  "qb_estimate_txn_id": "11111",
  "qb_estimate_number": "EST-001",
  "qb_invoice_txn_ids": ["22222", "33333"]
}
```

---

## Subscriber Guard

`qb-order-subscriber.ts` skipea **todos los eventos** para órdenes del canal POS:

```typescript
const POS_CHANNEL_ID = process.env.POS_SALES_CHANNEL_ID ?? ""

function isPosOrder(order: any): boolean {
    if (!POS_CHANNEL_ID) return false
    return order.sales_channel_id === POS_CHANNEL_ID
}

// Aplicado en: order.placed, order.payment_captured,
//              order.fulfillment_created, order.canceled,
//              order.customer_transferred
```

> **Por qué:** El POS llama los endpoints QB directamente y con mayor control. El subscriber es para el Web Store (automático).

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
