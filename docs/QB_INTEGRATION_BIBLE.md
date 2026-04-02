# QuickBooks Integration — Bible
> **Tipo**: Technical Reference
> **Repo**: backend + bridge externo (Node.js en Windows)
> **Ultima verificacion**: 2026-04-02
> **Estado**: Current

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
    +-- qb_edit_sequence_cache (PostgreSQL) -- cache de EditSequence
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

**Polling en Medusa:** El cron `qb-pipeline-consolidator` (cada 1 min actualmente, cambiado de 2) encuesta el bridge y actualiza `qb_order_pipeline`. No hacer polling manual desde los handlers.

**Statuses de operacion en el bridge:** `pending` | `processing` | `completed` | `failed`

**Critico:** Siempre esperar `txnId` (confirmado en QB Desktop) antes de encadenar operaciones. Por ejemplo, crear un Invoice vinculado a un Sales Order requiere el `txnId` del SO.

---

## Instalacion del Bridge (Windows Server)

### Prerequisitos

- Windows Server 2008+ con QuickBooks Desktop Enterprise instalado
- Node.js v16/v18 LTS (Node v12 ya no aplica -- sistema migrado)
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
pm2 startup   # Seguir instrucciones para inicio automatico en Windows
```

### Restart limpio

```powershell
.\clean-restart.bat   # Para el bridge, hace git pull, limpia EADDRINUSE, reinicia
```

### QB Web Connector

- Debe tener `Every_N_Minutes = 1` y "Auto-Run" activado
- Primera vez: QB muestra ventana de certificado -> seleccionar "Yes, always allow access even if QuickBooks is not running"

### Proceso de deploy de cambios al bridge

1. Hacer push al repo del bridge en GitHub
2. **Pedir al usuario** que haga `git pull` en el servidor Windows y reinicie el bridge
3. El servidor de bridge **no** tiene CI/CD automatico

---

## API del Bridge

**Base URL:** `https://qb.eptbridge.com/api`

### Health

| Metodo | Path | Descripcion |
|--------|------|-------------|
| GET | `/health` | Verifica si el bridge esta activo. Responde `{ status: "healthy" }` |

### Operations

| Metodo | Path | Descripcion |
|--------|------|-------------|
| GET | `/api/sync/status/:operationId` | Estado de una operacion asincrona |
| POST | `/api/sync/enqueue` | Encola operacion generica |
| POST | `/api/sync/queue/flush` | Flushea toda la cola del bridge |
| POST | `/api/sync/queue/purge` | Purge de la cola |
| GET | `/api/sync/queue-stats` | Estadisticas de la cola |
| POST | `/api/sync/reset-busy` | Resetea operaciones bloqueadas |

### Customers

| Metodo | Path | Descripcion |
|--------|------|-------------|
| POST | `/api/customers` | Add o Mod un customer. Body: payload + `{ action: "add" | "mod" }` |
| GET | `/api/customers/:listId` | Queries un customer por ListID (para obtener EditSequence) |

### Documents

| Metodo | Path | Descripcion |
|--------|------|-------------|
| POST | `/api/estimates` | Crea Estimate |
| PUT | `/api/estimates/:txnId` | Modifica Estimate (EstimateMod) |
| DELETE | `/api/estimates/:txnId` | Voidea/cierra Estimate |
| POST | `/api/sales-orders` | Crea Sales Order |
| PUT | `/api/sales-orders/:txnId` | Modifica Sales Order |
| POST | `/api/invoices` | Crea Invoice |
| PUT | `/api/invoices/:txnId` | Modifica Invoice |
| DELETE | `/api/invoices/:txnId` | Voidea Invoice |
| POST | `/api/payments` | Receive Payment |
| PUT | `/api/payments/:txnId` | Modifica Payment |
| POST | `/api/sales-receipts` | Crea Sales Receipt |
| DELETE | `/api/sales-receipts/:txnId` | Voidea Sales Receipt |
| POST | `/api/credit-memos` | Crea Credit Memo |
| DELETE | `/api/credit-memos/:txnId` | Voidea Credit Memo |
| POST | `/api/checks` | Write Check |

### Sync

| Metodo | Path | Descripcion |
|--------|------|-------------|
| GET | `/api/inventory` | Lee inventario de QB |
| GET | `/api/prices` | Lee precios de QB |

---

## Modulos del Client en Medusa

El codigo cliente esta modularizado en `src/lib/quickbooks/client/`:

| Archivo | Exporta |
|---------|---------|
| `core.ts` | `bridgeFetch`, `pollOperationResult`, `pollRawOperationResult`, `checkBridgeHealth`, `getCustomerEditSequence`, `updateCustomerInQb` |
| `customers.ts` | `createCustomerInQb` |
| `estimates.ts` | `createEstimateInQb`, `updateEstimateInQb`, `deactivateEstimateInQb` |
| `sales-orders.ts` | `createSalesOrderInQb`, `convertEstimateToSalesOrder` |
| `invoices.ts` | `createInvoiceInQb`, `applyPaymentToInvoiceInQb` |
| `payments.ts` | `receivePaymentInQb` |
| `sales-receipts.ts` | `createSalesReceiptInQb` |
| `credit-memos.ts` | Operaciones de Credit Memo |
| `checks.ts` | Write Check |
| `refunds.ts` | Refund Payment |
| `transfer.ts` | Customer transfer |
| `inventory.ts` | Sync de inventario |
| `types.ts` | Tipos compartidos del cliente |

`src/lib/quickbooks/qb-bridge-client.ts` es un proxy de backward-compat que re-exporta todo de `client/index.ts`.

---

## Polling Parameters

```typescript
POLL_INTERVAL_MS = 20_000  // 20 segundos entre intentos
MAX_POLL_ATTEMPTS = 20     // max 20 intentos = ~6.7 minutos total
```

Si el polling agota los intentos sin respuesta, la operacion queda sin `txnId` y el cron de recovery (`qb-operation-recovery`, cada 5 min) la recoge.

---

## EditSequence Cache

QB requiere un `EditSequence` actualizado para cualquier operacion Mod (update). Para evitar un GET extra antes de cada Mod:

- Despues de cada operacion Add o Mod confirmada, el sistema cachea el `EditSequence` en `qb_edit_sequence_cache`
- Consultar con `getCachedEditSequence(entityType, qbId)`
- Invalidar con `invalidateEditSequence(entityType, qbId)` en caso de error 3210 (EditSequence stale)

---

## Configuracion DB

La tabla `quickbooks_config` (row `id='default'`) almacena:

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
| Guard | `src/lib/quickbooks/qb-integration-guard.ts` | Kill switch con cache |
| Pipeline | `src/lib/quickbooks/qb-pipeline.ts` | CRUD de qb_order_pipeline + qb_edit_sequence_cache |
| Logger | `src/lib/quickbooks/qb-sync-logger.ts` | qb_sync_log CRUD |
| Metadata | `src/lib/quickbooks/qb-metadata-types.ts` | Tipos + builders de metadata en orders |
| Core flow | `src/lib/quickbooks/order-flow-core.ts` | Orquestacion del flujo completo |
| Bridge client | `src/lib/quickbooks/client/core.ts` | HTTP client + polling |
| Sync jobs | `src/lib/quickbooks/sync-jobs.ts` | In-memory job tracker para syncs de inventario/precios |

---

## Historial de Decisiones

- **Fire-and-poll vs Fire-and-forget:** Se eligio fire-and-poll porque QB Desktop puede tardar hasta 60s en procesar. Polling directo en el handler causaba timeouts en Railway. La solucion fue el pipeline table + consolidator cron.
- **qb-bridge-client.ts como proxy:** La refactorizacion a `client/` se hizo para separar responsabilidades. El archivo proxy mantiene backward-compat.
- **Node v12 descartado:** El servidor bridge fue migrado a Node v18. La nota de compatibilidad con v12 ya no aplica.
