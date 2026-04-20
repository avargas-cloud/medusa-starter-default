# QuickBooks Integration — Bible
> **Tipo**: Technical Reference
> **Repo**: backend + bridge externo (Node.js en Windows)
> **Ultima verificacion**: 2026-04-20 (bridge DTD fix + orphan rescue)
> **Estado**: Current

> **Ver tambien**:
> - [QB_PAYMENT_METHOD.md](./QB_PAYMENT_METHOD.md) — rule + resolver para el `PaymentMethodRef` de cada ReceivePayment / SalesReceipt.
> - [QB_MASS_METADATA_SYNC.md](./QB_MASS_METADATA_SYNC.md) — bulk sync de metadata de items (income/cogs/vendor/cost/mpn/edit_sequence) con dry-run, apply y rollback.

---

## Que es y por que existe

El **QB Bridge** es un servicio Node.js que corre localmente en el servidor Windows de la empresa y actua como proxy entre Medusa v2 (en Railway) y QuickBooks Desktop Enterprise. Medusa no tiene conector nativo para QB Desktop; el bridge resuelve esto exponiendo una REST API que internamente usa QBXML via QB Web Connector (QBWC).

---

## Arquitectura

```
Medusa Backend (Railway)
    |
    +-- HTTP REST --> QB Bridge (qb.eptbridge.com)
    |                    |
    |                Node.js en Windows (PM2)
    |                    |
    |                SQLite FIFO Queue (operations table)
    |                    |
    |                QB Web Connector (QBWC) -- Long-polling cada ~60s
    |                    |
    |                QuickBooks Desktop Enterprise 2012
    |                    +-- QBXML SDK --> .QBW file
    |
    +-- qb_order_pipeline (PostgreSQL) -- tracking de operaciones
    +-- qb_sync_log (PostgreSQL) -- log de sync jobs
    +-- qb_edit_sequence_cache (PostgreSQL) -- cache de EditSequence + TxnLineIDs
```

**Protocolo:** QBXML v10.0
**Bridge URL:** `https://qb.eptbridge.com` (env var `QB_BRIDGE_URL`)
**Auth:** header `x-api-key` (env var `QB_API_KEY`)

---

## Kill Switch y Feature Flags

| Variable | Efecto |
|----------|--------|
| `QB_INTEGRATION=false` | Desactiva todo inmediatamente (override de emergencia, no requiere DB) |
| `QB_INTEGRATION=true` | Fuerza habilitado (override de emergencia) |
| `QB_ORDER_FLOW_ENABLED=true` | Activa el flujo de orden -> QB (subscribers + handlers) |
| `QB_DRY_RUN=true` | Simula sin escribir a QB |

El flag `QB_INTEGRATION` tiene prioridad sobre la BD. Si no esta seteado, se lee `quickbooks_config.integration_enabled` de PostgreSQL. El valor se cachea 30 segundos en memoria. Cambiarlo via `POST /admin/quickbooks/config` invalida el cache inmediatamente.

---

## Patron Asincrono (Fire-and-Poll)

**Todos** los writes al bridge son asincronos:

```
1. POST /api/...  --> { operationId } inmediato
2. QBWC procesa en el siguiente ciclo (~60s)
3. GET /api/sync/status/:operationId --> { status, txnId, refNumber, editSequence }
```

**Polling en Medusa:** El cron `qb-pipeline-consolidator` (cada 1 min) encuesta el bridge y actualiza `qb_order_pipeline`. No hacer polling manual desde los handlers.

**Statuses de operacion en el bridge:** `pending` | `processing` | `completed` | `failed`

**Critico:** Siempre esperar `txnId` (confirmado en QB Desktop) antes de encadenar operaciones. Por ejemplo, crear un Invoice vinculado a un Sales Order requiere el `txnId` del SO.

---

## Parametros de Polling

```typescript
POLL_INTERVAL_MS = 20_000  // 20 segundos entre intentos
MAX_POLL_ATTEMPTS = 20     // max 20 intentos = ~6.7 minutos total
```

Si el polling agota los intentos sin respuesta, la operacion queda sin `txnId` y el cron de recovery (`qb-operation-recovery`, cada 5 min) la recoge.

---

## Pipeline — qb_order_pipeline

### Columnas

| Columna | Tipo | Descripcion |
|---------|------|-------------|
| `id` | uuid | PK |
| `order_id` | text | ID del draft order o sales order de Medusa |
| `reference_id` | text | ID de referencia (invoice, payment, credit_memo, etc.) |
| `reference_type` | text | Tipo de entidad referenciada |
| `step` | text | Ver `PipelineStep` abajo |
| `depends_on` | uuid | FK a fila padre (cadenas de dependencia) |
| `status` | text | Ver `PipelineStatus` abajo |
| `bridge_op_id` | text | operationId retornado por el bridge |
| `retry_count` | int | Intentos de retry (auto-incrementa en failed) |
| `qb_txn_id` | text | TxnID asignado por QB Desktop (solo conocido tras confirmacion) |
| `qb_ref_number` | text | Numero de referencia QB (ej. "E18024677") |
| `medusa_ref_number` | text | Numero Medusa (ej. "E1271", "INV-20001") — conocido desde creacion |
| `qb_result` | jsonb | Payload raw del bridge en confirmacion |
| `payload` | jsonb | Payload usado para crear la operacion |
| `error` | text | Mensaje de error si fallo |
| `created_at` | timestamp | |
| `submitted_at` | timestamp | Cuando se envio al bridge |
| `confirmed_at` | timestamp | Cuando QB confirmo |
| `failed_at` | timestamp | Cuando fallo |
| `updated_at` | timestamp | |
| `seq` | int | Auto-increment para ordenar |

### PipelineStep

```typescript
type PipelineStep =
    | "estimate"             // Draft order → QB Estimate
    | "sales_order"          // Order → QB Sales Order
    | "sales_receipt"        // Order pagado directo → QB Sales Receipt
    | "invoice"              // Fulfillment → QB Invoice
    | "payment"              // POS payment → QB Receive Payment
    | "apply_payment"        // Aplicar pago a Invoice
    | "credit_memo"          // Return → QB Credit Memo
    | "write_check"          // Refund → QB Write Check
    | "refund_payment"       // Refund payment
    | "void_estimate"        // Anular Estimate
    | "void_invoice"         // Anular Invoice
    | "void_sales_receipt"   // Anular Sales Receipt
    | "invoice_tax_updated"  // Correccion manual de tax en QB Invoice via updateInvoiceInQb
    | "void_sales_order"     // Anular Sales Order
    | "void_credit_memo"     // Anular Credit Memo
    | "void_check"           // Anular Check
    | "payment_method_change"// Cambio de metodo de pago
    | "transfer_customer"    // Transferir customer en QB
    | "so_close"             // Cerrar SO manualmente
    | "so_reopen"            // Reabrir SO
    | "close_estimate"       // Cerrar/inactivar Estimate en QB
```

### PipelineStatus

```typescript
type PipelineStatus =
    | "waiting"    // POS: en espera de 1 hora antes de enviarse al cron
    | "pending"    // En cola, proximo a enviarse al bridge
    | "submitted"  // Enviado al bridge, esperando QBWC confirmation
    | "confirmed"  // QB Desktop proceso y confirmo (tiene qb_txn_id)
    | "failed"     // Fallo — ver columna error
    | "skipped"    // Excluido intencionalmente
    | "manual"     // qb_skip=true — orden excluida del auto-sync
```

### Estrategia de Upsert en writePipelineRow

`writePipelineRow()` no hace INSERT ciego — usa una estrategia de upsert inteligente para que la fila visible en el UI se actualice in-place sin desaparecer ni duplicarse:

| Status escrito | Logica |
|---|---|
| `waiting` | UPDATE fila existente en `waiting` (misma orden/step); si no existe, INSERT |
| `pending` | Intenta UPDATE de `waiting` → `pending` en-place; si no hay waiting, intenta reset de `submitted/confirmed/failed/skipped` → `pending` (para MODs y retries); si nada, INSERT |
| cualquier otro | UPDATE fila en `pending` o `submitted` en-place (previene duplicados cuando consolidator y handler confirman a la vez) |

Esto garantiza que el flujo siempre sea: `waiting → pending → submitted → confirmed/failed` sin crear filas huerfanas.

---

## EditSequence Cache — qb_edit_sequence_cache

QB requiere un `EditSequence` actualizado para cualquier operacion Mod (update). Para evitar un GET extra antes de cada Mod:

| Columna | Tipo | Descripcion |
|---------|------|-------------|
| `entity_type` | text | "estimate", "sales_order", "invoice", etc. |
| `qb_id` | text | TxnID de QB |
| `edit_seq` | text | EditSequence actual |
| `cached_at` | timestamp | Cuando se cacheo |
| `line_ids` | jsonb | Map productId → TxnLineID (para EstimateMod/SOMod precisos) |

**Flujo:**
1. Despues de cada Add o Mod confirmada, el consolidator cachea `EditSequence` + `line_ids`
2. Antes de un Mod, `updateEstimateInQb`, `updateSalesOrderInQb` y `updateInvoiceInQb` consultan el cache
3. Si hay cache hit → saltan el GET round-trip al bridge
4. Si hay error 3210 (EditSequence stale) → invalidar con `invalidateEditSequence(entityType, qbId)`

**Cobertura actual (completa):** Los tres tipos de documento QB que admiten Mod cachean EditSequence en creacion Y despues de cada Mod:
- `ReceivePayment` — cacheado via consolidator al confirmar `payment` pipeline step
- `Invoice` — cacheado via consolidator al confirmar `invoice` pipeline step; tambien tras `updateInvoiceInQb`
- `Sales Receipt` — cacheado via consolidator al confirmar `sales_receipt` pipeline step

---

## withQbLock — Cola de Saves Consecutivos

**Archivo:** `src/lib/quickbooks/qb-locks.ts`

Previene conflictos de EditSequence cuando llegan dos saves del mismo estimado antes de que el bridge confirme el primero.

```typescript
withQbLock(orderId, async () => {
    // fetch EditSequence, submit al bridge, escribir pipeline row
    // si este save espera al anterior, el cache ya tendra el EditSequence fresco
})
```

**Comportamiento:**
- Retorna `void` — no se puede `await` desde afuera
- Internamente encadena promesas via `Map<string, Promise<void>>`
- Save 2 espera en cola hasta que Save 1 sea confirmado (via `pollUntilQbConfirmed`)
- El lock se libera automaticamente cuando `fn()` termina (exito o error)
- Fire-and-forget seguro: los errores internos estan contenidos dentro de `fn()`

**pollUntilQbConfirmed:**
```typescript
// Bloquea dentro del lock hasta que el consolidator confirme la fila
const outcome = await pollUntilQbConfirmed(rowId)
// outcome: "confirmed" | "failed" | "skipped" | "timeout"
// Default timeout: 5 minutos, intervalo: 3 segundos
```

---

## Cron Jobs

### 1. qb-pipeline-consolidator
**Archivo:** `src/jobs/qb-pipeline-consolidator.ts`
**Schedule:** `*/1 * * * *` (cada 1 minuto)

- Encuesta el bridge por filas en `submitted`
- Si confirmed → marca `confirmed`, cachea EditSequence + line_ids
- Si failed → marca `failed`, registra error
- Pases de recovery:
  - Filas `waiting` con fila padre confirmada → las activa a `pending`
  - Filas `pending` con >20 min sin cambio → marca `failed` (timeout)

### 2. qb-operation-recovery
**Archivo:** `src/jobs/qb-operation-recovery.ts`
**Schedule:** `*/5 * * * *` (cada 5 minutos)

- Recupera operaciones del bridge atascadas en `processing` tras reinicios del servidor
- Busca: `status='processing'` + `qb_operation_id IS NOT NULL` + 3min < iniciado < 24h

### 3. qb-pos-sync
**Archivo:** `src/jobs/qb-pos-sync.ts`
**Schedule:** `*/30 * * * *` (cada 30 minutos)

- Crea Estimates/SO diferidos para ordenes POS con 1h-24h de antiguedad
- Auto-retry de filas de pago fallidas (max 3 intentos)

---

## Subscribers (Event-Driven)

### qb-draft-order-subscriber.ts
| Evento | Handler |
|--------|---------|
| `draft_order.created` | `handleDraftOrderCreated` |

**Logica especial:** Si el draft order es POS (`pos_created=true` o mismo `sales_channel_id`), **no** lo procesa inmediatamente — escribe fila `waiting` en el pipeline y deja que el cron `qb-pos-sync` lo procese 1 hora despues.

### qb-order-subscriber.ts
| Evento | Handler |
|--------|---------|
| `order.placed` | `handleOrderPlaced` |
| `order.payment_captured` | `handlePaymentCaptured` |
| `order.fulfillment_created` | `handleFulfillmentCreated` |
| `order.canceled` | `handleOrderCanceled` |
| `pos.invoice.created` | (routing interno) |
| `pos.invoice.voided` | `handleInvoiceVoided` |
| `order.customer_transferred` | `handleCustomerTransferred` |

### qb-metadata-init-subscriber.ts
| Evento | Handler |
|--------|---------|
| `order.updated` | Inicializa estructura de metadata QB si no existe |

### qb-payment-subscriber.ts
| Evento | Handler |
|--------|---------|
| `pos.payment.unapplied` | `handlePosPaymentUnapplied` |

> **IMPORTANTE:** Los eventos `pos.payment.created` y `pos.payment.applied` **NO** son manejados por subscribers. Se ejecutan directamente en los API routes (`/admin/finance/payments/route.ts` y `/admin/invoices/route.ts`) via `setTimeout` para prevenir drops del outbox de Medusa.

---

## API Routes de Sync Manual

### POST /admin/pos/sync

Sync manual desde el POS. Body: `{ type, id, action? }`

#### type: "estimate"
- `action: "sync"` → Si ya tiene `qb_txn_id`: EstimateMod en background (via `withQbLock`). Si no: crea Estimate nuevo via `handleDraftOrderCreated(isCron=true)`.
- `action: "void"` → Cierra/inactiva el Estimate en QB.
- Guard: bloquea si `qb_sync_status` esta en `creating/editing/pending`.
- Usa `getEstimateTxnId(metadata)` — nunca lee `metadata.qb_txn_id` directamente.

#### type: "order"
- `action: "sync"` → Si ya tiene SO (`getSoTxnId`): SaleOrderMod. Si no: crea SO.
- `action: "void"` → Cierra SO via `handleOrderCanceled`.
- Guard: bloquea si la orden ya tiene facturas emitidas.

#### type: "invoice"
- Si tiene SO → `handleFulfillmentCreated` → crea InvoiceAdd vinculado al SO.
- Si no tiene SO → `handleSalesReceiptCreated` → crea SalesReceipt.
- Si ya en QB → cachea EditSequence en background.

#### type: "payment"
- Si ya tiene `qb_txn_id`: cachea EditSequence en background.
- Si no: ejecuta secuencia `handlePosPaymentCreated` → `handlePosPaymentApplied`.

---

### POST /admin/invoices/:id/update-tax

Correccion manual del codigo de tax en un QB Invoice existente.

**Body:** `{ taxMode: 'florida' | 'exempt' }`

**Restriccion:** Solo aplica a Invoice de tipo "Invoice" en QB. Si el invoice de Medusa fue sincronizado como Sales Receipt, se rechaza con `422 SALES_RECEIPT_TAX_LOCKED` (los Sales Receipt embeben el pago y no admiten Mod de tax desde este endpoint).

**Flujo QB (updateInvoiceInQb):**
1. Consulta `qb_edit_sequence_cache` para el `invoice` TxnID. Si hay cache hit, usa ese `EditSequence` directamente (sin round-trip al bridge).
2. Si no hay cache → hace GET al bridge para obtener el `EditSequence` fresco.
3. Envia `PUT /api/invoices/:txnId` al bridge con:
   - `florida` → `salesTaxCode: qbConfig.defaultSalesTaxCode` (ej. `"Sale Tax 7%"`)
   - `exempt` → `taxExempt: true`
4. La operacion es **fire-and-forget**: el log se escribe de inmediato en `QbSyncLogger` para visibilidad en el UI, y el MOD de QB corre en background.

**Tracking en QbSyncLogger:**
- `operation: "invoice"`
- `eventType: "invoice.tax_updated"`
- `triggeredBy: "manual"`

#### type: "return"
- Solo si `payment.type === "refund"`.
- Si ya tiene `qb_txn_id`: cachea EditSequence.
- Si no: crea Write Check en QB.

---

### POST /admin/draft-orders/sync-pos

Endpoint principal del POS para crear/editar estimados.

**action: "create"**
1. Auto-resuelve region
2. Crea draft order en Medusa
3. Agrega items (en loop — items nuevos SIEMPRE van al final del array)
4. Agrega shipping
5. Aplica promociones/descuentos
6. Escribe fila `waiting` en pipeline (Medusa no emite `draft_order.created` para POS)

**action: "update"**
1. Detecta cambio de customer (transfiere si cambio)
2. Actualiza metadata del wrapper
3. Elimina items removidos
4. Actualiza items existentes (solo si cambiaron) / agrega items nuevos al final
5. Sincroniza shipping
6. Sincroniza promociones
7. **QB Sync (si `QB_ORDER_FLOW_ENABLED=true` y el estimado ya tiene `qb_txn_id`):**
   - Lee TxnID con `getEstimateTxnId(metadata)` — nunca `metadata.qb_txn_id`
   - Escribe fila `pending` en pipeline
   - Llama `withQbLock(orderId, fn)` para serializar saves consecutivos
   - Dentro del lock: construye `qbItems` con `buildQbItems()`, llama `updateEstimateInQb()`
   - Si exito: escribe `submitted`, luego `pollUntilQbConfirmed()` (max 5 min)
   - Si timeout: log warn, libera lock (el consolidator eventualmente confirma)
   - Si fallo: escribe `failed`

---

### POST /admin/orders/:id/post-edit-sync

Reconciliacion post-edicion para Sales Orders confirmadas (no draft).

- Aplica descuentos, corrige payment collection
- Inyecta tax lines
- Hard-wipe de datos stale (adjustments, order_change, order_item versiones viejas)
- Reconcilia discount_total en order_summary
- Actualiza allocations de inventario
- Sincroniza Meilisearch (incremental por variant)
- **QB Sync:** Si tiene SO (`getSoTxnId`) o Estimate (`getEstimateTxnId`), envia Mod en background. Escribe `pending` → `submitted` → `confirmed/failed` en pipeline.
- Body acepta `skip_qb: true` para saltarse el QB sync cuando no hubo cambios reales.

---

## Metadata Schema en Ordenes

Los datos QB se guardan en `order.metadata`. Hay dos shapes: el nuevo (nested) y el legacy (flat). **Siempre leer via helpers**, nunca con acceso directo al campo flat.

### Shape nuevo (nested)
```typescript
{
    qb_estimate: {
        txn_id: string,
        ref_number: string,
        operation_id: string | null,
        edit_sequence: string | null,
        synced_at: string  // ISO 8601
    },
    qb_sales_order: { txn_id, ref_number, operation_id, edit_sequence, synced_at },
    qb_invoices: Array<{ txn_id, ref_number, operation_id, edit_sequence, fulfillment_id, invoice_id?, synced_at }>,
    qb_payments: Array<{ txn_id, ref_number, operation_id, edit_sequence, amount (cents), method, synced_at }>,
    qb_sync_status: QbSyncStatus,
    qb_list_id: string | null,    // QB Customer ListID
    qb_synced_at: string | null
}
```

### Shape legacy (flat — ordenes viejas)
```
qb_estimate_txn_id, qb_estimate_ref,
qb_sales_order_txn_id, qb_sales_order_ref,
qb_invoice_txn_id, qb_payment_txn_id, ...
```

### Helpers de lectura (src/lib/quickbooks/qb-metadata-types.ts)

| Funcion | Lee |
|---------|-----|
| `getEstimateTxnId(meta)` | `qb_estimate.txn_id` o `qb_estimate_txn_id` |
| `getEstimateRef(meta)` | `qb_estimate.ref_number` o `qb_estimate_ref` |
| `getSoTxnId(meta)` | `qb_sales_order.txn_id` o `qb_sales_order_txn_id` |
| `getSoRef(meta)` | `qb_sales_order.ref_number` o `qb_sales_order_ref` |
| `getSoOperationId(meta)` | `qb_sales_order.operation_id` |
| `getLatestInvoiceTxnId(meta)` | Ultimo entry de `qb_invoices[]` o `qb_invoice_txn_id` |
| `getLatestInvoiceRef(meta)` | Ultimo entry de `qb_invoices[]` o `qb_invoice_ref` |
| `getLatestPaymentTxnId(meta)` | Ultimo entry de `qb_payments[]` o `qb_payment_txn_id` |

### Builders de patch
```typescript
buildEstimatePatch(existingMeta, { txnId, refNumber, operationId, editSequence?, syncStatus? })
buildSaleOrderPatch(existingMeta, { txnId, refNumber, operationId, editSequence?, customerId?, syncStatus? })
buildInvoicePatch(existingMeta, { txnId, refNumber, operationId, editSequence?, fulfillmentId?, invoiceId? })
buildPaymentPatch(existingMeta, { txnId, refNumber, operationId, editSequence?, amount, method })
```

### QbSyncStatus
```typescript
type QbSyncStatus =
    | "creating" | "editing" | "voiding"
    | "synced" | "child_synced" | "voided" | "error" | "pending"
    | "direct_invoice"      // pagado inmediatamente sin SO
    | "sales_order"         // SO creado por cron/subscriber
    | "estimate_conversion" // vino de un Draft Order estimate
    | null                  // no sincronizado aun
```

---

## Modulos del Client

**Ubicacion:** `src/lib/quickbooks/client/`

| Archivo | Exporta |
|---------|---------|
| `core.ts` | `bridgeFetch`, `pollOperationResult`, `pollRawOperationResult`, `checkBridgeHealth`, `getCustomerEditSequence` |
| `customers.ts` | `createCustomerInQb`, `updateCustomerInQb` |
| `estimates.ts` | `createEstimateInQb`, `updateEstimateInQb`, `deactivateEstimateInQb`, `cancelEstimateInQb` |
| `sales-orders.ts` | `createSalesOrderInQb`, `updateSalesOrderInQb`, `getSalesOrderDetailsFromQb`, `closeSalesOrderInQb`, `reopenSalesOrderInQb`, `convertEstimateToSalesOrder` |
| `invoices.ts` | `createInvoiceInQb`, `updateInvoiceInQb`, `applyPaymentToInvoiceInQb` |
| `payments.ts` | `receivePaymentInQb` |
| `sales-receipts.ts` | `createSalesReceiptInQb` |
| `credit-memos.ts` | `createCreditMemoInQb`, `voidCreditMemoInQb` |
| `checks.ts` | `writeCheckInQb` |
| `refunds.ts` | `createRefundPaymentInQb` |
| `transfer.ts` | Logica de transferencia de customer |
| `inventory.ts` | Sync de inventario |
| `types.ts` | Tipos compartidos del cliente |

`src/lib/quickbooks/qb-bridge-client.ts` re-exporta todo de `client/index.ts` (backward-compat).

### Diferencias entre deactivateEstimateInQb y cancelEstimateInQb

| Funcion | QB Operation | Efecto |
|---------|-------------|--------|
| `deactivateEstimateInQb` | EstimateMod con `IsActive=false` | Inactiva el estimate (oculto en QB) |
| `cancelEstimateInQb` | EstimateMod con lineas en cero + DELETE endpoint | Zeroes todas las lineas (anulacion contable) |

---

## order-flow-core.ts — Orquestacion

**Archivo:** `src/lib/quickbooks/order-flow-core.ts`

Funciones principales:

| Funcion | Descripcion |
|---------|-------------|
| `buildQbItems(items, metadata?)` | Transforma line items de Medusa a formato QB. Filtra items sin `variant.metadata.quickbooks_id`. Items nuevos (sin TxnLineID) van al final del array para evitar error en EstimateMod. |
| `buildQbOrderDiscountLines(total, pct?)` | Genera lineas de descuento QB |
| `buildShippingQbItem(shippingMethods, overrideId?)` | Genera linea de shipping QB |
| `ensureCustomerInQb(customer, module, log)` | Verifica/crea customer en QB |
| `processEstimateInQb(opts)` | Orquesta creacion de Estimate (Add + poll + metadata) |
| `processOrderInQb(...)` | Orquesta creacion de Sales Order |
| `processPaymentCaptureInQb(...)` | Orquesta captura de pago |
| `processInvoiceInQb(...)` | Orquesta creacion de Invoice |
| `processSalesReceiptInQb(...)` | Orquesta creacion de Sales Receipt |

**Tipo MedusaOrderForQb:** Interface local usada por `buildQbItems`. Los items tienen `unit_price` en centavos (Medusa v2). Castear desde query.graph con `as unknown as MedusaOrderForQb`.

---

## Instalacion del Bridge (Windows Server)

### Prerequisitos
- Windows Server 2008+ con QuickBooks Desktop Enterprise instalado
- Node.js v18 LTS
- Git for Windows

### Instalacion
```powershell
cd C:\Projects
git clone https://github.com/avargas-cloud/quickbooks-bridge.git
cd quickbooks-bridge
npm install
npm run build
copy .env.example .env
```

### Produccion con PM2
```powershell
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

### Restart limpio
```powershell
.\clean-restart.bat   # Para el bridge, hace git pull, limpia EADDRINUSE, reinicia
```

### QB Web Connector
- Debe tener `Every_N_Minutes = 1` y "Auto-Run" activado
- Primera vez: QB muestra ventana de certificado → seleccionar "Yes, always allow access even if QuickBooks is not running"

### Deploy de cambios al bridge
1. Push al repo del bridge en GitHub
2. **Pedir al usuario** que haga `git pull` en el servidor Windows y reinicie
3. El servidor bridge **no** tiene CI/CD automatico

---

## Configuracion DB (quickbooks_config)

| Campo | Descripcion |
|-------|-------------|
| `integration_enabled` | Kill switch global |
| `inventory_interval_minutes` | Frecuencia de sync de inventario |
| `price_interval_minutes` | Frecuencia de sync de precios |
| `customer_interval_minutes` | Frecuencia de sync de clientes |
| `price_sync_hour` | Hora del dia para price sync (modo daily) |
| `price_sync_timezone` | Timezone para price sync (ej. `America/New_York`) |
| `shipping_item_id` | QB ListID del item de shipping |
| `default_sales_tax_code` | Codigo de tax QB por defecto |
| `store_hours_*` | Configuracion de horario de tienda |
| `*_respect_hours` | Si el sync respeta el horario de tienda |

---

## Archivos Clave

| Tipo | Ruta | Proposito |
|------|------|-----------|
| Config | `src/lib/quickbooks/qb-config.ts` | Lee config del DB |
| Guard | `src/lib/quickbooks/qb-integration-guard.ts` | Kill switch con cache 30s |
| Pipeline | `src/lib/quickbooks/qb-pipeline.ts` | CRUD de qb_order_pipeline + qb_edit_sequence_cache |
| Locks | `src/lib/quickbooks/qb-locks.ts` | withQbLock — serializa saves consecutivos por orden |
| Logger | `src/lib/quickbooks/qb-sync-logger.ts` | qb_sync_log CRUD |
| Metadata | `src/lib/quickbooks/qb-metadata-types.ts` | Tipos + builders + helpers de lectura |
| Core flow | `src/lib/quickbooks/order-flow-core.ts` | Orquestacion + buildQbItems |
| Bridge client | `src/lib/quickbooks/client/core.ts` | HTTP client + polling al bridge |
| Sync jobs | `src/lib/quickbooks/sync-jobs.ts` | In-memory job tracker para syncs de inventario/precios |

---

## Fixes Recientes (2026-04)

Cambios significativos implementados que alteran el comportamiento previo:

1. **Bug: EstimateMod no se ejecutaba en save/edit (sync-pos)**
   `metadata.qb_txn_id` no existe — el TxnID esta en `metadata.qb_estimate.txn_id`. El bloque de update siempre evaluaba `undefined` y no ejecutaba el Mod. Corregido usando `getEstimateTxnId(metadata)`.

2. **Bug: updateEstimateInQb recibia objeto Medusa crudo**
   Se le pasaba `fullOrder` directamente. La funcion espera `QbUpdateEstimatePayload { txnId, items, memo }`. Corregido construyendo el payload con `buildQbItems()`.

3. **Bug: Items nuevos en EstimateMod causaban error**
   Los items sin `TxnLineID` existente deben ir al final del array en el payload del Mod, no interpolados entre items existentes. `buildQbItems` ahora los ordena correctamente.

4. **Bug: writePipelineRow creaba filas duplicadas**
   Si una fila existia en `submitted`, un save posterior insertaba una fila nueva en vez de reutilizarla. El upsert ahora matchea `submitted` para reactivar → `pending` (y conserva `qb_txn_id` para el Mod).

5. **Feature: Cola de saves consecutivos (withQbLock)**
   Si Save 2 llega mientras Save 1 aun esta `submitted`, Save 2 espera en cola. Cuando Save 1 se confirma, el cache tiene el EditSequence fresco y Save 2 lo usa sin hacer GET al bridge.

6. **Feature: EstimateMod ahora consulta EditSequence cache**
   Antes el Mod siempre hacia GET al bridge para obtener el EditSequence. Ahora verifica `qb_edit_sequence_cache` primero y salta el round-trip si hay cache hit.

7. **Feature: void_sales_receipt — comportamiento completo del pago**
   Cuando se anula un Sales Receipt en QB, el QB ReceivePayment embebido en el SR queda implicitamente desaplicado (el SR se vuelve cero). Para evitar perder el credito del cliente en el AR ledger de QB, el flujo hace lo siguiente:
   - El `CustomerPayment` en Medusa queda en `status: "available"` (NO se vuelve `voided`).
   - Los flags de metadata del SR se limpian: se eliminan `is_sales_receipt_payment`, `qb_source`, `qb_txn_id`; `qb_sync_status` se resetea a `"pending"`.
   - 200ms despues (fire-and-forget), se invoca `handlePosPaymentCreated` para crear un nuevo QB ReceivePayment standalone — el credito migra del SR anulado al ReceivePayment independiente.

8. **Feature: Tax correction via POST /admin/invoices/:id/update-tax**
   Nuevo endpoint para corregir el codigo de tax de un QB Invoice sin tocar la orden de Medusa. Sales Receipt invoices son bloqueados (422). Ver seccion "Tax Correction (Invoice MOD)" arriba.

9. **Bug: buildItemQuery generaba QBXML invalido (HRESULT 0x80040400)** — 2026-04-20
   `quickbooks-bridge/src/qbxml/builders/item.ts` ponia `<OwnerID>` antes de `<IncludeRetElement>`, violando el orden DTD estricto de `ItemQueryRq` (DTD requiere: filtros -> IncludeRetElement+ -> OwnerID). QB Desktop respondia con `HRESULT 0x80040400` ("QuickBooks found an error when parsing the provided XML text stream") y **todos** los `GET /api/products` (bulk o filtrados por FullName/ListID) fallaban silenciosamente. Items creados en QB durante ese periodo nunca llegaron a Medusa. Fix: mover `<OwnerID>0</OwnerID>` al final del template. `buildItemQueryActiveWithDesc` ya tenia el orden correcto — por eso `/api/products/active-with-description` seguia funcionando.

10. **Poison-op stall del bridge pipeline** — 2026-04-20
    Un solo op QBXML malformado (version no soportada -> HRESULT 0x80040423) re-encolado infinitamente stalla TODO el pipeline: QBWC saca el op malo, QB lo rechaza, bridge lo re-encola y aborta la sesion cleanly. El siguiente tick saca el mismo op, loop eterno, ops legitimos stuck en `submitted`. Sintoma: UI pipeline dice "Web Connector may not be running" aunque QBWC este OK. **Fix:** boton "Flush Bridge" en la UI del pipeline — Medusa auto-reenqueue ops legitimos con IDs frescos en ~1 min. **Antes de experimentar** con `type: "raw"` o QBXML custom, probar en bridge dev.

11. **Rescue scripts para orphan variants post-POS V2** — 2026-04-20
    El flow de POS Product Creation V2 puede dejar variants parcialmente conectadas: `metadata.quickbooks_id` set, pero sin `price_set` (-> $0 en POS) o sin `inventory_item` linkeado (-> "checking..." eterno en search). Dos scripts nuevos:
    - `src/scripts/qb_sync/core_jobs/import-qb-item-by-sku.ts` — pull individual por `QB_SKU=...`, detecta orphan con handle matching, attach via `updateProductsWorkflow` + fallback a `pricingModule.createPriceSets` + `remoteLink.create` cuando la variant no tenia `price_set` previo (el workflow descarta `prices` silenciosamente sin price_set existente).
    - `src/scripts/qb_sync/data_rescue/fix-orphan-pos-variants.ts` — escanea TODAS las variants con `metadata.quickbooks_id` y arregla las que falten price_set y/o inventory_item. Scope `QB_SKUS=...` o full-catalog.
    Ambos usan `/api/products/active-with-description` (documentado working) y traen precio, descripcion y ListID. Para obtener vendor/cost/MPN (campos que no estan en ese endpoint) usar `/api/products?FullName=...` via `buildItemQuery` (ya con DTD correcto post-fix #9).

---

## Historial de Decisiones

- **Fire-and-poll vs Fire-and-forget:** Fire-and-poll porque QB Desktop puede tardar hasta 60s en procesar. Polling directo en el handler causaba timeouts en Railway. Solucion: pipeline table + consolidator cron.
- **qb-bridge-client.ts como proxy:** La refactorizacion a `client/` separo responsabilidades. El archivo proxy mantiene backward-compat.
- **Node v12 descartado:** El servidor bridge fue migrado a Node v18.
- **Payments via API routes, no subscribers:** Los eventos `pos.payment.created/applied` se ejecutan directamente en los routes con `setTimeout` porque el outbox de Medusa dropeaba eventos de pago bajo carga.
- **withQbLock retorna void:** No se puede `await` externamente por diseno — el caller no debe bloquear esperando confirmacion de QB. El polling interno (`pollUntilQbConfirmed`) solo existe dentro del lock para garantizar que el siguiente save tenga el EditSequence correcto.
