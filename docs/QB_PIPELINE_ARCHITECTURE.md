# QB Order Pipeline — Arquitectura Completa

**Last Updated:** 2026-03-29

| Campo | Detalle |
|-------|---------|
| **Módulo** | QuickBooks Pipeline Tracking |
| **Archivos clave** | `src/lib/quickbooks/qb-pipeline.ts`, `src/jobs/qb-pipeline-consolidator.ts` |
| **Tablas DB** | `qb_order_pipeline`, `qb_edit_sequence_cache` |
| **Relacionado con** | `QB_SUBSCRIBERS_REFERENCE.md`, `POS_QUICKBOOKS.md`, `POS_ASYNC_QB_SYNC_ARCHITECTURE.md` |

---

## ¿Qué es el Pipeline?

El **QB Order Pipeline** es el sistema de tracking que registra cada operación enviada al QB Bridge y rastrea su estado hasta confirmación. Antes de este sistema, las operaciones QB eran "fire-and-forget" — si fallaban, no había forma de saber cuáles y por qué.

**Principio:** Cada vez que un handler QB envía una operación al bridge, escribe una fila en `qb_order_pipeline`. El **consolidador** (cron cada 2 min) luego confirma o marca como fallida cada fila encuestando el bridge.

---

## Tablas de Base de Datos

### `qb_order_pipeline`

Tabla principal. Un registro por cada documento QB creado (o intentado) para cada orden.

```sql
CREATE TABLE qb_order_pipeline (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        TEXT,                    -- Medusa order/draft order ID
    reference_id    TEXT,                    -- pos_invoice.id, fulfillment.id, credit_memo.id, etc.
    reference_type  TEXT,                    -- 'pos_invoice', 'fulfillment', 'credit_memo'
    step            TEXT NOT NULL,           -- Ver enum de steps abajo
    status          TEXT NOT NULL,           -- Ver enum de statuses abajo
    depends_on      UUID REFERENCES qb_order_pipeline(id),
    bridge_op_id    TEXT,                    -- operationId devuelto por el bridge
    retry_count     INTEGER DEFAULT 0,
    medusa_ref_number TEXT,                 -- e.g., INV-1234, CM-567 (for voids)
    qb_txn_id       TEXT,                    -- TxnID de QB Desktop (confirmado)
    qb_ref_number   TEXT,                    -- Número de referencia QB (e.g. "6175")
    qb_result       JSONB,                   -- Respuesta completa del bridge
    payload         JSONB,                   -- Payload enviado (para debug/retry)
    error           TEXT,                    -- Mensaje de error si falló
    submitted_at    TIMESTAMPTZ,             -- Cuando se envió al bridge
    confirmed_at    TIMESTAMPTZ,             -- Cuando QBWC confirmó
    failed_at       TIMESTAMPTZ,             -- Cuando se marcó como fallido
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
```

#### Steps válidos (Enumeración Completa)

| Step | Descripción | Handler/Trigger |
|------|-------------|-----------------|
| `estimate` | QB Estimate (cotización) | `handleDraftOrderCreated` (subscriber + cron) |
| `sales_order` | QB Sales Order | `handleOrderPlaced` (subscriber) / `qb-pos-sync` (cron) |
| `sales_receipt` | QB Sales Receipt (venta inmediata con pago) | `handleSalesReceiptCreated` (POS payment flow) |
| `invoice` | QB Invoice (factura parcial o diferida) | `handleFulfillmentCreated` (POS invoice creation) |
| `payment` | QB Receive Payment | `handlePaymentCaptured` (web) / `handlePosPaymentCreated` (POS) |
| `apply_payment` | QB aplicación de pago a Invoice | `handlePosPaymentApplied` (POS payment application) |
| `credit_memo` | QB Credit Memo (refund) | `POST /admin/pos/credit_memos/:id/complete` (POS returns) |
| `void_credit_memo` | Anulación de Credit Memo en QB | `POST /admin/pos/credit_memos/:id/void` (POS void returns) |
| `void_invoice` | Anulación de Invoice en QB | `POST /admin/invoices/:id/void` (invoice void) |
| `void_sales_receipt` | Anulación de Sales Receipt en QB | Invoice void handler / POS cancellation |
| `void_sales_order` | Anulación de Sales Order en QB | `handle-order-canceled.ts` (order cancel subscriber) |
| `write_check` | Cheque físico de reembolso (tracking manual) | `POST /admin/pos/credit_memos/:id/complete` (cash refunds) |

#### Statuses del ciclo de vida

```
pending → submitted → confirmed
                   ↘ failed
```

| Status | Significado | Lifecycle |
|--------|-------------|-----------|
| `pending` | Registrado pero no enviado al bridge todavía | Filas `write_check` — nunca se auto-procesan |
| `submitted` | Enviado al bridge, esperando que QBWC procese (`bridge_op_id` presente) | Poll by consolidator every 2 min |
| `confirmed` | QBWC procesó con éxito, `qb_txn_id` confirmado | Final success state |
| `failed` | El bridge o QBWC reportó error | Final error state — requires manual intervention |
| `skipped` | No aplica para esta orden (e.g. SR en orden que ya tiene SO) | Terminal state — no further action |

---

### `qb_edit_sequence_cache`

Cache de EditSequence de QB. Cada documento en QB Desktop tiene un `EditSequence` que se requiere para modificarlo. Al confirmarse una operación, se cachea para evitar un round-trip extra.

```sql
CREATE TABLE qb_edit_sequence_cache (
    entity_type  TEXT NOT NULL,    -- Igual al step: 'sales_order', 'invoice', etc.
    qb_id        TEXT NOT NULL,    -- TxnID del documento en QB
    edit_seq     TEXT NOT NULL,    -- EditSequence actual
    cached_at    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (entity_type, qb_id)
);
```

**Uso:** Antes de hacer un `Mod` (modificar un documento QB), el handler llama `getCachedEditSequence()`. Si hay cache, se usa directamente. Si no, el bridge hace un `Query` previo para obtenerlo (round trip extra).

---

## Módulo `qb-pipeline.ts`

**Archivo:** `src/lib/quickbooks/qb-pipeline.ts`

Módulo utilitario con todas las operaciones sobre las tablas del pipeline. Todos los handlers QB lo importan.

### API pública

```typescript
// Insertar una nueva fila en qb_order_pipeline
// Retorna el UUID de la fila insertada
writePipelineRow(input: WritePipelineRowInput): Promise<string>

// Marcar una fila 'submitted' como 'confirmed' (llamado por el consolidador)
confirmPipelineRow(
    rowId: string,
    qbTxnId: string | null,
    qbRefNumber: string | null,
    qbResult: object | null
): Promise<void>

// Marcar una fila como 'failed' (llamado por el consolidador)
failPipelineRow(rowId: string, error: string): Promise<void>

// Buscar fila submitted por bridge_op_id (legacy, ahora el consolidador itera por status)
findSubmittedRowByOpId(bridgeOpId: string): Promise<PipelineRow | null>

// Guardar/actualizar EditSequence en cache (upsert)
cacheEditSequence(entityType: string, qbId: string, editSeq: string): Promise<void>

// Leer EditSequence del cache (retorna null si no existe)
getCachedEditSequence(entityType: string, qbId: string): Promise<string | null>

// Borrar EditSequence del cache (en conflicto Error 3210)
invalidateEditSequence(entityType: string, qbId: string): Promise<void>
```

### Input de `writePipelineRow`

```typescript
interface WritePipelineRowInput {
    orderId?:       string | null   // Medusa order ID
    referenceId?:   string | null   // pos_invoice.id, fulfillment.id, credit_memo.id
    referenceType?: string | null   // 'pos_invoice' | 'fulfillment' | 'credit_memo'
    step:           PipelineStep    // Ver enum de steps
    status:         PipelineStatus  // Ver enum de statuses
    dependsOn?:     string | null   // UUID de fila padre (para secuencias)
    bridgeOpId?:    string | null   // operationId del bridge (si ya fue submitted)
    retryCount?:    number
    medusaRefNumber?: string | null // e.g., INV-1234, CM-567 (for voids)
    qbTxnId?:       string | null   // Si se confirmó síncronamente
    qbRefNumber?:   string | null
    qbResult?:      object | null
    payload?:       object | null
    error?:         string | null
}
```

### Patrón de escritura — Cómo lo usa cada handler

```typescript
// Patrón estándar en todos los handlers:
const result = await processSomethingInQb(...)

if (result.error) {
    await writePipelineRow({
        orderId,
        step:   "sales_order",
        status: "failed",
        error:  result.error,
    })
    return
}

if (result.txnId || result.operationId) {
    await writePipelineRow({
        orderId,
        step:        "sales_order",
        // operationId sin txnId = submitted (bridge async)
        // txnId presente = confirmed (bridge sync o legacy)
        status:      result.operationId && !result.txnId ? "submitted" : "confirmed",
        bridgeOpId:  result.operationId || null,
        qbTxnId:     result.txnId || null,
        qbRefNumber: result.refNumber || null,
    })
}
```

---

## Cron: `qb-pipeline-consolidator`

**Archivo:** `src/jobs/qb-pipeline-consolidator.ts`
**Schedule:** `*/2 * * * *` (cada 2 minutos)
**Log prefix:** `[QB-CONSOLIDATOR]`

### Función

Cierra el loop del patrón fire-and-poll: cuando un handler envía una operación al bridge, ésta queda en `status='submitted'`. El consolidador la encuesta periódicamente hasta que QBWC la procesa.

### Flujo

```
1. Verificar QB_ORDER_FLOW_ENABLED=true → si no, salir silenciosamente
2. SELECT top-50 filas WHERE status='submitted' AND bridge_op_id IS NOT NULL
   ORDER BY created_at ASC  (FIFO — procesa las más antiguas primero)
3. Para cada fila:
   a. GET /api/sync/status/:bridge_op_id al bridge
   b. Si op.status == 'completed':
      - Extraer txnId, refNumber del resultado
      - confirmPipelineRow(rowId, txnId, refNumber, result)
      - Si op.result tiene EditSequence → cacheEditSequence(step, txnId, editSeq)
   c. Si op.status == 'failed':
      - failPipelineRow(rowId, errMsg)
   d. Si op.status == 'pending'|'processing':
      - No hacer nada (QBWC aún procesando)
```

### Ejemplo de logs

```
[QB-CONSOLIDATOR] Polling 3 submitted operations...
[QB-CONSOLIDATOR] ✅ Confirmed row abc-123 (sales_order) — TxnID=6175, Ref=SO-6175
[QB-CONSOLIDATOR] ⏳ Row def-456 (invoice) bridge status: pending
[QB-CONSOLIDATOR] ❌ Failed row ghi-789 (estimate): QB Error 3000: Object not found
```

### Límite de 50 filas

El consolidador procesa máximo 50 filas por ejecución. Con schedule cada 2 minutos, el throughput máximo es 1500 operaciones/hora. Para el volumen de EcoPowerTech esto es más que suficiente.

---

## Cron: `qb-pos-sync`

**Archivo:** `src/jobs/qb-pos-sync.ts`
**Schedule:** `*/30 * * * *` (cada 30 minutos)

El `qb-pos-sync` también escribe al pipeline indirectamente (al llamar a los handlers que a su vez llaman `writePipelineRow`).

### Ventana temporal

Procesa órdenes y draft orders con **entre 1 hora y 24 horas** de antigüedad:

```sql
AND created_at <= NOW() - INTERVAL '1 hour'
AND created_at >= NOW() - INTERVAL '24 hours'
```

> **Gap conocido:** Órdenes con más de 24 horas sin sincronizar quedan fuera de la ventana automática. Usar el endpoint de sync manual (`POST /admin/pos/sync`) para recuperarlas.

### Guard de race condition

El cron verifica antes de crear un Sales Order que no haya una operación de SR o Invoice en-vuelo:

```typescript
const hasPendingInvoiceOp = !!(
    meta.qb_invoice_operation_id ||
    meta.qb_sales_receipt_operation_id
)

if (!soTxnId && !invTxnId && !hasPendingInvoiceOp) {
    // Crear Sales Order
}
```

**Sin este guard:** El cron podría crear un Sales Order mientras el Sales Receipt del mismo order aún está siendo procesado por QBWC — resultando en dos documentos QB para la misma venta.

---

## Handlers que escriben al pipeline

| Handler | Step | Reference | Void Support |
|---------|------|-----------|--------------|
| `handle-order-placed.ts` | `sales_order` | `orderId` | ✅ `void_sales_order` |
| `handle-fulfillment-created.ts` | `invoice` | `referenceId = invoice_id \|\| fulfillment_id` | — |
| `handle-sales-receipt-created.ts` | `sales_receipt` | `referenceId = invoice_id` | ✅ `void_sales_receipt` |
| `handle-payment-captured.ts` | `payment` | `orderId` | — |
| `handle-pos-payment-created.ts` | `payment` | `orderId` | — |
| `handleDraftOrderCreated` (subscriber) | `estimate` | `orderId` (draft order) | — |
| `POST /admin/pos/credit_memos/:id/complete` | `credit_memo` | `referenceId = cm.id`, `medusaRefNumber = CM-{id}` | ✅ `void_credit_memo` |
| `POST /admin/pos/credit_memos/:id/void` | `void_credit_memo` | `referenceId = cm.id`, `medusaRefNumber`, `qbRefNumber`, `qbTxnId` | — |
| `POST /admin/invoices/:id/void` | `void_invoice` | `referenceId = invoice_id`, `medusaRefNumber = INV-{id}` | — |
| `POST /admin/pos/sync` (manual) | varies | Based on document type and action | ✅ Auto-routing to void handlers |
| `handle-order-canceled.ts` | `void_sales_order` | `orderId`, `medusaRefNumber` | — |

---

## Void Pipeline Rows

Cuando un documento QB es anulado (voided), se escribe una nueva fila de pipeline con `step` comenzando con `void_`:

### Estructura de Void Rows

```sql
INSERT INTO qb_order_pipeline (
    order_id,               -- Medusa order ID (if applicable)
    reference_id,           -- credit_memo.id, invoice.id, etc.
    reference_type,         -- 'credit_memo', 'invoice', 'sales_receipt', 'sales_order'
    step,                   -- 'void_credit_memo', 'void_invoice', 'void_sales_receipt', 'void_sales_order'
    status,                 -- 'submitted' (fire-and-forget) or 'confirmed' (sync complete)
    medusa_ref_number,      -- CM-12345 | INV-67890 | SR-99999 | SO-55555
    qb_ref_number,          -- QB-assigned ref (e.g., "CM-3", "INV-22", "SR-88")
    qb_txn_id,              -- QB TxnID of the voided document
    payload,                -- { reason: '...' } or void metadata
    submitted_at,           -- Timestamp when void sent to QB Bridge
    confirmed_at            -- Timestamp when QBWC confirmed the void
)
```

### Void Lifecycle

**On void request (e.g., credit memo void):**
```typescript
await writePipelineRow({
    orderId: cm.order_id,
    referenceId: cm.id,
    referenceType: 'credit_memo',
    step: 'void_credit_memo',
    status: 'submitted',
    medusaRefNumber: cm.medusa_ref_number,  // e.g., CM-20070
    qbRefNumber: cm.qb_ref_number,          // e.g., CM-3
    qbTxnId: cm.qb_txn_id,                  // from metadata
    payload: { reason: 'Customer request' }
})
```

**On consolidator confirmation:**
The consolidator polls the bridge, and once `op.status === 'completed'`, it calls:
```typescript
await confirmPipelineRow(rowId, qbTxnId, qbRefNumber, qbResult)
```

This marks the void as confirmed and caches the updated `EditSequence`.

---

## Sales Receipt Qualification Guard

El handler `handleSalesReceiptCreated` tiene un guard que verifica que la orden no tenga ya un documento QB antes de crear el Sales Receipt:

```typescript
const existingSoTxnId = getSoTxnId(order.metadata)
const existingEstimateTxnId = getEstimateTxnId(order.metadata)

const hasRealSo = existingSoTxnId && existingSoTxnId !== "SKIPPED_SALES_RECEIPT"
const hasRealEstimate = !!existingEstimateTxnId

if (hasRealSo || hasRealEstimate) {
    // Fallback: crear Invoice en lugar de Sales Receipt
    await handleFulfillmentCreated(data, ...)
    return
}
```

**¿Por qué?** Si el cron de 1 hora corrió antes que el pago llegara, ya hay un Sales Order o Estimate en QB. No se puede crear un Sales Receipt sobre un SO/Estimate existente — se crea un Invoice vinculado.

**Sentinel `SKIPPED_SALES_RECEIPT`:** Cuando un Sales Receipt es creado exitosamente, el handler escribe `qb_so_txn_id = "SKIPPED_SALES_RECEIPT"` en la metadata de la orden. Esto previene que el cron `qb-pos-sync` intente crear un Sales Order para esa orden después de la ventana de 1 hora.

---

## API Admin del Pipeline

**Endpoint:** `GET /admin/quickbooks/pipeline?limit=50`

Devuelve las últimas filas del pipeline para el dashboard QB en Medusa Admin (`/app/quickbooks`).

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:9000/admin/quickbooks/pipeline?limit=50"
```

**Endpoint de sync manual:** `POST /admin/pos/sync`

Permite forzar la sincronización de cualquier documento y registra el resultado en el pipeline:

```bash
# Forzar sync de un Sales Order
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"order","id":"<order_id>"}' \
  http://localhost:9000/admin/pos/sync

# Con acción específica (inteligente void routing):
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"credit_memo","id":"<cm_id>","action":"void"}' \
  http://localhost:9000/admin/pos/sync

# Tipos válidos: "order", "estimate", "invoice", "payment", "return", "credit_memo"
# Acciones válidas: "sync" (default), "void"
```

---

## Flujo visual completo

```
POS Invoice (< 1h, full payment)
│
├─ handleSalesReceiptCreated()
│    ├─ Guard: ¿existing SO or Estimate? NO →
│    ├─ processSalesReceiptInQb() → bridge → operationId
│    ├─ writePipelineRow(step='sales_receipt', status='submitted', bridgeOpId)
│    └─ metadata: qb_so_txn_id = "SKIPPED_SALES_RECEIPT"
│
│   [2 minutos después]
│
└─ qb-pipeline-consolidator
     ├─ SELECT status='submitted' → encuentra la fila del SR
     ├─ GET /api/sync/status/:opId → op.status='completed'
     ├─ confirmPipelineRow(rowId, txnId, refNumber)
     └─ cacheEditSequence('sales_receipt', txnId, editSeq)


Web Order (order.placed)
│
├─ handleOrderPlaced()
│    ├─ processOrderInQb() → bridge → operationId
│    ├─ writePipelineRow(step='sales_order', status='submitted', bridgeOpId)
│    └─ metadata: qb_sales_order = { txn_id: null, operation_id: opId }
│
│   [2 minutos después]
│
└─ qb-pipeline-consolidator → confirmPipelineRow → pipeline confirmed


POS Draft Order / Estimate (> 1h, never confirmed)
│
├─ qb-pos-sync (every 30min, 1-24h window)
│    ├─ Query: is_draft_order=true, no qb_estimate_txn_id
│    └─ handleDraftOrderCreated(isCron=true)
│         ├─ processEstimateInQb() → bridge → operationId
│         ├─ writePipelineRow(step='estimate', status='submitted', bridgeOpId)
│         └─ metadata: qb_estimate_txn_id, qb_estimate_ref
│
│   [2 minutos después]
│
└─ qb-pipeline-consolidator → confirmPipelineRow → pipeline confirmed


Credit Memo Void
│
├─ POST /admin/pos/credit_memos/:id/void
│    ├─ Inventory reversal
│    ├─ Void finance ledger entry
│    ├─ voidCreditMemoInQb() → bridge → operationId (background)
│    ├─ writePipelineRow(step='void_credit_memo', status='submitted', medusaRefNumber, qbTxnId)
│    └─ Return response immediately (fire-and-forget)
│
│   [2 minutos después]
│
└─ qb-pipeline-consolidator → confirmPipelineRow → void confirmed
```

---

## Queries útiles

```sql
-- Estado actual del pipeline
SELECT step, status, COUNT(*) as count
FROM qb_order_pipeline
GROUP BY step, status
ORDER BY step, status;

-- Filas submitted más de 10 minutos (consolidador debería haberlas procesado)
SELECT id, step, order_id, bridge_op_id, submitted_at,
       NOW() - submitted_at AS age
FROM qb_order_pipeline
WHERE status = 'submitted'
  AND submitted_at < NOW() - INTERVAL '10 minutes'
ORDER BY submitted_at ASC;

-- Últimas fallas
SELECT id, step, order_id, error, failed_at
FROM qb_order_pipeline
WHERE status = 'failed'
ORDER BY failed_at DESC
LIMIT 20;

-- Pipeline de una orden específica
SELECT step, status, qb_txn_id, qb_ref_number, error,
       submitted_at, confirmed_at, failed_at
FROM qb_order_pipeline
WHERE order_id = '<order_id>'
ORDER BY created_at;

-- Void operations in pipeline
SELECT id, step, order_id, medusa_ref_number, qb_ref_number, qb_txn_id, status, error
FROM qb_order_pipeline
WHERE step LIKE 'void_%'
ORDER BY created_at DESC
LIMIT 20;

-- Cache de EditSequence actual
SELECT entity_type, qb_id, edit_seq, cached_at
FROM qb_edit_sequence_cache
ORDER BY cached_at DESC
LIMIT 20;
```

---

## Troubleshooting

| Síntoma | Causa | Solución |
|---------|-------|---------|
| Fila `submitted` lleva más de 10 min | Consolidador no está corriendo o bridge caído | Verificar `[QB-CONSOLIDATOR]` en logs; revisar conectividad bridge |
| Fila `failed` con "QB Error 3000" | TxnID/ListID inválido en QB Desktop | Verificar datos en QB Desktop; usar sync manual |
| Fila `failed` con "QB Error 3210" | EditSequence desactualizada | `invalidateEditSequence()` se llama automáticamente; reintentar con sync manual |
| Muchas filas `pending` | `write_check` steps creados para reembolsos manuales | Normal — son solo tracking, no se auto-procesan |
| Pipeline vacío | QB_ORDER_FLOW_ENABLED=false o tablas no creadas | Verificar env var y que las tablas existen en DB |
| Consolidador no confirma filas | Bridge devuelve status diferente de 'completed'/'failed' | Revisar status exacto en bridge: `GET /api/sync/status/:opId` |
| Void operation stuck in submitted | Void handler failed or bridge timeout | Check bridge logs; manually retry with POST /admin/pos/sync |

---

## Variables de entorno relevantes

| Variable | Descripción |
|----------|-------------|
| `QB_ORDER_FLOW_ENABLED` | `true` para activar todo el pipeline. El consolidador no corre si es `false` |
| `DATABASE_URL` | PostgreSQL — donde viven las tablas del pipeline |
| `QB_BRIDGE_URL` | URL del bridge (default: `https://qb.eptbridge.com`) |
| `QB_API_KEY` | API key del bridge |
