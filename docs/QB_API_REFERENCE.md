# QuickBooks API Reference -- Medusa Admin Endpoints
> **Tipo**: Technical Reference
> **Repo**: backend
> **Ultima verificacion**: 2026-04-02
> **Estado**: Current

---

## Base URL

Todos los endpoints estan bajo `/admin/quickbooks/`. Requieren autenticacion de admin.

---

## Endpoints

### Bridge

#### GET /admin/quickbooks/bridge
Obtiene estadisticas de la cola del bridge (`/api/sync/queue-stats`).

**Response:**
```json
{ "success": true, "pending": 3, "processing": 1, "completed": 145, "failed": 2 }
```

#### POST /admin/quickbooks/bridge
Ejecuta acciones sobre el bridge.

**Body:**
```json
{ "action": "reset-busy" }
// o
{ "action": "purge" }
```

- `reset-busy`: Resetea operaciones bloqueadas en estado "processing" en el bridge
- `purge`: Purga toda la cola del bridge (destructivo)

---

### Config

#### GET /admin/quickbooks/config
Obtiene la configuracion actual de QuickBooks.

**Response campos clave:**
```json
{
  "config": {
    "integration_enabled": true,
    "inventory_interval_minutes": 60,
    "price_interval_minutes": 1440,
    "customer_interval_minutes": 1440,
    "price_sync_hour": 2,
    "price_sync_timezone": "America/New_York",
    "shipping_item_id": "800006A3-1395258131",
    "default_sales_tax_code": "Sale Tax 7%",
    "store_hours_open_hour": 8,
    "store_hours_close_hour": 18,
    "store_sat_open": true,
    "store_sun_open": false,
    "inventory_respect_hours": true,
    "price_respect_hours": false,
    "customer_respect_hours": false
  }
}
```

#### POST /admin/quickbooks/config
Actualiza la configuracion. Solo los campos presentes en el body se actualizan.

**Body (todos opcionales):**
```json
{
  "integration_enabled": true,
  "inventory_sync_interval_minutes": 60,
  "price_sync_interval_minutes": 1440,
  "customer_sync_interval_minutes": 1440,
  "price_sync_hour": 2,
  "price_sync_timezone": "America/New_York",
  "shipping_item_id": "800006A3-...",
  "default_sales_tax_code": "Sale Tax 7%",
  "store_hours_open_hour": 8,
  "store_hours_close_hour": 18,
  "store_sat_open": true,
  "store_sat_open_hour": 9,
  "store_sat_close_hour": 14,
  "store_sun_open": false,
  "store_hours_timezone": "America/New_York",
  "inventory_respect_hours": true,
  "price_respect_hours": false,
  "customer_respect_hours": false
}
```

Cambiar `integration_enabled` invalida el cache en-proceso inmediatamente.

---

### Pipeline

#### GET /admin/quickbooks/pipeline

Lista filas del pipeline con paginacion y filtros. **Ejecuta auto-timeouts** en cada llamada.

**Auto-timeouts aplicados:**
- `submitted` sin bridge_op_id + mas de 10 min -> `failed`
- `submitted` con bridge_op_id + mas de 15 min -> `failed` (QBWC no respondio)
- `pending` + mas de 30 min -> `failed` (handler no re-submitted)

**Query params:**

| Param | Tipo | Descripcion |
|-------|------|-------------|
| `limit` | number | Filas por pagina (default 30, max 100) |
| `offset` | number | Paginacion (default 0) |
| `status` | string | `pending\|submitted\|confirmed\|failed\|skipped\|waiting` |
| `step` | string | `estimate\|sales_order\|invoice\|payment\|...` |
| `reference_id` | string | Filtra por order_id o reference_id |
| `sort_by` | string | `created_at` (default) o `updated_at` |

**Response:**
```json
{
  "pipeline": [
    {
      "id": "uuid",
      "order_id": "order_...",
      "reference_id": "cpay_...",
      "reference_type": "pos_invoice",
      "step": "payment",
      "status": "confirmed",
      "depends_on": null,
      "bridge_op_id": "op_abc123",
      "retry_count": 0,
      "qb_txn_id": "8C57-...",
      "qb_ref_number": "PAY-2016",
      "medusa_ref_number": "PAY-2016",
      "error": null,
      "created_at": "...",
      "submitted_at": "...",
      "confirmed_at": "...",
      "failed_at": null,
      "order_display_id": 1234,
      "depends_on_step": null,
      "depends_on_status": null,
      "depends_on_medusa_ref": null,
      "payment_dep_ref": null,
      "payment_dep_status": null
    }
  ],
  "pagination": { "total": 450, "limit": 30, "offset": 0, "hasMore": true },
  "counts": { "pending": 2, "submitted": 5, "confirmed": 440, "failed": 3 }
}
```

#### POST /admin/quickbooks/pipeline?action=retry&id=<uuid>

Reintenta una operacion fallida. Solo retryable si status es `failed` o `waiting`.

**Comportamiento:**
- Si tiene `bridge_op_id`: re-encuesta el bridge (no resubmite para evitar duplicados)
- Si no tiene `bridge_op_id`: resetea a `pending` y re-invoca el handler
- `write_check`: No se puede reintentar automaticamente -- resetea `customer_payment.qb = null` y redirige al usuario a re-procesar desde la pagina de Accounting

**Response:**
```json
{ "success": true, "message": "Retrying invoice -- re-submitted to bridge" }
```

#### DELETE /admin/quickbooks/pipeline

Flushea operaciones del bridge y/o elimina filas del pipeline de Medusa.

**Query params:**

| Param | Default | Descripcion |
|-------|---------|-------------|
| `bridge` | `true` | Flushea la cola del bridge |
| `medusa` | `true` | Elimina todas las filas de qb_order_pipeline |
| `reason` | - | Etiqueta para el audit log |

---

### Logs

#### GET /admin/quickbooks/logs

Lista entradas de `qb_sync_log`.

---

### Order Sync (Manual)

#### POST /admin/quickbooks/order

Dispara manualmente el flujo QB para una orden especifica.

**Body:**
```json
{ "order_id": "order_..." }
```

#### POST /admin/quickbooks/draft-order

Dispara manualmente el flujo QB para un draft order (Estimate).

**Body:**
```json
{ "id": "order_..." }
```

#### POST /admin/quickbooks/sales-receipt

Crea un Sales Receipt en QB para una orden.

---

### Sync Jobs (Manual)

#### POST /admin/quickbooks/sync/customers

Dispara sync manual de clientes desde QB -> Medusa.

#### POST /admin/quickbooks/sync/customers/reconcile

Reconcilia clientes (verifica inconsistencias).

#### POST /admin/quickbooks/sync/inventory

Dispara sync manual de inventario desde QB -> Medusa.

#### POST /admin/quickbooks/sync/prices

Dispara sync manual de precios desde QB -> Medusa.

#### GET /admin/quickbooks/sync/last-job

Obtiene el reporte del ultimo sync job por tipo.

#### GET /admin/quickbooks/sync/stream

SSE stream de logs en tiempo real del sync job activo.

---

### Customer (Individual)

#### GET /admin/quickbooks/customer

Verifica un customer especifico en QB.

**Query params:**
```
?customer_id=cus_...
```

#### GET /admin/quickbooks/check/customers

Chequea multiples customers contra QB.

---

### Import

#### POST /admin/quickbooks/import/payments

Importa pagos desde QB -> Medusa.

#### POST /admin/quickbooks/import/sales-orders

Importa sales orders desde QB -> Medusa.

---

## Seguridad

Todos los endpoints requieren sesion de admin activa (cookie `connect.sid`). No hay CORS abierto para estos endpoints.

---

## Archivos Clave

| Tipo | Ruta | Proposito |
|------|------|-----------|
| Bridge route | `src/api/admin/quickbooks/bridge/route.ts` | Queue stats + acciones |
| Config route | `src/api/admin/quickbooks/config/route.ts` | Configuracion |
| Pipeline route | `src/api/admin/quickbooks/pipeline/route.ts` | Pipeline CRUD + retry |
| Order route | `src/api/admin/quickbooks/order/route.ts` | Sync manual de orden |
| Draft order route | `src/api/admin/quickbooks/draft-order/route.ts` | Sync manual de draft |
| Logs route | `src/api/admin/quickbooks/logs/route.ts` | Sync logs |
| Sync routes | `src/api/admin/quickbooks/sync/*/route.ts` | Syncs manuales |
| Import routes | `src/api/admin/quickbooks/import/*/route.ts` | Importacion |
