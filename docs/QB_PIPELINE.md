# QuickBooks Pipeline
> **Tipo**: Technical Reference
> **Repo**: backend
> **Ultima verificacion**: 2026-04-10
> **Estado**: Current

---

## Que es y por que existe

El **QB Order Pipeline** es el sistema de tracking que registra cada operacion enviada al QB Bridge y rastrea su estado hasta confirmacion. Sin el, las operaciones QB eran fire-and-forget -- si fallaban, no habia forma de saber cuales y por que.

**Principio:** Cada handler QB escribe una fila en `qb_order_pipeline`. El cron `qb-pipeline-consolidator` (cada 2 minutos) encuesta el bridge y confirma o marca como fallida cada fila. El POS usa un sistema de "waiting" (retraso de 1 hora) para operaciones que deben sincronizarse despues de que el cliente se vaya.

**Serializacion global:** Todas las operaciones de escritura a QB para un mismo documento pasan por `withQbSerialized` — un sistema de dos capas (DB + in-memory) que garantiza que saves rapidos se encolen y no compitan por el mismo EditSequence.

---

## Arquitectura

```
Evento o accion POS
    |
    +-- writePipelineRow({ step, status:'pending' })  <-- pre-flight visible en UI
    |
    +-- withQbSerialized(lockKey, { orderId, steps }, async () => {
    |       |
    |       +-- [DB check] findLatestInFlightRow(orderId, steps)
    |       |       +-- in-flight encontrado? --> pollUntilQbConfirmed() (espera max 5 min)
    |       |       +-- no in-flight?          --> continua inmediatamente
    |       |
    |       +-- [in-memory lock] withQbLock(key) --> serializa dentro del proceso
    |       |
    |       +-- Re-lee metadata (puede haber cambiado mientras esperaba)
    |       +-- POST/PUT /api/... al bridge --> { operationId }
    |       +-- writePipelineRow({ step, status:'submitted', bridgeOpId })
    |   })
    |
    v (cada 2 minutos)
    qb-pipeline-consolidator
        +-- SELECT status='submitted' LIMIT 50
        +-- GET /api/sync/status/:opId
        +-- completed --> confirmPipelineRow(txnId, refNumber, editSequence)
        |              +-- cacheEditSequence(entityType, txnId, editSeq)
        |              +-- UPDATE entity metadata (order, customer_payment, etc.)
        +-- failed    --> failPipelineRow(error)
        |              +-- invalidateEditSequenceCache() (excepto Error 3175)
        +-- stale cleanup (submitted >30min, pending >20min)
                       +-- failPipelineRow() + invalidateEditSequenceCache()
```

### Serializacion Global (withQbSerialized)

Todas las rutas que escriben a QB usan `withQbSerialized` para prevenir race conditions entre saves rapidos. El sistema tiene dos capas:

**Capa 1 — DB (autoritativa):** Consulta `qb_order_pipeline` para buscar operaciones in-flight (`submitted`, o `pending` con `bridge_op_id`). Si encuentra una, espera via `pollUntilQbConfirmed` hasta que se resuelva. Funciona entre reinicios y multiples instancias.

**Capa 2 — In-memory (fast path):** `withQbLock` serializa llamadas concurrentes dentro del mismo proceso via un Map de promesas encadenadas. Evita que dos requests en el mismo Node.js hagan la consulta DB al mismo tiempo.

**Rutas protegidas:**

| Ruta | Lock key | Steps |
|------|----------|-------|
| `draft-orders/sync-pos` | `estimate:{orderId}` | `["estimate"]` |
| `pos/sync` case estimate | `estimate:{orderId}` | `["estimate"]` |
| `pos/sync` case order | `order:{orderId}` | `["sales_order"]` |
| `pos/sync` case invoice | `invoice:{orderId}` | `["invoice", "sales_receipt"]` |
| `post-edit-sync` | `{step}:{orderId}` | `[pipelineStep]` |

**Caso critico — CREATE seguido de EDIT rapido:** Ambas operaciones comparten el mismo lock key. El EDIT espera a que el CREATE confirme. Dentro del lock, re-lee metadata para obtener el `qbTxnId` que el CREATE escribio. Si no hay txnId, va al path de CREATE; si hay, va al de EDIT.

**Pre-flight rows y deadlock prevention:** Las rutas escriben un row `pending` sin `bridge_op_id` como marcador UI antes de entrar al serializer. `findLatestInFlightRow` excluye estos rows (solo espera `submitted` o `pending` con `bridge_op_id`) para evitar deadlocks donde el serializer esperaria su propio row.

---

### Flujo especial: POS waiting (retraso 1 hora)

Para ordenes y estimados POS, el sistema espera 1 hora antes de sincronizar a QB. Esto evita crear documentos QB para ventas que podrian cancelarse inmediatamente.

```
POS Draft Order creado
    |
    +-- writePipelineRow({ step:'estimate', status:'waiting' })
                |
                v (cada 30 minutos)
        qb-pos-sync job
            +-- Busca ordenes/drafts POS con created_at ENTRE 1h y 24h
            +-- Si no hay estimate/SO en pipeline ya confirmado/enviado:
                +-- handleDraftOrderCreated() o handleOrderPlaced()
                    +-- writePipelineRow({ status:'pending' })  <-- transicion waiting->pending in-place
```

---

## Modelo de Datos

### Tabla `qb_order_pipeline`

```sql
CREATE TABLE qb_order_pipeline (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id         TEXT,          -- Medusa order/draft order ID
    reference_id     TEXT,          -- pos_invoice.id, customer_payment.id, credit_memo.id
    reference_type   TEXT,          -- 'pos_invoice' | 'fulfillment' | 'credit_memo'
    step             TEXT NOT NULL, -- ver enum de steps abajo
    status           TEXT NOT NULL, -- ver lifecycle abajo
    depends_on       UUID REFERENCES qb_order_pipeline(id),
    bridge_op_id     TEXT,          -- operationId del bridge
    retry_count      INTEGER DEFAULT 0,
    medusa_ref_number TEXT,         -- ej. INV-1234, CM-567, PAY-2016 (conocido en creacion)
    qb_txn_id        TEXT,          -- TxnID en QB Desktop (confirmado por QBWC)
    qb_ref_number    TEXT,          -- Numero de documento QB (ej. "6175", "E18024677")
    qb_result        JSONB,         -- Respuesta completa del bridge (debug)
    payload          JSONB,         -- Payload enviado (debug/retry)
    error            TEXT,
    submitted_at     TIMESTAMPTZ,
    confirmed_at     TIMESTAMPTZ,
    failed_at        TIMESTAMPTZ,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);
```

### Tabla `qb_edit_sequence_cache`

```sql
CREATE TABLE qb_edit_sequence_cache (
    entity_type  TEXT,       -- 'estimate' | 'sales_order' | 'invoice' | 'payment' | etc.
    qb_id        TEXT,       -- QB TxnID
    edit_seq     TEXT,       -- EditSequence actual
    line_ids     JSONB,      -- { productId: TxnLineID } para EstimateMod line matching
    cached_at    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (entity_type, qb_id)
);
```

**Ciclo de vida del cache:**
- **Populado por:** Consolidator al confirmar una operacion (`cacheEditSequence`)
- **Usado por:** `updateEstimateInQb`, `updateSalesOrderInQb`, `updateInvoiceInQb`, `updateSalesReceiptInQb` — evita un GET round-trip al bridge
- **Invalidado por:** Consolidator al fallar una operacion, auto-timeouts, stale cleanup

**Reglas de invalidacion:**

| Evento | ¿Invalida cache? | Razon |
|--------|:-:|-------|
| Error 3200 (EditSequence out-of-date) | **SI** | El valor cacheado es incorrecto |
| Error 3175 (transaction locked) | **NO** | QB no modifico nada, cache sigue valido |
| Timeout (bridge no responde) | **SI** | No sabemos si se ejecuto |
| Stale row cleanup (>30 min) | **SI** | Estado desconocido |
| Cualquier otro error | **SI** | Precaucion |

### Tabla `qb_sync_log`

Log persistente de todas las operaciones QB (batch syncs + order events).

```sql
-- Campos clave:
id              UUID PRIMARY KEY
operation       TEXT   -- 'sales_order' | 'estimate' | 'payment' | 'invoice' | etc.
status          TEXT   -- 'processing' | 'completed' | 'failed' | 'skipped'
order_id        TEXT
draft_order_id  TEXT
event_type      TEXT   -- 'order.placed', 'order.payment_captured', etc.
sync_type       TEXT   -- 'inventory' | 'price' | 'customer'
triggered_by    TEXT   -- 'auto' | 'manual' | 'event'
qb_txn_id       TEXT
qb_ref_number   TEXT
qb_operation_id TEXT   -- bridge operationId (para recovery si server reinicia)
message         TEXT
error           TEXT
server_host     TEXT   -- Railway service name o hostname local
initiated_at    TIMESTAMPTZ
completed_at    TIMESTAMPTZ
duration_ms     NUMERIC
metadata        JSONB
```

---

## Steps Validos (PipelineStep)

| Step | Descripcion | Disparado por |
|------|-------------|---------------|
| `estimate` | QB Estimate (draft order) | `handleDraftOrderCreated` (subscriber / cron) |
| `sales_order` | QB Sales Order | `handleOrderPlaced` (subscriber / cron) |
| `sales_receipt` | QB Sales Receipt (pago inmediato) | `handleSalesReceiptCreated` |
| `invoice` | QB Invoice (factura a credito) | `handleFulfillmentCreated` |
| `payment` | QB Receive Payment | `handlePaymentCaptured` / `handlePosPaymentCreated` |
| `apply_payment` | Aplicar pago a Invoice en QB | `handlePosPaymentApplied` |
| `credit_memo` | QB Credit Memo (devolucion) | Ruta POST credit_memos complete |
| `write_check` | Write Check de reembolso | Ruta POST credit_memos complete (cash/check) |
| `refund_payment` | Receive Payment para cerrar Write Check | Activado por consolidator despues de write_check confirmado |
| `void_invoice` | Void de Invoice QB | `handleInvoiceVoided` |
| `void_sales_receipt` | Void de Sales Receipt | Handler de cancelacion |
| `void_sales_order` | Void de Sales Order | `handle-order-canceled.ts` |
| `void_credit_memo` | Void de Credit Memo | Ruta POST credit_memos void |
| `void_check` | Void de Write Check | Handler de void |
| `payment_method_change` | Cambio de metodo de pago en QB | Handler especifico |

---

## Ciclo de Vida de Estados (PipelineStatus)

```
waiting (POS 1h delay)
    |
    v (cron qb-pos-sync activa)
pending (pre-flight visible en UI)
    |
    v (handler envia al bridge)
submitted (bridge_op_id registrado)
    |
    v (consolidator confirma)
confirmed (qb_txn_id + qb_ref_number guardados)
    |   \
    |    v (bridge reporta error)
    |   failed (error registrado, retryable)
    v
skipped (Sales Order omitido -- Invoice/SR ya existe para esta orden)
```

**Transiciones especiales:**
- `waiting -> pending`: cron `qb-pos-sync` activa la fila en-place (no INSERT)
- `confirmed/failed/skipped -> pending`: reactivacion para MOD, VOID o retry -- preserva `qb_txn_id`
- `pending -> submitted`: handler actualiza en-place (no INSERT)
- `submitted -> confirmed`: consolidator actualiza en-place

**Regla de timestamps en transiciones:**

En TODA transicion de status, se deben limpiar los timestamps de estados anteriores y setear el del nuevo estado + `updated_at = NOW()`:

| Nuevo status | Se setea | Se limpia (NULL) |
|-------------|----------|------------------|
| `pending` | `updated_at` | `submitted_at`, `confirmed_at`, `failed_at` |
| `submitted` | `submitted_at`, `updated_at` | `confirmed_at`, `failed_at` |
| `confirmed` | `confirmed_at`, `updated_at` | `failed_at` (submitted_at se preserva) |
| `failed` | `failed_at`, `updated_at` | `confirmed_at` (submitted_at se preserva para debug) |
| `skipped` | `updated_at` | `submitted_at`, `confirmed_at`, `failed_at` |

Esto evita que el UI del pipeline muestre timestamps stale de un status anterior (ej. un `confirmed_at` viejo en una fila ahora `failed`).

---

## Logica de writePipelineRow

La funcion `writePipelineRow` implementa una estrategia upsert inteligente:

1. **status='waiting':** Intenta UPDATE fila waiting existente. Si no existe, INSERT.
2. **status='pending':** Intenta UPDATE fila en status `waiting` o `pending` (transicion in-place). Si no existe, intenta reactivar fila en `confirmed/failed/skipped`. Si nada, INSERT.
3. **Otros estados (submitted, confirmed, failed, skipped):** Intenta UPDATE fila en `pending` o `submitted`. Para `confirmed`, tambien matchea filas ya `confirmed` (evita duplicados de raza entre handler y consolidator). Si nada, INSERT.

Esto garantiza que el usuario vea la misma fila evolucionar de `waiting -> pending -> submitted -> confirmed` sin parpadeos en la UI.

---

## Jobs Schedulados

### qb-pipeline-consolidator

- **Schedule:** `*/2 * * * *` (cada 2 minutos)
- **Funcion:** Encuesta el bridge para todas las filas `submitted` con `bridge_op_id`. Confirma o falla cada una. Cachea EditSequence. Propaga TxnID a entidades (customer_payment, pos_credit_memo, order metadata).
- **Recovery pass:** Al final de cada ciclo, busca filas `refund_payment` en `waiting` cuyo `write_check` dependiente ya esta `confirmed` -- las activa automaticamente. Resuelve el caso de server restart durante confirmacion.
- **Stale cleanup:** Al final de cada ciclo, marca como `failed` filas submitted >30 min y pending >20 min. Invalida el EditSequence cache para las filas afectadas.
- **Cache invalidation on failure:** Cuando el bridge reporta una operacion fallida, invalida el EditSequence cache para ese documento — EXCEPTO Error 3175 ("transaction locked") donde el cache sigue valido porque QB no modifico el documento.

**Side effects del consolidator al confirmar:**

| Step confirmado | Side effect |
|-----------------|-------------|
| `credit_memo` | UPDATE `pos_credit_memo.qb_txn_id` + `qb_edit_sequence`. Propaga `qb_txn_id` al `customer_payment` vinculado. |
| `write_check` | UPDATE `customer_payment.qb = { status:'yes', check_txn_id }`. Activa filas `refund_payment` en waiting. |
| `payment` | UPDATE `customer_payment.metadata.qb_txn_id` si no estaba ya seteado. |
| `estimate` | UPDATE `order.metadata` con patch de estimate (txnId, editSequence, syncStatus:'synced'). |
| `sales_order` | Merge de editSequence en `order.metadata.qb_sales_order`. |

### qb-pos-sync

- **Schedule:** `*/30 * * * *` (cada 30 minutos)
- **Funcion:** Procesa ordenes/drafts POS con mas de 1 hora pero menos de 24 horas de antiguedad que aun no tienen SO/estimate en QB. Tambien auto-reintenta pagos fallidos (max 3 intentos).
- **Guards:** Verifica pipeline, pos_invoice record en DB, y metadata -- evita crear Sales Orders duplicados.

### qb-operation-recovery

- **Schedule:** `*/5 * * * *` (cada 5 minutos)
- **Funcion:** Encuentra operaciones en `qb_sync_log` con status='processing' y `qb_operation_id` registrado, entre 3 minutos y 24 horas de antiguedad. Las consulta en el bridge y las completa/falla en la DB.
- **Caso de uso:** Server Railway reinidia mientras el handler estaba en medio del polling.

### quickbooks-daily-sync

- **Schedule:** `*/30 * * * *` (cada 30 minutos, con logica interna de hora)
- **Funcion:** Sync de precios y clientes desde QB -> Medusa. Soporta modo daily (a una hora fija) e intervalo (cada N minutos). Limpia logs viejos (>90 dias).

### quickbooks-inventory-sync

- **Schedule:** Separado (ver `src/jobs/quickbooks-inventory-sync.ts`)
- **Funcion:** Sync de inventario (cantidades + ubicaciones) desde QB.

### quickbooks-nightly-verify

- **Schedule:** Separado (ver `src/jobs/quickbooks-nightly-verify.ts`)
- **Funcion:** Verificacion nocturna de consistencia.

---

## Auto-timeouts del GET /admin/quickbooks/pipeline

El endpoint GET aplica timeouts automaticos al consultar el pipeline. Cada timeout tambien invalida el EditSequence cache de las filas afectadas:

| Condicion | Accion | Cache |
|-----------|--------|-------|
| `submitted` sin `bridge_op_id` por mas de 10 min | Marca `failed` con "Submission timed out" | Invalidado |
| `submitted` con `bridge_op_id` por mas de 15 min | Marca `failed` con "QBWC did not respond within 15 minutes" | Invalidado |
| `pending` por mas de 30 min | Marca `failed` con "Operation stuck in pending" | Invalidado |

Ademas, `pollUntilQbConfirmed` detecta filas stale internamente:
- `submitted` con `updated_at` > 15 min → retorna `"stale"` inmediatamente
- `pending` con `updated_at` > 10 min → retorna `"stale"` inmediatamente

---

## Retry de Operaciones

**Via UI:** `POST /admin/quickbooks/pipeline?action=retry&id=<uuid>`

Solo retryable si el status es `failed` o `waiting`. El retry:
1. Resetea la fila a `pending` (incrementa `retry_count`)
2. Si ya habia `bridge_op_id`: re-encuesta sin resubmitir (evita duplicados)
3. Resetea `qb_sync_status` en la entidad para que el guard permita re-sync
4. Invoca el handler correspondiente en background

**write_check:** No se puede retry automatico -- requiere re-seleccion de cuenta bancaria desde la pagina de Accounting. El retry resetea `customer_payment.qb = null`.

---

## Dependency Chain (depends_on)

El campo `depends_on` permite encadenar operaciones donde B requiere el TxnID de A:

```
write_check row (pending/submitted/confirmed)
    ^
    |-- depends_on
refund_payment row (waiting)
    |
    v (se activa cuando write_check llega a confirmed)
refund_payment row (submitted)
```

El consolidator activa los `refund_payment` waiting cuando su `write_check` padre se confirma. El recovery pass los activa si el server reinicio entre la confirmacion del check y la activacion.

---

## Archivos Clave

| Tipo | Ruta | Proposito |
|------|------|-----------|
| Pipeline CRUD | `src/lib/quickbooks/qb-pipeline.ts` | writePipelineRow, confirm, fail, skip, EditSequence cache, findLatestInFlightRow |
| Serializer | `src/lib/quickbooks/qb-serializer.ts` | `withQbSerialized` — DB + in-memory lock para serializar writes |
| In-memory lock | `src/lib/quickbooks/qb-locks.ts` | `withQbLock` — promise chain per key (fast path) |
| Consolidator | `src/jobs/qb-pipeline-consolidator.ts` | Polling + confirmacion + side effects + stale cleanup + cache invalidation |
| POS sync | `src/jobs/qb-pos-sync.ts` | Activa waiting rows POS, retry pagos |
| Recovery | `src/jobs/qb-operation-recovery.ts` | Resume operaciones stuck en qb_sync_log |
| Daily sync | `src/jobs/quickbooks-daily-sync.ts` | Precios + clientes scheduled |
| API pipeline | `src/api/admin/quickbooks/pipeline/route.ts` | GET/POST/DELETE del pipeline + retry logic + auto-timeouts |
| Logger | `src/lib/quickbooks/qb-sync-logger.ts` | qb_sync_log CRUD |
| Sales rep parser | `src/lib/quickbooks/parse-sales-rep.ts` | Extrae iniciales de sales rep de metadata (soporta string y objeto) |

---

## Historial de Decisiones

- **waiting status:** Introducido para POS -- permite mostrar en la UI que la operacion existe (no es un vacio) antes de que QBWC procese.
- **Upsert vs INSERT:** La logica de upsert en `writePipelineRow` evita que la UI parpadee (la fila evoluciona in-place en vez de desaparecer y reaparecer).
- **Consolidator vs polling en handler:** El polling soplado desde el handler causaba timeouts de Railway (~5min). El consolidator cron desacopla el polling del ciclo de vida del request.
- **refund_payment activado por consolidator:** La cadena write_check -> refund_payment usa `depends_on` porque el TxnID del Write Check no se conoce hasta que QB Desktop procesa -- es asicrono.
- **Serializacion DB-based (2026-04-10):** Introducido `withQbSerialized` como capa global. El lock in-memory (`withQbLock`) no sobrevivia reinicios. La capa DB consulta `qb_order_pipeline` para detectar operaciones in-flight y esperar. El in-memory lock sigue como fast path para concurrencia dentro del mismo proceso.
- **Pre-flight row exclusion (2026-04-10):** `findLatestInFlightRow` excluye rows `pending` sin `bridge_op_id` para evitar deadlocks — el serializer esperaria su propio pre-flight row que solo puede avanzar si el serializer ejecuta.
- **Cache invalidation selectiva (2026-04-10):** Error 3175 (transaction locked) NO invalida el EditSequence cache porque QB no modifico el documento. Todos los demas errores SI invalidan para forzar un GET fresh en el siguiente intento.
- **Timestamp cleanup universal (2026-04-10):** Toda transicion de status limpia timestamps de estados anteriores. Previene que el UI del pipeline muestre fechas de un status previo (ej. `confirmed_at` viejo en una fila ahora `failed`).
- **Sales rep sync en Mod (2026-04-10):** Todas las funciones de update (EstimateMod, SalesOrderMod, InvoiceMod, SalesReceiptMod) ahora pasan `salesRepRef` al bridge. Nuevas funciones `updateInvoiceInQb` y `updateSalesReceiptInQb` creadas para soportar Mod de sales rep en documentos existentes.
