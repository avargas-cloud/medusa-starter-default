# QuickBooks Admin Dashboard — Documentación Completa

| Campo | Detalle |
|-------|---------|
| **Propósito** | Dashboard de administración en `/app/quickbooks` — controla todos los syncs de QuickBooks Desktop, configuración de horarios, kill-switch master, y el Activity Log histórico de todas las operaciones QB. |
| **Última revisión** | 2026-03-31 (Legacy QB Data Import panel — Open Sales Orders + Unapplied Payments staging) |

## Resumen Ejecutivo

✅ **Master Kill Switch** — toggle para habilitar/deshabilitar toda la integración QB instantáneamente  
✅ **Store Hours** — configura horario de tienda (Mon-Fri + Sat + Sun); los syncs pueden respetar este horario  
✅ **Inventory Sync** — sincroniza stock desde QB Desktop a Medusa + Meilisearch  
✅ **Price Sync** — sincroniza precios (retail + wholesale) desde QB + re-indexa Meilisearch automáticamente  
✅ **Customer Sync** — importa clientes desde QB a Medusa  
✅ **QB Reconcile** — cruza IDs de clientes entre QB y Medusa, con Dry Run y Live modes  
✅ **Legacy QB Data Import** — importación de datos históricos (27 Open Sales Orders + Unapplied Payments por año)  
✅ **Activity Log** — historial paginado de todas las operaciones QB (order events + batch syncs)  
✅ **SyncReportModal** — popup con reporte detallado de cada job síncrono  
❌ **DraftOrdersSync widget** — eliminado (2026-03-06). El sync de draft orders se maneja desde la página `draft-orders-advanced`  

---

## Table of Contents

1. [File Structure](#1-file-structure)
2. [Layout de la Página](#2-layout-de-la-página)
3. [Master Toggle (Kill Switch)](#3-master-toggle-kill-switch)
4. [Store Hours](#4-store-hours)
5. [SyncCard — Componente Reutilizable](#5-synccard--componente-reutilizable)
6. [Inventory Sync](#6-inventory-sync)
7. [Price Sync](#7-price-sync)
8. [Customer Sync & Reconciliation](#8-customer-sync--reconciliation)
9. [Legacy QB Data Import](#9-legacy-qb-data-import)
10. [Activity Log](#10-activity-log)
11. [SyncReportModal](#11-syncreportmodal)
12. [API Endpoints](#12-api-endpoints)
13. [Database Schema](#13-database-schema)
14. [State Management](#14-state-management)
15. [Meilisearch Auto Re-Index](#15-meilisearch-auto-re-index)
16. [Known Issues & Gotchas](#16-known-issues--gotchas)

---

## 1. File Structure

```
backend/src/
│
├── admin/routes/quickbooks/
│   ├── page.tsx                              ← Página principal del dashboard
│   └── components/
│       ├── ActivityLog.tsx                   ← Log histórico de operaciones QB
│       ├── AuditModal.tsx                    ← Modal de auditoría de clientes
│       ├── StoreHoursSection.tsx             ← Config de horario de tienda
│       ├── SyncCard.tsx                      ← Componente reutilizable de sync
│       ├── SyncReportModal.tsx               ← Modal de reporte de jobs
│       ├── LegacyImportPanel.tsx             ← Panel de Legacy QB Data Import (2 tabs)
│       └── DraftOrdersSync.tsx               ← ⚠️ ELIMINADO DE LA PÁGINA (archivo existe pero no se usa)
│
├── api/admin/quickbooks/
│   ├── config/route.ts                       ← GET/POST configuración
│   ├── logs/route.ts                         ← GET activity log entries
│   ├── sync/
│   │   ├── inventory/route.ts                ← POST inventory sync
│   │   ├── prices/route.ts                   ← POST price sync
│   │   ├── customers/route.ts                ← POST customer sync
│   │   ├── customers/reconcile/route.ts      ← POST QB reconcile
│   │   ├── last-job/route.ts                 ← GET último job por tipo
│   │   └── [legacy import routes below]
│   ├── import/
│   │   ├── sales-orders/route.ts             ← GET/POST Sales Orders import
│   │   └── payments/route.ts                 ← GET/POST Payments import
│   └── check/customers/route.ts              ← GET/POST customer audit
│
├── lib/quickbooks/
│   ├── sync-inventory-core.ts               ← Inventory sync logic
│   ├── sync-prices-core.ts                  ← Price sync logic + Meilisearch re-index
│   ├── sync-customers-core.ts               ← Customer sync logic
│   └── check-customers-core.ts              ← Customer audit logic
│
└── jobs/
    ├── quickbooks-daily-sync.ts             ← Cron: inventory + price sync
    └── quickbooks-nightly-verify.ts         ← Cron: verifica ops QB de las últimas 24h
```

---

## 2. Layout de la Página

```
/app/quickbooks
│
├── ⚡ QuickBooks Integration (Master Toggle)
│
├── 🏪 Store Hours
│
├── 📦 Inventory Sync (SyncCard)
│
├── 💵 Price Sync (SyncCard)
│
├── 👥 Customer Sync (SyncCard)
│   └── Footer: [Dry Run Reconcile] [View Report] [Live Reconcile IDs]
│
├── 🕰️ Legacy QB Data Import (LegacyImportPanel)
│   ├── Tab 1: Open Sales Orders (27 ref numbers)
│   └── Tab 2: Unapplied Payments (3-step workflow)
│
└── 📋 Activity Log
```

> **¿Dónde syncronizar Draft Orders → QB Estimates?**  
> Eso se hace desde la página de `draft-orders-advanced`. El botón "Sync to QuickBooks" en cada draft order llama a `POST /admin/quickbooks/draft-order`. No hay widget en la página QB para eso.

---

## 3. Master Toggle (Kill Switch)

```typescript
// Estado
const [qbEnabled, setQbEnabled] = useState<boolean | null>(null)

// Handler
const handleQbToggle = async () => {
    await postConfig({ integration_enabled: !qbEnabled })
    setQbEnabled(prev => !prev)
    toast.success(newValue ? 'QuickBooks Integration ENABLED' : 'QuickBooks Integration DISABLED')
}
```

**Comportamiento:**
- `integration_enabled: true` → todos los syncs corren normalmente
- `integration_enabled: false` → todos los syncs y order flows (subscribers) están pausados
- Estado guardado en `quickbooks_config.integration_enabled` (boolean)
- Badge de color: verde = Enabled, rojo = Disabled, gris = Loading
- Banner rojo aparece cuando está disabled: "🔴 Integration is disabled..."

---

## 4. Store Hours

**Componente:** `StoreHoursSection.tsx`

Configura cuándo está abierta la tienda. Los syncs individuales tienen un toggle "Respect Store Hours" que cuando está activo, skipping el sync fuera del horario configurado.

**Campos configurables:**

| Campo | DB Column | Descripción |
|-------|-----------|-------------|
| Open Hour (Mon-Fri) | `store_hours_open_hour` | Hora de apertura (0-23) |
| Close Hour (Mon-Fri) | `store_hours_close_hour` | Hora de cierre (0-23) |
| Saturday Open | `store_sat_open` | Boolean |
| Saturday Hours | `store_sat_open_hour`, `store_sat_close_hour` | Solo si sat_open = true |
| Sunday Open | `store_sun_open` | Boolean |
| Sunday Hours | `store_sun_open_hour`, `store_sun_close_hour` | Solo si sun_open = true |
| Timezone | `store_hours_timezone` | IANA (e.g. `"America/New_York"`) |

**"Respect Hours" por sync:**

| Sync | Default |
|------|---------|
| Inventory | ✅ Activado (`inventory_respect_hours = true`) |
| Price | ❌ Desactivado |
| Customer | ❌ Desactivado |

---

## 5. SyncCard — Componente Reutilizable

**Archivo:** `components/SyncCard.tsx`

Componente genérico que maneja un tipo de sync. Recibe toda la lógica vía props.

**Props:**

| Prop | Tipo | Descripción |
|------|------|-------------|
| `title` | `string` | Título del card (con emoji) |
| `intervalValue` | `string` | Intervalo seleccionado ("disabled" o número) |
| `onIntervalChange` | `fn` | Setter del Select |
| `intervals` | `{value,label}[]` | Opciones del Select |
| `respectHours` | `boolean` | Toggle "Respect Store Hours" |
| `onRespectHoursChange` | `fn` | Setter del toggle |
| `onSave` | `fn` | Handler de guardado |
| `onViewReport` | `fn` | Abre SyncReportModal con último job |
| `onSyncNow` | `fn` | Disparar sync manual |
| `isSyncing` | `boolean` | Bloquea botón + muestra loader |
| `lastSync` | `string | null` | Timestamp del último sync |
| `formatSyncDate` | `fn` | Formatea el timestamp |
| `showTimePicker` | `boolean?` | Muestra selector de hora del día |
| `timeValue` | `string?` | "HH:00" del time picker |
| `onTimeChange` | `fn?` | Setter del time picker |
| `timeOptions` | `{value,label}[]?` | Opciones del time picker (00:00–23:00) |
| `footer` | `ReactNode?` | Contenido extra al pie (botones de reconcile) |

---

## 6. Inventory Sync

**Intervalos disponibles:** 1, 2, 3, 5, 10, 20, 25, 30, 45, 60 minutos  
**Respeta horario de tienda:** Sí (default true)

**Flujo:**
```
POST /admin/quickbooks/sync/inventory
    → syncInventoryCore()
        → Fetch items desde QB Bridge
        → UPDATE stock en Medusa DB
        → Retorna job_id
            → SyncReportModal muestra el resultado
```

**Meilisearch:** El inventory sync actualiza Medusa DB pero **no** dispara automáticamente re-index de Meilisearch. El re-index ocurre en el cron de reconciliation o manualmente desde inventory-advanced.

---

## 7. Price Sync

**Intervalos disponibles:** 1, 2, 5, 10, 24 horas  
**Time picker:** Solo cuando el intervalo es "Daily" (24h) — elige la hora exacta del día  
**Respeta horario de tienda:** No (default false)

**Flujo:**
```
POST /admin/quickbooks/sync/prices
    → syncPricesCore()
        → Fetch retail prices desde QB
        → UPDATE prices en Medusa DB
        → Auto-calcula wholesale (10% off)
        → Si se actualizaron precios → RE-INDEXA Meilisearch automáticamente
        → Retorna job_id → SyncReportModal
```

Ver [Sección 14](#14-meilisearch-auto-re-index) para detalles del re-index.

---

## 8. Customer Sync & Reconciliation

**Intervalos disponibles:** 1, 2, 5, 10, 24 horas  
**Time picker:** Disponible para 24h  
**Respeta horario:** No (default false)

**Flujo de sync:**
```
POST /admin/quickbooks/sync/customers
    → syncCustomersCore()
        → Fetch customers desde QB
        → Crea/actualiza customers en Medusa
        → Retorna job_id → SyncReportModal
```

### Reconciliation

Footer del Customer SyncCard tiene 3 botones adicionales:

| Botón | Endpoint | Descripción |
|-------|----------|-------------|
| Dry Run Reconcile | `POST /reconcile { dry_run: true }` | Solo reporta diferencias, no escribe |
| View Report | `setReportModal(lastJobIds.reconcile)` | Abre report del último reconcile |
| Live Reconcile IDs | `POST /reconcile { dry_run: false }` | Actualiza IDs en Medusa para que coincidan con QB |

El reconcile cruza los `ListID` de QB con los registros de Medusa para detectar y corregir desincronizaciones.

---

## 9. Legacy QB Data Import

**Archivo:** `components/LegacyImportPanel.tsx`

Panel de 2 pestañas para importación de datos históricos de QuickBooks. Permite traer documentos antiguos (Open Sales Orders, Unapplied Payments) desde QB Desktop a Medusa de manera controlada.

### Tab 1: Open Sales Orders

Importa 27 Sales Orders conocidas de QB.

**Pre-populated list:**
```
Ref#: "3682","4620","4910","5126","5695","5731","5891","5923","5956","6006",
      "6020","6025","6058","6059","6061","6062","6068","6082","6088","6118",
      "6131","6151","6198","6205","6224","6238","6239"
```

**Columnas por row:**

| Columna | Fuente | Descripción |
|---------|--------|-------------|
| Ref# | `qb_ref_number` | Número de SO en QB |
| TxnID | `qb_txn_id` | ID interno de QB Desktop |
| Customer | `qb_customer_name` | Nombre del cliente |
| Date | `txn_date` | Fecha de la SO |
| Amount | `amount` | Monto total |
| Balance | `balance_remaining` | Saldo pendiente |
| Status | `status` | "imported" (verde) o null |
| Submit | `—` | Botón para enviar consulta a QB |

**Flujo:**

1. **On Mount**: Carga registros existentes desde tabla `qb_legacy_so` y marca rows como "done" (imported)
2. **Counter**: Encabezado muestra "X/27 fetched"
3. **Submit**: `POST /admin/quickbooks/import/sales-orders { refNumber: "5731" }`
   - Consulta QB Bridge con ese RefNumber específico
   - Guarda resultado en tabla `qb_legacy_so`
   - Row se marca como "done"
4. **Persistencia**: Los registros quedan en DB — survive page reload

**Comportamiento del Submit:**
- Query a QB por RefNumber (el Bridge busca directamente)
- Inserta/actualiza row en `qb_legacy_so` con: qb_txn_id, qb_ref_number, qb_customer_list_id, qb_customer_name, txn_date, amount, balance_remaining, status="imported", imported_at=NOW
- Row mostrado se marca "done" (visual feedback)

---

### Tab 2: Unapplied Payments (Staging Workflow)

Importa pagos no aplicados de QB para ser aplicados en Medusa.

**Year Selector:**
- Botones: [2024] [2025] [2026]
- Botón [+] para agregar años anteriores
- Cambiar año: carga datos del DB instantáneamente (no consulta QB)
- Cada año se almacena como `year` en tabla `qb_legacy_payment`

**3-Step Workflow:**

| Paso | Acción | Endpoint | Resultado |
|------|--------|----------|----------|
| 1 | **"Sync from QB"** | `POST /admin/quickbooks/import/payments { action: "sync", year: 2026 }` | Consulta QB ReceivePayments para ese año, guarda en staging, borra pending previos (keeps applied) |
| 2 | **Review** | UI solo | Registros persisten en DB, survive reload, tab switches, year changes |
| 3 | **"Apply" per row** | `POST /admin/quickbooks/import/payments { action: "apply", txn_id: "...", year: 2026 }` | Crea `customer_payment` en Medusa vía financeService, marca staging como applied |

**Status Badges:**

| Status | Color | Descripción |
|--------|-------|-------------|
| `pending` | 🟠 Amber | Descargada de QB, no aplicada aún |
| `applied` | 🟢 Green | Ya se creó customer_payment en Medusa |
| `no_match` | ⚪ Grey | No se encontró customer_id en Medusa (email no coincide) |

**Paginación:** 20 registros por página con Prev/Next

**Columnas por row:**

| Columna | Fuente | Descripción |
|---------|--------|-------------|
| Ref# | `qb_ref_number` | RefNumber del ReceivePayment en QB |
| TxnID | `qb_txn_id` | ID interno de QB |
| Customer | `qb_customer_name` / `medusa_customer_email` | Nombre o email |
| Date | `txn_date` | Fecha del pago |
| Amount | `amount_cents / 100` | Monto en dólares |
| Method | `method` | "Check", "Cash", etc. |
| Status | `status` | Badge (pending/applied/no_match) |
| Action | `—` | Botón "Apply" si status=pending, disabled si applied |

**Comportamiento del Sync:**

1. Query QB via Bridge: ReceivePayments con FromTxnDate/ToTxnDate para ese año
2. Upsert a `qb_legacy_payment` (qb_txn_id es UNIQUE)
3. DELETE registros pending para ese año (keeps applied ones intact)
4. Page actualiza UI con nuevos registros

**Comportamiento del Apply:**

1. POST → financeService.createCustomerPayment()
2. Crea row en `customer_payment` tabla
3. Marca staging record: `status = "applied"`, `applied_payment_id = uuid`, `applied_at = NOW`
4. Button desaparece (applied)

---

## 10. Activity Log

**Archivo:** `components/ActivityLog.tsx`  
**Endpoint:** `GET /admin/quickbooks/logs`

El Activity Log es el historial completo de **todas las operaciones QuickBooks** — tanto order events (automáticos/manuales vía subscribers) como batch syncs (inventory, price, customer).

### Tipos de operación

| Operación | Ícono | Descripción |
|-----------|-------|-------------|
| `sales_order` | 🧾 | Creación/actualización de SO en QB |
| `estimate` | 📋 | Creación/actualización de Estimate en QB |
| `payment` | 💳 | Pago registrado en QB |
| `invoice` | 📄 | Invoice generada en QB |
| `cancel` | ❌ | Cancelación de SO o Estimate |
| `customer_transfer` | 👤 | Importación de customer desde QB |
| `inventory_sync` | 📦 | Batch sync de inventario |
| `price_sync` | 💵 | Batch sync de precios |
| `customer_sync` | 👥 | Batch sync de clientes |

### Statuses

| Status | Badge Color | Descripción |
|--------|-------------|-------------|
| `completed` | 🟢 Green | Operación exitosa |
| `failed` | 🔴 Red | Falló con error |
| `processing` | 🔵 Blue | En progreso |
| `skipped` | ⚪ Grey | QB disabled o TxnID no encontrado |

### Filtros disponibles

- **Category:** All Types | Order Events | Batch Syncs
- **Status:** All | Completed | Processing | Failed | Skipped

### Paginación

25 entries por página. Paginación Prev/Next. El header muestra el total de entries.

### Campos por entry (expandibles)

Click en una fila expande los detalles:

| Campo | Descripción |
|-------|-------------|
| `operation` | Tipo de operación |
| `status` | Estado |
| `order_display_id` | `#1089` — número de orden en Medusa |
| `qb_ref_number` | Número de ref en QB (SO, Estimate, etc.) |
| `qb_txn_id` | TxnID interno de QB Desktop |
| `event_type` | Evento Medusa que disparó la operación (e.g. `order.placed`) |
| `triggered_by` | `"manual"` (badge azul) o `"event"` |
| `message` | Mensaje descriptivo (e.g. "SO #6176 closed for Order #1087") |
| `error` | Stack trace o mensaje de error si `status === "failed"` |
| `duration_ms` | Tiempo de ejecución |
| `server_host` | ⚡ Railway o 💻 local |
| `initiated_at` / `completed_at` | Timestamps |
| `metadata.changedItems` | Para `inventory_sync`: tabla SKU / Before / After / Δ |

### Inventory Sync — Changed Items

Cuando una entrada de `inventory_sync` se expande y tiene `metadata.changedItems`, muestra una tabla con:

```
SKU            Before   After    Δ
LED-STRIP-3K   50       48       -2
POWER-SUP-75W  12       15       +3   (⚠️ anomaly si el delta es >100)
```

### Auto-refresh

El componente acepta prop `autoRefresh?: boolean`. Cuando true, hace polling cada **15 segundos**. Actualmente está desactivado (`autoRefresh={false}` por defecto o sin prop). Usar el botón **↻ Refresh** para actualizar manualmente.

### Activity Log API

```
GET /admin/quickbooks/logs?limit=25&offset=0&category=order&status=failed
```

**Response:**
```json
{
  "logs": [{ "id": "...", "operation": "sales_order", "status": "completed", ... }],
  "pagination": { "total": 142, "limit": 25, "offset": 0 }
}
```

---

## 11. SyncReportModal

**Archivo:** `components/SyncReportModal.tsx`

Modal que muestra el output completo de un job de sync. Se abre automáticamente después de un "Sync Now" exitoso, o manualmente con "View Report".

```typescript
const [reportModal, setReportModal] = useState<{ jobId: string | null; title: string } | null>(null)

// Abrir tras sync manual:
const { job_id } = await res.json()
setReportModal({ jobId: job_id, title: '📦 Inventory Sync Report' })

// Abrir último report guardado:
setReportModal({ jobId: lastJobIds.inventory ?? null, title: '📦 Inventory Sync Report' })
```

Los `lastJobIds` se cargan al montar la página llamando a `GET /admin/quickbooks/sync/last-job?type=inventory|prices|customers|reconcile`.

---

## 12. API Endpoints

### Configuración

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/admin/quickbooks/config` | Lee configuración actual |
| POST | `/admin/quickbooks/config` | Guarda configuración |

**Campos configurables vía POST:**

```typescript
{
    integration_enabled?: boolean,
    inventory_sync_interval_minutes?: number | null,
    inventory_respect_hours?: boolean,
    price_sync_interval_minutes?: number | null,  // en minutos (horas × 60)
    price_respect_hours?: boolean,
    price_sync_hour?: number,                     // 0-23 integer
    customer_sync_interval_minutes?: number | null,
    customer_respect_hours?: boolean,
    store_hours_open_hour?: number,
    store_hours_close_hour?: number,
    store_sat_open?: boolean,
    store_sat_open_hour?: number,
    store_sat_close_hour?: number,
    store_sun_open?: boolean,
    store_sun_open_hour?: number,
    store_sun_close_hour?: number,
    store_hours_timezone?: string,
}
```

> `null` = disabled (apaga el intervalo de sync). Range válido para intervalos: 1–10080 minutos.

### Syncs

| Método | Endpoint | Job type |
|--------|----------|----------|
| POST | `/admin/quickbooks/sync/inventory` | `inventory` |
| POST | `/admin/quickbooks/sync/prices` | `prices` |
| POST | `/admin/quickbooks/sync/customers` | `customers` |
| POST | `/admin/quickbooks/sync/customers/reconcile` | `reconcile` |
| GET | `/admin/quickbooks/sync/last-job?type=X` | Retorna `{ job_id }` del último job |

**Response de sync (exitoso):**
```json
{ "success": true, "job_id": "uuid-del-job" }
```

### Activity Log

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/admin/quickbooks/logs` | Lista paginada con filtros |

**Query params:** `limit`, `offset`, `category` (`order`\|`sync`), `status`

### Customer Audit

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| POST | `/admin/quickbooks/check/customers` | Dispara auditoría (QB vs Medusa) |
| GET | `/admin/quickbooks/check/customers` | Lee últimos resultados |

### Legacy QB Data Import

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/admin/quickbooks/import/sales-orders` | Lista registros de `qb_legacy_so` |
| POST | `/admin/quickbooks/import/sales-orders` | Query QB por RefNumber, guarda en tabla |
| GET | `/admin/quickbooks/import/payments?year=2026` | Lee `qb_legacy_payment` para ese año (instant, no QB) |
| POST | `/admin/quickbooks/import/payments` | `action: "sync"` ↔ query QB, `action: "apply"` ↔ create customer_payment |

**Parámetros POST `/admin/quickbooks/import/sales-orders`:**
```json
{
  "refNumber": "5731"
}
```

**Response (exitoso):**
```json
{
  "success": true,
  "data": {
    "qb_txn_id": "...",
    "qb_ref_number": "5731",
    "qb_customer_name": "...",
    "amount": 1234.56,
    "balance_remaining": 0,
    "imported_at": "2026-03-31T12:34:56.000Z"
  }
}
```

**Parámetros POST `/admin/quickbooks/import/payments`:**
```json
{
  "action": "sync",
  "year": 2026
}
```

O:

```json
{
  "action": "apply",
  "txn_id": "...",
  "year": 2026
}
```

**Response (sync):**
```json
{
  "success": true,
  "synced_count": 12,
  "message": "Synced 12 payments from QB for year 2026"
}
```

**Response (apply):**
```json
{
  "success": true,
  "customer_payment_id": "uuid",
  "message": "Payment applied successfully"
}
```

---

## 13. Database Schema

### `quickbooks_config` (single-row)

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `id` | VARCHAR | Primary key (constante `"default"`) |
| `integration_enabled` | BOOLEAN | Master kill switch |
| `inventory_interval_minutes` | INTEGER\|NULL | NULL = disabled |
| `inventory_respect_hours` | BOOLEAN | Respetar horario de tienda |
| `price_interval_minutes` | INTEGER\|NULL | En minutos (horas × 60) |
| `price_respect_hours` | BOOLEAN | |
| `price_sync_hour` | INTEGER | Hora del día para sync diario (0-23) |
| `customer_interval_minutes` | INTEGER\|NULL | |
| `customer_respect_hours` | BOOLEAN | |
| `store_hours_open_hour` | INTEGER | Mon-Fri apertura |
| `store_hours_close_hour` | INTEGER | Mon-Fri cierre |
| `store_sat_open` | BOOLEAN | |
| `store_sat_open_hour` | INTEGER | |
| `store_sat_close_hour` | INTEGER | |
| `store_sun_open` | BOOLEAN | |
| `store_sun_open_hour` | INTEGER | |
| `store_sun_close_hour` | INTEGER | |
| `store_hours_timezone` | VARCHAR | IANA timezone string |
| `last_inventory_sync` | TIMESTAMP | |
| `last_price_sync` | TIMESTAMP | |
| `last_customer_sync` | TIMESTAMP | |
| `bridge_url` | VARCHAR | URL del QB Bridge |
| `api_key` | VARCHAR | API key del QB Bridge |

### `quickbooks_activity_log`

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `id` | UUID | Primary key |
| `operation` | VARCHAR | `sales_order`, `estimate`, `cancel`, `inventory_sync`, etc. |
| `status` | VARCHAR | `completed`, `failed`, `processing`, `skipped` |
| `order_id` | VARCHAR\|NULL | Medusa Order UUID |
| `order_display_id` | INTEGER\|NULL | #1089 |
| `draft_order_id` | VARCHAR\|NULL | Para operaciones de estimate |
| `event_type` | VARCHAR\|NULL | Evento Medusa que disparó la op |
| `sync_type` | VARCHAR\|NULL | Para syncs en batch |
| `triggered_by` | VARCHAR\|NULL | `"manual"` o `"event"` |
| `message` | TEXT\|NULL | Descripción del resultado |
| `error` | TEXT\|NULL | Error si failed |
| `qb_txn_id` | VARCHAR\|NULL | TxnID en QB Desktop |
| `qb_ref_number` | VARCHAR\|NULL | RefNumber en QB (SO #6176, E18024591) |
| `duration_ms` | INTEGER\|NULL | Duración de la operación |
| `initiated_at` | TIMESTAMP | |
| `completed_at` | TIMESTAMP\|NULL | |
| `server_host` | VARCHAR\|NULL | Railway o hostname local |
| `metadata` | JSONB\|NULL | `{ changedItems: [...] }` para inventory |

### `qb_legacy_so`

Tabla de referencia para Open Sales Orders históricos importados desde QB.

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `id` | SERIAL | Primary key |
| `qb_txn_id` | VARCHAR | TxnID en QB Desktop (UNIQUE) |
| `qb_ref_number` | VARCHAR | RefNumber (e.g. "5731") |
| `qb_customer_list_id` | VARCHAR\|NULL | CustomerListID en QB |
| `qb_customer_name` | VARCHAR | Nombre del cliente en QB |
| `txn_date` | DATE | Fecha de la SO |
| `amount` | DECIMAL(12,2) | Monto total |
| `balance_remaining` | DECIMAL(12,2) | Saldo pendiente |
| `status` | VARCHAR | "imported" (será null en futuros estados) |
| `imported_at` | TIMESTAMP | Cuándo se importó |

### `qb_legacy_payment`

Tabla de staging para Unapplied Payments importados desde QB, con 3-step workflow.

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `id` | SERIAL | Primary key |
| `qb_txn_id` | VARCHAR | TxnID en QB Desktop (UNIQUE) |
| `qb_ref_number` | VARCHAR | RefNumber del ReceivePayment |
| `qb_customer_list_id` | VARCHAR\|NULL | CustomerListID en QB |
| `qb_customer_name` | VARCHAR | Nombre del cliente en QB |
| `medusa_customer_id` | VARCHAR\|NULL | UUID del customer en Medusa (si encontrado) |
| `medusa_customer_email` | VARCHAR\|NULL | Email usado para matchear con Medusa |
| `amount_cents` | INTEGER | Monto en centavos |
| `txn_date` | DATE | Fecha del pago en QB |
| `method` | VARCHAR | "Check", "Cash", "Deposit", etc. |
| `year` | INTEGER | Año para filtrado (2024, 2025, 2026, etc.) |
| `status` | VARCHAR | "pending" \| "applied" \| "no_match" |
| `applied_payment_id` | VARCHAR\|NULL | UUID de `customer_payment` creado (si applied) |
| `fetched_at` | TIMESTAMP | Cuándo se descargó de QB (update en cada sync) |
| `applied_at` | TIMESTAMP\|NULL | Cuándo se aplicó a Medusa |

---

## 14. State Management

### Conversión de intervalos (DB ↔ UI)

| Tipo | DB | UI |
|------|----|----|
| Null | `NULL` | `"disabled"` |
| Inventory | minutos (5) | `"5"` |
| Price/Customer | minutos (60) | `"1"` (hora) |

```typescript
// DB → UI
setInventoryInterval(config.inventory_interval_minutes != null
    ? String(config.inventory_interval_minutes)
    : 'disabled')

setPriceInterval(config.price_interval_minutes != null
    ? String(Math.floor(config.price_interval_minutes / 60))
    : 'disabled')

// UI → DB (en handlers)
inventory_sync_interval_minutes: inventoryInterval === 'disabled' ? null : parseInt(inventoryInterval)
price_sync_interval_minutes: priceInterval === 'disabled' ? null : parseInt(priceInterval) * 60
```

### Price Sync Hour

```typescript
// DB: integer 0-23 → UI: "HH:00"
const h = String(config.price_sync_hour).padStart(2, '0')
setPriceTimeOfDay(`${h}:00`)

// UI → DB
const priceSyncHour = parseInt(priceTimeOfDay.split(':')[0] ?? '0', 10)
await postConfig({ price_sync_hour: priceSyncHour })
```

---

## 15. Meilisearch Auto Re-Index

Después de un **Price Sync exitoso** con cambios reales, el sistema re-indexa automáticamente el índice `inventory` en Meilisearch:

```typescript
// src/lib/quickbooks/sync-prices-core.ts
if (!dryRun && stats.updatedPrice > 0) {
    await syncInventoryWorkflow(container).run({ input: {} })
    // Non-blocking: si falla, price sync igual retorna success
}
```

**Condiciones:**

| Condición | Resultado |
|-----------|---------|
| `dryRun=false` AND `updatedPrice > 0` | ✅ Re-index disparado |
| `dryRun=true` | ❌ Skipped |
| `updatedPrice === 0` | ❌ Skipped |
| Meilisearch falla | ⚠️ Warning log, sync = success |

Esto garantiza que las **Dynamic Pricing Columns** en `inventory-advanced` reflejen los nuevos precios inmediatamente.

---

## 16. Known Issues & Gotchas

### DraftOrdersSync — Componente eliminado de la UI

El componente `DraftOrdersSync.tsx` existe en el filesystem pero **ya no se muestra** en la página QB.  
El sync de Estimates se maneja desde la página de `draft-orders-advanced`.  
Si se necesita volver a agregar, importar `DraftOrdersSync` y renderizarlo entre Customer Sync y Activity Log.

### Alertas reemplazadas por Toast

El código anterior usaba `window.alert()` para confirmaciones. La versión actual usa `toast.success()` / `toast.error()` de `@medusajs/ui`. No usar `window.confirm()` en el Admin — está silenciosamente bloqueado en el iframe context.

### postConfig helper

```typescript
const postConfig = async (body: Record<string, unknown>) => {
    const res = await fetch('/admin/quickbooks/config', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error((await res.json()).error || 'Failed to save')
}
```

Todos los handlers usan este helper. Si falla, hace throw y el catch en el handler muestra el toast de error.

### refreshTimestamps

Llamado después de cada "Sync Now" exitoso para actualizar los timestamps de "Last sync" sin recargar toda la config:

```typescript
const refreshTimestamps = async () => {
    const { config } = await fetch('/admin/quickbooks/config', { ... }).then(r => r.json())
    if (config.last_inventory_sync) setLastInventorySync(config.last_inventory_sync)
    if (config.last_price_sync) setLastPriceSync(config.last_price_sync)
    if (config.last_customer_sync) setLastCustomerSync(config.last_customer_sync)
}
```

---

**Última actualización:** 2026-03-31  
**Versión:** 2.1 — Legacy QB Data Import feature (Open Sales Orders + Unapplied Payments staging workflow)
