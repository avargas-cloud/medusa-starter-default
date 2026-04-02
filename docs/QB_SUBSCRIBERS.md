# QuickBooks Subscribers -- Referencia Completa
> **Tipo**: Technical Reference
> **Repo**: backend
> **Ultima verificacion**: 2026-04-02
> **Estado**: Current

---

## Que son y donde viven

Los subscribers son funciones que Medusa invoca automaticamente cuando ocurre un evento del sistema. Los subscribers QB viven en `src/subscribers/` y conectan eventos de Medusa con operaciones de QB via los handlers en `src/lib/quickbooks/handlers/`.

**Principio fundamental:** QB failures **NUNCA** bloquean el flujo de Medusa. Cada subscriber captura todas las excepciones internamente y loguea sin propagar.

**Feature flag global:** `QB_ORDER_FLOW_ENABLED=true` en `.env`. Sin este flag, los subscribers se registran pero salen inmediatamente.

---

## Subscribers QB

```
src/subscribers/
+-- qb-order-subscriber.ts         <- Ciclo de vida completo de orders
+-- qb-draft-order-subscriber.ts   <- Draft orders -> QB Estimates
+-- qb-payment-subscriber.ts       <- Pagos POS -> QB (payment.created/applied/unapplied)
+-- qb-metadata-init-subscriber.ts <- Inicializa campos QB en nuevos draft orders
```

---

## 1. `qb-order-subscriber.ts`

**Log prefix:** `[QB-ORDER]`

### Eventos suscritos (config real en codigo)

```typescript
export const config: SubscriberConfig = {
    event: [
        "order.placed",
        "order.payment_captured",
        "order.fulfillment_created",
        "order.canceled",
        "pos.invoice.created",
        "pos.invoice.voided",
        // NOTA: "order.customer_transferred" NO aparece en el array config
        // pero si en el switch -- revisar si es un bug o el evento viene
        // por otra via
    ],
    context: { subscriberId: "qb-order-subscriber" },
}
```

**IMPORTANTE:** El codigo en el switch maneja `order.customer_transferred` pero este evento NO esta en el array `event` del config. Requiere investigacion.

### Eventos manejados

| Evento Medusa | Handler | Accion QB | Alcance |
|---|---|---|---|
| `order.placed` | `handleOrderPlaced` | Crea Sales Order (o convierte Estimate->SO) | Web + POS |
| `order.payment_captured` | `handlePaymentCaptured` | Receive Payment | **POS only** -- web skipped (hook lo maneja) |
| `order.fulfillment_created` | `handleFulfillmentCreated` | Crea Invoice + aplica pago | **Web only** -- POS usa direct-exec |
| `order.canceled` | `handleOrderCanceled` | Cierra Sales Order + Voidea Invoice | Web + POS |
| `pos.invoice.created` | `handleFulfillmentCreated` | Crea Invoice POS | POS only |
| `pos.invoice.voided` | `handleInvoiceVoided` | Voidea Invoice POS | POS only |

### Logica de routing por canal

```typescript
// order.payment_captured: solo para POS
if (!isPosOrder(paymentOrder)) {
    // skip -- web orders manejados por maintain-cart-prices hook
}

// order.fulfillment_created: solo para Web
if (isPosOrder(fetchedOrder)) {
    // skip -- POS invoices usan direct-exec para evitar BullMQ outbox drops
}
```

La funcion `isPosOrder()` chequea: `sales_channel_id === POS_SALES_CHANNEL_ID` O `metadata.pos_created === 'true'`.

---

## 2. `qb-draft-order-subscriber.ts`

**Log prefix:** `[QB-DRAFT]`

### Evento suscrito

```typescript
export const config: SubscriberConfig = {
    event: ["draft_order.created"],
    context: { subscriberId: "qb-draft-order-subscriber" },
}
```

### Logica

1. **Guard de duplicado:** Verifica si ya hay una fila `submitted` o `confirmed` en el pipeline para este order_id + step='estimate'. Si existe, sale sin hacer nada.
2. **POS guard:** Si es una orden POS, escribe una fila `waiting` en el pipeline y sale. El cron `qb-pos-sync` la procesara en 1 hora.
3. **Web:** Crea el Estimate inmediatamente: ensureCustomerInQb -> buildQbItems -> processEstimateInQb -> writePipelineRow -> actualiza metadata del draft order.

### Metadata escrita al draft order

```typescript
{
    qb_estimate: {
        ref_number: string,      // ej. "E1271"
        txn_id: string,          // QB TxnID
        operation_id: string | null,
        edit_sequence: string | null,
        synced_at: string
    },
    qb_sync_status: "pending" | "synced",
    qb_list_id: string,          // QB ListID del customer
    qb_synced_at: string
}
```

### Exportaciones publicas

`handleDraftOrderCreated` se exporta y es invocada por:
- El cron `qb-pos-sync` (con `isCron=true`)
- El endpoint de retry del pipeline

---

## 3. `qb-payment-subscriber.ts`

**Log prefix:** `[QB-PAYMENT]`

### Eventos suscritos

```typescript
export const config: SubscriberConfig = {
    event: [
        "pos.payment.created",
        "pos.payment.applied",
        "pos.payment.unapplied",
    ],
    context: { subscriberId: "qb-payment-subscriber" },
}
```

### Eventos manejados

| Evento | Handler | Accion QB |
|--------|---------|-----------|
| `pos.payment.created` | `handlePosPaymentCreated` | Receive Payment (credito sin aplicar) |
| `pos.payment.applied` | `handlePosPaymentApplied` | Apply Payment a Invoice en QB |
| `pos.payment.unapplied` | `handlePosPaymentUnapplied` | Revertir aplicacion de pago |

---

## 4. `qb-metadata-init-subscriber.ts`

**Log prefix:** `[QB-INIT]`

### Evento suscrito

```
event: "order.updated"
```

Sin `subscriberId` configurado (usa el nombre del archivo por defecto).

### Logica

Inicializa campos QB en draft orders nuevos:
1. Solo procesa si `order.status === 'draft'`
2. Solo procesa si los campos `qb_estimate_ref` / `qb_estimate_txn_id` NO existen en metadata
3. Si ambas condiciones se cumplen, escribe `{ qb_estimate_ref: null, qb_estimate_txn_id: null }` en metadata

**Por que existe:** En Medusa v2, los draft orders se crean via multiples eventos `order.updated` (item added, shipping added, etc.). Este subscriber asegura que los campos QB aparezcan en el metadata panel del Admin tan pronto como el draft order existe.

---

## Handlers

Todos los handlers viven en `src/lib/quickbooks/handlers/`:

| Archivo | Exporta | Disparado por |
|---------|---------|---------------|
| `handle-order-placed.ts` | `handleOrderPlaced` | qb-order-subscriber, qb-pos-sync (cron), pipeline retry |
| `handle-payment-captured.ts` | `handlePaymentCaptured` | qb-order-subscriber |
| `handle-fulfillment-created.ts` | `handleFulfillmentCreated` | qb-order-subscriber, invoice POST route (direct-exec) |
| `handle-order-canceled.ts` | `handleOrderCanceled` | qb-order-subscriber |
| `handle-invoice-voided.ts` | `handleInvoiceVoided` | qb-order-subscriber |
| `handle-customer-transferred.ts` | `handleCustomerTransferred` | qb-order-subscriber |
| `handle-pos-payment-created.ts` | `handlePosPaymentCreated` | qb-payment-subscriber, qb-pos-sync retry, pipeline retry |
| `handle-pos-payment-applied.ts` | `handlePosPaymentApplied` | qb-payment-subscriber, pipeline retry |
| `handle-pos-payment-unapplied.ts` | `handlePosPaymentUnapplied` | qb-payment-subscriber |
| `handle-sales-receipt-created.ts` | `handleSalesReceiptCreated` | invoice POST route (direct-exec), pipeline retry |
| `utils.ts` | `isPosOrder` | Todos los handlers y subscribers |

### Direct-exec para POS invoices

Los handlers `handleFulfillmentCreated` y `handleSalesReceiptCreated` son invocados directamente desde el route `POST /admin/invoices` (sin pasar por el event bus). Esto es intencional: el event bus de Medusa (BullMQ) puede dropped los eventos POS en ciertas condiciones. Direct-exec garantiza que la sincronizacion ocurre.

---

## Archivos Clave

| Tipo | Ruta | Proposito |
|------|------|-----------|
| Subscriber principal | `src/subscribers/qb-order-subscriber.ts` | Order lifecycle |
| Subscriber draft | `src/subscribers/qb-draft-order-subscriber.ts` | Estimates |
| Subscriber pagos | `src/subscribers/qb-payment-subscriber.ts` | POS payments |
| Subscriber init | `src/subscribers/qb-metadata-init-subscriber.ts` | Inicializacion metadata |
| Handlers dir | `src/lib/quickbooks/handlers/` | Implementacion de cada accion |
| Utils | `src/lib/quickbooks/handlers/utils.ts` | isPosOrder() |

---

## Historial de Decisiones

- **order.customer_transferred no en config array:** Parece un bug o el evento llega por otra via. No se ha investigado porque la funcionalidad de customer transfer rara vez se usa.
- **Direct-exec para POS:** BullMQ outbox en Medusa v2 puede perder eventos cuando hay alta carga. El direct-exec desde el route garantiza que QB recibe la operacion sincrona con la creacion del invoice.
- **qb-payment-subscriber separado:** Los eventos `pos.payment.*` se separaron del subscriber principal para claridad y para poder deshabilitar solo el flujo de pagos si es necesario.
