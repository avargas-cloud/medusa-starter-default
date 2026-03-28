# QuickBooks Subscribers — Complete Reference

> **For agents:** This document covers all event subscribers in `backend/src/subscribers/`.
> Search terms: subscriber, event handler, qb-order-subscriber, qb-draft-order-subscriber, qb-metadata-init-subscriber, order.placed, order.canceled, draft_order.created, event-driven

| Campo | Detalle |
|-------|---------|
| **Ubicación** | `backend/src/subscribers/` |
| **Última revisión** | 2026-03-28 |
| **Relacionado con** | `DRAFT_ORDER_ADVANCED_UI.md` (sección 14), `QB_BRIDGE_CLIENT.md`, `QB_DOCUMENT_FLOW_REDESIGN.md` |

---

## Overview — Cómo funcionan los Subscribers en Medusa v2

Los subscribers son funciones asíncronas que Medusa llama automáticamente cuando ocurre un evento del sistema (order placed, canceled, etc.). Se registran en `src/subscribers/` y Medusa los descubre automáticamente.

**Principio fundamental:** QB failures **NUNCA** bloquean el flujo de Medusa. Cada subscriber captura todas las excepciones internamente.

**Feature flag global:** Todos los subscribers QB respetan `QB_ORDER_FLOW_ENABLED=true`. Sin este flag, los subscribers se registran pero salen inmediatamente sin hacer nada.

**Log prefix por subscriber:**

| Subscriber | Log Prefix |
|-----------|------------|
| `qb-order-subscriber.ts` | `[QB-ORDER]` |
| `qb-draft-order-subscriber.ts` | `[QB-DRAFT]` |
| `qb-metadata-init-subscriber.ts` | `[QB-INIT]` |

---

## Subscribers Files

```
backend/src/subscribers/
├── qb-order-subscriber.ts         ← Principal: maneja todo el ciclo de vida de orders
├── qb-draft-order-subscriber.ts   ← Draft orders → QB Estimates (auto)
└── qb-metadata-init-subscriber.ts ← Inicializa campos QB en nuevos draft orders
```

---

## 1. `qb-order-subscriber.ts` — Order Lifecycle → QB

**El subscriber más importante.** Conecta todos los eventos del ciclo de vida de órdenes con QuickBooks.

### Eventos que maneja

| Evento Medusa | Handler | Acción QB |
|---|---|---|
| `order.placed` | `handleOrderPlaced` | Crea Sales Order (o convierte Estimate→SO) |
| `order.payment_captured` | `handlePaymentCaptured` | Receive Payment (crédito sin aplicar) |
| `order.fulfillment_created` | `handleFulfillmentCreated` | Crea Invoice + aplica pago |
| `order.canceled` | `handleOrderCanceled` | Cierra Sales Order + Voidea Invoice |
| `order.customer_transferred` | `handleCustomerTransferred` | Reasigna documentos QB al nuevo customer |

### Config del subscriber

```typescript
export const config: SubscriberConfig = {
    event: [
        "order.placed",
        "order.payment_captured",
        "order.fulfillment_created",
        "order.canceled",
        "order.customer_transferred",
    ],
    context: {
        subscriberId: "qb-order-subscriber",
    },
}
```

---

### Handler: `handleOrderPlaced`

**Trigger:** `order.placed` — emitido cuando un draft order se convierte en order confirmado.

**Flujo:**
```
1. Idempotency Layer 1: In-memory Set check (process-local mutex)
2. Fetch order via query.graph (con items, customer, shipping, metadata)
   - NOTA: query.graph devuelve unit_price en DOLLARS (e.g. 22.25)
3. Idempotency Layer 2: Check qb_sales_order_txn_id in metadata → ya procesado
4. Idempotency Layer 3: Check qb_sales_order_operation_id → QBWC en progreso
5. POS guard: Si order.sales_channel_id = POS channel → skip (delayed 1hr por cron job)
6. ensureCustomerInQb() → crea/vincula customer en QB
7. Discount strategy (UNIVERSAL — aplica a CUALQUIER tipo de descuento):
   a. unit_price de query.graph está en DOLLARS → multiplicar ×100 antes de buildQbItems
   b. buildQbItems() → mapea items con unit_price en cents → QB Rate en dólares correctos
   c. Si discount_total > 0:
      - Append: «Order Item Subtotal» (QB Subtotal item, sin quantity)
      - Append: «Order Discount (X%)» (QB Discount item, Amount=-$X.XX, sin quantity)
8. buildShippingQbItem() → agrega shipping como ÚLTIMA línea (fuera del Subtotal, no descontado)
9. If qb_estimate_txn_id exists → EstimateToSalesOrder (convierte Estimate→SO en QB)
   else → SalesOrderAdd (crea nuevo SO)
10. Guarda qb_sales_order_operation_id en metadata (QBWC pending)
11. QBWC procesa → guarda qb_sales_order_txn_id + qb_sales_order_ref en metadata
```

**Orden de líneas en QB (con descuento):**
```
1. EAP-AS1-8W  | Qty=4 | Rate=22.25 | Amount=89.00
2. Order Item Subtotal            (QB Subtotal — suma todo lo de arriba)
3. Order Discount (5%)           (QB Discount — Amount=-$4.45)
4. Shipping & Handling           (si aplica — fuera del descuento)
   ─────────────────────────────────────────
   Tax 7%  = $5.91  (calculado sobre $84.55, post-descuento ✅)
   Total   = $90.47
```

> **⚠️ QBXML Gotcha:** QB Subtotal y Discount item types NO ACEPTAN `<Quantity>`. Si se envía quantity, QB lanza Error 3060. Estos items solo usan `<Desc>` y `<Amount>` (o `<Rate>` para porcentaje).

**Metadata que lee:**
- `qb_list_id` — QB Customer ListID (del customer)
- `qb_estimate_txn_id` — determina si hacer EstimateToSalesOrder vs SalesOrderAdd
- `qb_sales_order_txn_id` — guard Layer 2
- `qb_sales_order_operation_id` — guard Layer 3

**Metadata que escribe:**
- `qb_list_id` (customer)
- `qb_sales_order_operation_id` (inmediato, QBWC pending)
- `qb_sales_order_txn_id` (después de QBWC)
- `qb_sales_order_ref` (después de QBWC)

**Idempotency — 3 capas:**

```typescript
// Layer 1: In-memory Set (prevents concurrent processing in same process)
const processingOrders = new Set<string>()
if (processingOrders.has(orderId)) return
processingOrders.add(orderId)
try {
    // Layer 2: Already fully processed (txnId = QBWC confirmed)
    if (order.metadata?.qb_sales_order_txn_id) return

    // Layer 3: Already queued (operationId = QBWC in progress)
    if (order.metadata?.qb_sales_order_operation_id) return

    // ... process ...
} finally {
    processingOrders.delete(orderId)
}
```

| Layer | Guard | Survives server restart? |
|-------|-------|--------------------------|
| 1 | In-memory `Set` | ❌ (process-local) |
| 2 | `qb_sales_order_txn_id` in DB | ✅ |
| 3 | `qb_sales_order_operation_id` in DB | ✅ |

**Precio gotcha:**
```typescript
// ✅ Canonical price — order_line_item table (correcto)
unit_price: Math.round((item.item?.unit_price ?? item.unit_price ?? 0) * 100)
// ⚠️ items.unit_price = order_item join table (puede estar en cents, NO usar)
// ✅ items.item.unit_price = order_line_item.unit_price (canonical dollar amount)
```

---

### Handler: `handlePaymentCaptured`

**Trigger:** `order.payment_captured`

**Flujo:**
```
1. Fetch order (metadata: qb_sales_order_txn_id)
2. If no SO → skip (payment without SO = manual flow)
3. processPaymentCaptureInQb() → QB ReceivePayment (unapplied credit)
4. Guarda qb_payment_txn_id + qb_payment_ref en metadata
```

**Metadata que lee:** `qb_sales_order_txn_id`, `qb_list_id`
**Metadata que escribe:** `qb_payment_txn_id`, `qb_payment_ref`

---

### Handler: `handleFulfillmentCreated`

**Trigger:** `order.fulfillment_created`

**Flujo Web (Normal):**
1. Fetch order (con items, customer, shipping, metadata)
2. **Guardian POS (Marzo 2026):** Si `order.metadata.pos_created === true`, abandona el proceso de inmediato. El POS usa el patrón interno de "Direct Execution" (`POST /admin/invoices`) evitando fallos de inestabilidad en la cola asíncrona de BullMQ/Redis.
3. If no SO (qb_sales_order_txn_id) → skip
4. processInvoiceInQb() → QB Invoice (aplica pago si existe)
5. Guarda qb_invoice_txn_id + qb_invoice_ref en metadata

**Metadata que lee:** `qb_sales_order_txn_id`, `qb_payment_txn_id`, `qb_list_id`
**Metadata que escribe:** `qb_invoice_txn_id`, `qb_invoice_ref`

### Sales Receipt Qualification Guard

**Contexto:** Cuando se crea un `pos.sales_receipt` (venta completa con pago inmediato), el handler intenta crear un QB Sales Receipt. Pero si el cron ya creó un Sales Order o Estimate para la misma orden, el Sales Receipt será redundante.

**Guard Logic en `handle-sales-receipt-created.ts`:**
```typescript
// Antes de crear Sales Receipt, verificar si ya existe SO o Estimate
const soTxnId = getSoTxnId(order.metadata)  // Lee nested + flat shape
const estimateTxnId = getEstimateTxnId(order.metadata)

if (soTxnId || estimateTxnId) {
    // Ya existe documento QB anterior → recurrir a Invoice en lugar de Sales Receipt
    await handleFulfillmentCreated(order)
    return
}

// No hay SO ni Estimate → proceder a crear Sales Receipt
await processSalesReceiptInQb(...)
```

**Propósito:** Evitar duplicados de QB documents cuando el cron de 1 hora ya procesó el SO/Estimate.

**Caso específico:** Cuando un cliente POS hace una compra con pago inmediato, pero el cron corre justo antes:
1. Cron crea Sales Order (porque orden tiene 45 minutos)
2. Fulfillment se dispara → intenta crear Sales Receipt
3. Guard detect SO existente → crea Invoice en su lugar (correcto, no duplica SO)

---

### Handler: `handleOrderCanceled`

**Trigger:** `order.canceled` — emitido por `emit-order-events.ts` hook (ver sección Event Delivery).

**Flujo:**
```
1. Fetch order (metadata: qb_sales_order_txn_id, qb_sales_order_ref, qb_invoice_txn_id, qb_invoice_ref)
2. If no SO ni Invoice → skip (nothing to cancel)
3. Build docLabel: "SO #6176" o "SO #6176, Invoice #5" (para Activity Log)
4. QbSyncLogger.start() → Activity Log "Processing"
5. If invoiceTxnId → voidInvoiceInQb() → QB TxnVoidRq via bridge DELETE /api/invoices/:txnId
6. If soTxnId → closeSalesOrderInQb()
       → bridge GET /api/sales-orders/:txnId (Poll ~40-60s → EditSequence)
       → bridge DELETE /api/sales-orders/:txnId (close command → operationId)
7. QbSyncLogger.complete(qbRefNumber=soRef) → Activity Log "Completed" con QB Ref #
```

> **⚠️ Optimistic Complete:** El Activity Log marca `completed` cuando el close está **queued** en el bridge — no cuando QBWC lo ejecuta. QBWC aún necesita ~20-60s para cerrar el SO en QB Desktop. El nightly job verifica el estado real.

**Metadata que lee:**
- `qb_sales_order_txn_id`, `qb_sales_order_ref`
- `qb_invoice_txn_id`, `qb_invoice_ref`

**Activity Log:** Entrada con `operation='cancel'`, `qb_ref_number=soRef`, message=`"SO #6176 closed/voided for Order #1087"`

---

### Handler: `handleCustomerTransferred`

**Trigger:** `order.customer_transferred`

**Flujo:**
```
1. Fetch order + new customer (con metadata)
2. Get new customer qb_list_id
3. transferDocumentCustomer() para SO (si existe)
4. transferDocumentCustomer() para Invoice (si existe)
```

---

## 2. `qb-draft-order-subscriber.ts` — Draft Orders → QB Estimates (Auto)

Crea un QB Estimate automáticamente cuando se crea un Draft Order en el Admin.

> **CRÍTICO:** El evento `draft_order.created` **NUNCA dispara en Medusa v2**. Este subscriber está efectivamente en código muerto.
>
> La función `handleDraftOrderCreated` existe y funciona correctamente, pero se invoca **exclusivamente** por:
> 1. El cron `qb-pos-sync.ts` (cada 30 minutos, para órdenes POS con `is_draft_order=true` y sin `qb_estimate_txn_id`)
> 2. El endpoint manual de sincronización (`POST /admin/pos/sync`)
>
> El subscriber config registra el evento nativo, pero la configuración de Medusa v2 no lo emite. Esto es diferente de `order.updated` en `qb-metadata-init-subscriber.ts`.

### Evento que maneja

| Evento | Handler | Acción |
|--------|---------|--------|
| `draft_order.created` | `handleDraftOrderCreated` | Crea Estimate en QB |

### Flujo

```
1. query.graph → fetch draft order (con items, customer, customer.metadata)
2. If no customer → skip
3. ensureCustomerInQb() → crea/vincula customer en QB si no existe
4. buildQbItems() → filtra items con variant.metadata.quickbooks_id
   - unit_price viene en DOLLARS de query.graph → convierte ×100 a cents para buildQbItems
5. If 0 QB-linked items → skip (items sin quickbooks_id no se sincronizan)
6. processEstimateInQb() → QB EstimateAdd via bridge
7. Guarda en draft order metadata:
   - qb_list_id (customer QB ID)
   - qb_estimate_txn_id
   - qb_estimate_ref
   - qb_estimate_operation_id
   - qb_synced_at
```

### Config

```typescript
export const config: SubscriberConfig = {
    event: ["draft_order.created"],
    context: { subscriberId: "qb-draft-order-subscriber" },
}
```

### Metadata que escribe (en draft order)

| Key | Descripción |
|-----|-------------|
| `qb_list_id` | QB Customer ListID |
| `qb_estimate_txn_id` | QB Estimate TxnID |
| `qb_estimate_ref` | QB Estimate Ref # |
| `qb_estimate_operation_id` | Bridge operationId (QBWC pending) |
| `qb_synced_at` | ISO timestamp del sync |

> Cuando el draft se convierte a order, `qb-order-subscriber.ts` detecta `qb_estimate_txn_id` y hace EstimateToSalesOrder en QB en lugar de crear un nuevo SO.

---

## 3. `qb-metadata-init-subscriber.ts` — QB Metadata Initializer

Subscriber liviano que inicializa los campos QB en metadata de draft orders para que aparezcan en el Admin metadata panel.

### Evento que maneja

| Evento | Acción |
|--------|--------|
| `order.updated` | Si es draft sin QB metadata → inicializa campos a `null` |

### Por qué existe

En Medusa v2, los draft orders son órdenes con `status='draft'`. El Admin UI los crea paso a paso vía `order_edit` flows. El evento `order.updated` dispara en cada paso (item añadido, shipping añadido, etc.). Este subscriber aprovecha ese evento para inicializar los campos QB antes de que aparezca la UI.

### Flujo

```typescript
1. Fetch order (solo id, status, metadata)
2. If order.status !== 'draft' → return (ignorar orders confirmados)
3. If 'qb_estimate_ref' ya existe en metadata → return (ya inicializado)
4. orderModule.updateOrders() → adds { qb_estimate_ref: null, qb_estimate_txn_id: null }
```

### Config

```typescript
export const config: SubscriberConfig = {
    event: "order.updated",
    // No subscriberId — default naming
}
```

---

## 4. Pipeline Table Integration — `qb_order_pipeline`

**Desde Marzo 2026:** Todos los handlers QB escriben a la tabla `qb_order_pipeline` inmediatamente después de enviar una operación al bridge.

### Tabla `qb_order_pipeline`

```sql
CREATE TABLE qb_order_pipeline (
    id UUID PRIMARY KEY,
    order_id UUID NOT NULL,
    reference_id TEXT,              -- invoice_id, fulfillment_id, sales_receipt_id, etc.
    reference_type VARCHAR,         -- 'invoice', 'fulfillment', 'sales_receipt', 'credit_memo'
    step VARCHAR NOT NULL,          -- 'estimate', 'sales_order', 'invoice', 'sales_receipt', 'payment', 'credit_memo', 'write_check'
    status VARCHAR NOT NULL,        -- 'pending', 'submitted', 'confirmed', 'failed', 'skipped'
    depends_on UUID,                -- reference a otra fila (ej: invoice_pending si SO no existe)
    bridge_op_id TEXT,              -- operationId del bridge
    retry_count INT DEFAULT 0,
    qb_txn_id TEXT,                -- TxnID confirmado por QB/QBWC
    qb_ref_number TEXT,            -- Ref # confirmado (ej "6175")
    qb_result JSONB,               -- Full QB response
    payload JSONB,                 -- Original request payload
    error TEXT,                    -- Error message si falló
    submitted_at TIMESTAMP,        -- Cuando se envió al bridge
    confirmed_at TIMESTAMP,        -- Cuando QBWC confirmó
    failed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_qb_order_pipeline_order_id ON qb_order_pipeline(order_id);
CREATE INDEX idx_qb_order_pipeline_status ON qb_order_pipeline(status);
CREATE INDEX idx_qb_order_pipeline_bridge_op_id ON qb_order_pipeline(bridge_op_id);
```

### Flujo de Escritura

Cada handler escribe una fila cuando envía a bridge:

```typescript
// Ejemplo: handleOrderPlaced → Sales Order
await writePipelineRow({
    orderId: order.id,
    referenceName: order.id,
    referenceType: 'order',
    step: 'sales_order',
    status: 'submitted',
    bridgeOpId: response.operationId,
    payload: qbItem,
    submittedAt: new Date(),
})
```

**Estados posibles:**
- `pending` — No se ha enviado a bridge (futuro)
- `submitted` — Enviado al bridge, esperando QBWC
- `confirmed` — QBWC procesó exitosamente (qb_txn_id populated)
- `failed` — QBWC encontró un error
- `skipped` — No se ejecutó (ej: no hay items QB-linked)

### Consolidador de Pipeline (`qb-pipeline-consolidator`)

**Cron:** Cada 2 minutos (`*/2 * * * *`)

**Lógica:**
```typescript
1. SELECT * FROM qb_order_pipeline WHERE status='submitted' AND bridge_op_id IS NOT NULL LIMIT 50
2. Para cada fila:
    a. GET /api/sync/status/{operationId} en el bridge
    b. Si completada:
        - confirmPipelineRow(rowId, txnId, refNumber, result)
        - cacheEditSequence(step, qbId, editSeq)
    c. Si falló:
        - failPipelineRow(rowId, errorMessage)
3. Log cada cambio a Activity Log
```

**Tabla de Cache — `qb_edit_sequence_cache`:**

```sql
CREATE TABLE qb_edit_sequence_cache (
    entity_type VARCHAR NOT NULL,   -- 'estimate', 'sales_order', 'invoice', 'payment'
    qb_id TEXT NOT NULL,            -- TxnID de QB
    edit_seq TEXT NOT NULL,         -- EditSequence de QB
    cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(entity_type, qb_id)
);
```

**Propósito:** Cuando se necesita hacer una operación posterior (ej: modificar un SO existente, cerrar un SO), primero se fetch el EditSequence actual del cache. Si no está en cache, se hace un GET al bridge.

### Uso en Handlers Actualizados

**Handlers que escriben pipeline (desde Marzo 2026):**
- `handle-order-placed.ts` → `sales_order` step
- `handle-fulfillment-created.ts` → `invoice` step
- `handle-sales-receipt-created.ts` → `sales_receipt` step
- `handle-payment-captured.ts` → `payment` step
- `qb-draft-order-subscriber.ts` / `handleDraftOrderCreated` → `estimate` step
- `credit_memos/[id]/complete/route.ts` → `credit_memo` step, y para reembolsos en cash también `write_check` con status `pending`

---

## Event Delivery — `emit-order-events.ts`

**Archivo:** `backend/src/workflows/hooks/emit-order-events.ts`

Los subscribers no recibirían eventos en dev si dependieran únicamente del bus de eventos de Redis de Medusa (que es asíncrono). Este archivo re-emite eventos críticos directamente desde los workflow hooks.

### El evento `order.canceled` — Gotcha crítico

```typescript
// cancelOrderWorkflow.hooks.orderCanceled
// ⚠️ El hook recibe { order } (objeto completo), NO { order_id }
cancelHooks.orderCanceled(
    async ({ order }: { order: any }, { container }) => {
        const order_id = order?.id  // ✅ Correcto: acceder via order.id
        // ❌ const { order_id } = ... // INCORRECTO: destructurar order_id daría undefined
        const eventBusService = container.resolve(Modules.EVENT_BUS)
        await eventBusService.emit({ eventName: "order.canceled", data: { id: order_id } })
    }
)
```

> **Bug histórico:** El hook originalmente usaba `{ order_id }` en el destructuring, lo que resultaba en `id: undefined` en el evento, haciendo que `handleOrderCanceled` ignorara todos los cancels.

---

## Todos los Metadata Keys — Referencia Completa

> **Forma Antigua (Flat):** Órdenes antes de Marzo 2026 tienen claves planas (`qb_so_txn_id`, `qb_estimate_txn_id`, etc.).
> **Forma Nueva (Nested):** Nuevas órdenes usan forma anidada (`qb_sales_order: {...}`, `qb_estimate: {...}`, etc.).
> **Lectores Helper:** Funciones en `src/lib/quickbooks/qb-metadata-types.ts` leen ambas formas automáticamente.

### En order metadata

#### Forma Antigua (Flat — Backward Compat)

| Key | Quién lo escribe | Descripción |
|-----|------------------|-------------|
| `qb_list_id` | `handleOrderPlaced` | QB Customer ListID |
| `qb_sales_order_operation_id` | `handleOrderPlaced` | Bridge operationId — QBWC pending |
| `qb_sales_order_txn_id` | QBWC callback → `handleOrderPlaced` | QB Sales Order TxnID (confirmado) |
| `qb_sales_order_ref` | QBWC callback → `handleOrderPlaced` | QB Sales Order Ref # (e.g. "6175") |
| `qb_estimate_txn_id` | cron / subscriber | QB Estimate TxnID |
| `qb_estimate_ref` | cron / subscriber | QB Estimate Ref # |
| `qb_payment_txn_id` | `handlePaymentCaptured` | QB Payment TxnID |
| `qb_payment_ref` | `handlePaymentCaptured` | QB Payment Ref # |
| `qb_invoice_txn_id` | `handleFulfillmentCreated` | QB Invoice TxnID |
| `qb_invoice_ref` | `handleFulfillmentCreated` | QB Invoice Ref # |
| `qb_synced_at` | Varios | ISO timestamp del último sync |

#### Forma Nueva (Nested — 2026+)

| Key | Estructura | Descripción |
|-----|-----------|-------------|
| `qb_sales_order` | `{ txn_id, ref_number, operation_id, synced_at }` | Sales Order completo |
| `qb_estimate` | `{ txn_id, ref_number, operation_id, synced_at }` | Estimate completo |
| `qb_invoices` | `[{ txn_id, ref_number, operation_id, synced_at }]` | Array de invoices |
| `qb_payments` | `[{ txn_id, ref_number, operation_id, synced_at }]` | Array de payments |
| `qb_list_id` | string | QB Customer ListID (sigue siendo plano) |

**Lectores Helper (leen ambas formas):**
```typescript
getSoTxnId(metadata)           // → txn_id o null
getEstimateTxnId(metadata)     // → txn_id o null
getLatestInvoiceTxnId(metadata) // → último txn_id de array o null
getLatestPaymentTxnId(metadata) // → último txn_id de array o null
```

**Constructores de Patch (escriben forma anidada):**
```typescript
buildSaleOrderPatch(txnId, refNumber, operationId)
buildEstimatePatch(txnId, refNumber, operationId)
buildInvoicePatch(txnId, refNumber, operationId)
buildPaymentPatch(txnId, refNumber, operationId)
```

### En draft order metadata

| Key | Quién lo escribe | Descripción |
|-----|------------------|-------------|
| `qb_estimate_ref` | `qb-draft-order-subscriber` o cron | QB Estimate Ref # |
| `qb_estimate_txn_id` | `qb-draft-order-subscriber` o cron | QB Estimate TxnID |
| `qb_estimate_operation_id` | `qb-draft-order-subscriber` | Bridge operationId (QBWC pending) |
| `qb_estimate_status` | `qb-draft-order-subscriber` | "Created", "Sent", etc. |
| `qb_list_id` | `qb-draft-order-subscriber` | QB Customer ListID |
| `qb_synced_at` | `qb-draft-order-subscriber` | ISO timestamp |

### Sentinelas Especiales

| Key | Valor | Significado |
|-----|-------|-------------|
| `qb_so_txn_id` | `"SKIPPED_SALES_RECEIPT"` | Sales Receipt fue creada directamente, no crear SO en el cron |
| `is_draft_order` | `false` | Draft fue convertido (via `convert-force`), cron no debe crear Estimate |

---

## Debugging — Cómo investigar un subscriber

### 1. Verificar que el evento llegó

```bash
# Buscar en logs del backend
tmux capture-pane -t medusa-dev -p -S -200 | grep "QB-ORDER\|QB-DRAFT\|QB-INIT"
```

Los primeros logs de cada handler son:
```
[QB-ORDER] 📥 Received event: order.canceled | data: {"id":"order_01KK..."}
[QB-ORDER] ── order.canceled → order_01KK... ──
[QB-ORDER] Order metadata: {"qb_sales_order_txn_id":"..."}
```

### 2. Verificar el Activity Log (DB)

```sql
SELECT id, operation, status, order_display_id, message, error, qb_txn_id, qb_ref_number,
       initiated_at, completed_at, duration_ms
FROM qb_sync_log
ORDER BY initiated_at DESC
LIMIT 20;
```

### 3. Verificar metadata de una orden específica

```sql
-- Buscar orden por display_id
SELECT id, display_id, status, metadata
FROM "order"
WHERE display_id = 1087;

-- Verificar campos QB
SELECT
    id,
    display_id,
    metadata->>'qb_sales_order_txn_id' as so_txn_id,
    metadata->>'qb_sales_order_ref' as so_ref,
    metadata->>'qb_invoice_txn_id' as inv_txn_id,
    metadata->>'qb_invoice_ref' as inv_ref,
    metadata->>'qb_estimate_txn_id' as est_txn_id
FROM "order"
WHERE display_id = 1087;
```

### 4. Common failure patterns

| Síntoma | Causa probable | Diagnóstico |
|---------|----------------|-------------|
| No aparece `[QB-ORDER] 📥 Received event` | Evento no llegó al subscriber | Ver `[emit-order-events]` logs |
| `Order ... has no QB documents — nothing to cancel` | `qb_sales_order_txn_id` vacío en metadata | Verificar DB |
| Activity Log stuck en "Processing" | Backend se reinició durante QBWC polling | Se auto-limpia a "failed" en 5 min |
| `[QB-ORDER] ⏭️ QB_ORDER_FLOW_ENABLED=false` | Feature flag apagado | `QB_ORDER_FLOW_ENABLED=true` en .env |
| SO creado 2 veces en QB | Evento disparó 2 veces Y los 3 guards fallaron | Verificar operationId guard (Layer 3) |
| Order canceled but QB SO sigue abierto | subscriber corrió pero QBWC no procesó el close | Ver nightly verify job resultado |

### 5. Forzar re-sync manual

Si el subscriber falló, puedes disparar la operación manualmente desde el Admin:
- **Re-sync Sales Order:** botón en el QB widget en la página de la orden (`POST /admin/quickbooks/order`)
- **Re-sync Estimate:** botón "Save to QB" en el sidebar de draft orders (`POST /admin/quickbooks/draft-order`)

---

## Nightly Verification Job

**Archivo:** `backend/src/jobs/quickbooks-nightly-verify.ts`

Job que corre a medianoche EST. Verifica que todas las operaciones QB de las últimas 24h que se marcaron como `completed` realmente se completaron en QB Desktop (cierra el gap del "optimistic complete").

- Consulta `qb_sync_log` por entradas con `qb_operation_id`
- Para cada una: `GET /api/sync/status/{operationId}` en el bridge
- Retroactivamente marca como `failed` si el bridge dice que falló
- Envía email resumen a `QB_REPORT_EMAIL` (default: `a.vargas@ecopowertech.com`)

Ver detalles completos en `DRAFT_ORDER_ADVANCED_UI.md` → sección 14 → "Nightly Verification Job".

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `QB_ORDER_FLOW_ENABLED` | `false` | Master switch para todos los subscribers QB |
| `QB_BRIDGE_URL` | `https://qb.eptbridge.com` | URL del QB Bridge API |
| `QB_API_KEY` | — | API key del bridge |
| `QB_SHIPPING_ITEM_ID` | `800006A3-1395258131` | QB ListID del shipping item |
| `QB_DEFAULT_SALES_TAX_CODE` | `Sale Tax 7%` | QB tax code para órdenes con impuesto |
| `QB_REPORT_EMAIL` | `a.vargas@ecopowertech.com` | Recipient del nightly report |
| `DATABASE_URL` | — | PostgreSQL connection (para `qb_sync_log`) |

---

## Known Issues & Fixes

| Issue | Root Cause | Fix | Status |
|-------|-----------|-----|--------|
| `draft_order.created` never fires | Medusa v2 no emite el evento nativo | `handleDraftOrderCreated` se invoca via cron + endpoint manual | ✅ Documented |
| POS Sales Receipt duplica SO | Cron crea SO mientras SR aún se procesa (in-flight SR) | Check `hasPendingInvoiceOp()` en cron antes de SO | ✅ Fixed Mar 2026 |
| Cancel no dispara → SO queda abierto | `emit-order-events.ts` usaba `{ order_id }` pero el hook recibe `{ order }` | Ahora usa `order?.id` | ✅ Fixed |
| Duplicate Sales Orders | `convert-force` llamaba `/admin/quickbooks/order` explícitamente Y el subscriber también disparaba | Removidas todas las llamadas explícitas — subscriber es el único trigger | ✅ Fixed |
| Web order price ×100 en QB | Subscriber usaba `items.unit_price` (cents de order_item) y multiplicaba ×100 | Ahora usa `items.item.unit_price` de order_line_item | ✅ Fixed |
| Cancel Activity Log sin QB Ref # | `QbSyncLogger.complete()` no recibía `qbRefNumber` | Ahora lee `qb_sales_order_ref` / `qb_invoice_ref` y lo pasa | ✅ Fixed |
| `completed` en log pero SO abierto en QB | Optimistic complete: log marca completed cuando el close se *encola*, no cuando QBWC lo ejecuta | Nightly verify job confirma el estado real | ✅ Mitigated |
| Subscriber no recibe eventos en dev | Redis event bus es asíncrono/unreliable en dev | `emit-order-events.ts` re-emite sincrónicamente desde workflow hooks | ✅ Fixed |
| QB Error 3175 (locked transaction) | QB Desktop tiene el documento abierto | Cerrar en QB Desktop, luego re-sync | ⚠️ Operational |
| **Discount/Subtotal faltaban en SO** | Lógica antigua solo aplicaba descuento en órdenes con promo de tipo "order-level" | Ahora TODOS los descuentos (cualquier tipo) generan líneas Subtotal + Discount | ✅ Fixed |
| **QB Error 3060 en Subtotal/Discount líneas** | Se enviaba `<Quantity>1</Quantity>` que QB rechaza para estos item types | `buildQbOrderDiscountLines` ahora omite quantity completamente | ✅ Fixed |
| **QB Error 3170 — Amount must be positive** | Manual resync route: unit_price del Admin API (dólares) no se multiplicaba ×100 → price=0.2225 → Amount=0.89, discount ($4.45) > total → negativo | Route ahora multiplica unit_price ×100 igual que el subscriber | ✅ Fixed |
| **Discount Amount vacío en QB** | Manual route pasaba discount_total en dólares (4.45) directo a `buildQbOrderDiscountLines` que esperaba cents → dividía 4.45/100=0.044 | Route ahora multiplica ×100 antes de llamar la función | ✅ Fixed |
| **Shipping incluido en descuento** | Shipping se agregaba antes des las líneas Subtotal+Discount → QB lo sumaba en el Subtotal | Shipping ahora siempre va como ÚLTIMA línea (después de Subtotal y Discount) | ✅ Fixed |
| Sales Receipt sin SO existente causa error | Handler intenta crear SR pero no valida si SO ya existe | Sales Receipt Qualification Guard ahora verifica SO + Estimate existentes | ✅ Fixed Mar 2026 |
