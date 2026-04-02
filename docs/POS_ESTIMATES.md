# POS Estimates — Cotizaciones / Draft Orders
> **Tipo**: Technical Reference
> **Repo**: backend
> **Última verificación**: 2026-04-02
> **Estado**: ✅ Current

---

## ¿Qué es y por qué existe?

El módulo Estimates maneja cotizaciones B2B desde el POS. Un Estimate es un Draft Order en Medusa que se sincroniza como QB Estimate en QuickBooks Desktop. Cuando el cliente aprueba, se convierte a Order y se crea un QB Sales Order.

---

## Arquitectura

```
POS Staff crea Estimate
│
├── 0. [/estimates/new] → objeto local en posStore bajo llave "new"
│        Auto-carga de metadata y direcciones al seleccionar cliente
│
├── 1. POST /admin/draft-orders
│        { customer_id, items, sales_channel_id }
│        → draft_order.id; router.replace('/estimates/draft_xxx')
│
├── 2. [Save] → POST /admin/quickbooks/draft-order
│        { orderId: draft_order.id }
│        → QB Estimate creado via bridge
│        → Metadata: qb_estimate_txn_id, qb_estimate_ref_num
│
├── 3. [Editar líneas, precios, notas → Save vuelve a sincronizar QB]
│
├── 4. [Cliente aprueba] → POST /admin/draft-orders/:id/convert-force
│        → Medusa crea Order confirmada
│
└── 5. POST /admin/quickbooks/order
         { orderId: order.id }
         → QB Sales Order creado (Estimate → SO)
```

---

## Modelo de Datos / Estructura

### Metadata del Estimate (Draft Order)

| Metadata key | Contenido |
|-------------|-----------|
| `estimate_status` | `Created` \| `Sent` \| `Not Approved` \| `Cancelled` |
| `qb_estimate_txn_id` | TxnID del QB Estimate |
| `qb_estimate_ref_num` | Ref # del QB Estimate (ej. "6142") |
| `computed_total` | Total calculado: `(subtotal - discounts) + taxes + shipping` |
| `tax_mode` | `FL_7` \| `EXEMPT` |
| `sales_rep` | Nombre del representante |
| `payment_terms` | Términos de pago |
| `lead_time` | Tiempo estimado de entrega |
| `sort_order` | Orden de líneas de items (persiste via drag-to-reorder) |
| `backlighting_project_id` | ID del proyecto Backlighting vinculado (si aplica) |
| `backlighting_seq_id` | Secuencia dentro del proyecto BL (si aplica) |

### Filtro de Status

Los filtros operan sobre `metadata.estimate_status` (NO sobre `draft_order.status`):

```typescript
// Ocultos por defecto (se activan con toggles):
s !== 'Not Approved' && s !== 'not_approved'
s !== 'Cancelled'    && s !== 'cancelled'
```

---

## Opciones de Dropdowns — `GET /admin/estimate-options`

Los dropdowns del formulario (Sales Rep, Payment Terms, Lead Time, Order Type) se cargan dinámicamente desde la tabla `system_defaults`:

```
GET /admin/estimate-options
→ { payment_terms: string[], lead_times: string[], order_types: string[], sales_reps: SalesRepUser[] }
```

Los valores de `sales_reps` son objetos JSON de filas con `field_name = 'Sales Rep User'` y `context = 'Global'` filtradas por `is_sales_rep: true`.

---

## Flujo de Implementación (UI)

### Columnas de la Tabla de Estimates

| Columna | Fuente |
|---------|--------|
| Ref Num | `display_id` |
| QB Ref # | `metadata.qb_estimate?.ref_number` → fallback `metadata.qb_estimate_ref_num` |
| Date | `created_at` |
| Company | `customer.company_name` |
| Customer | `customer.first_name + last_name` |
| Status | `metadata.estimate_status` (badge coloreado) |
| QB Synced | `Check` verde (tiene `qb_estimate_txn_id`), `Clock` ámbar, `X` rojo |
| Total | `metadata.computed_total` ?? `total / 100` |

### Document Toolbar — Botones principales

| Botón | Endpoints | Condición |
|-------|-----------|-----------|
| Save | `POST /admin/draft-orders` (new) o `POST /admin/draft-orders/:id` (update) → luego QB sync | Siempre disponible |
| Duplicate | Clona en `posStore.startDuplicate()` → navega a `/estimates/new` | Requiere ≥1 ítem |
| Confirm Order | `POST /admin/draft-orders/:id/convert-force` → luego `POST /admin/quickbooks/order` | No reversible |
| Email | Envía estimate via Resend | Requiere save previo |
| Print | Redirige al template render | Siempre disponible |
| Discard | Resetea local state | Solo en `/estimates/new` |

### Backlighting Link

Desde la vista de detalle de un Estimate se puede vincular con un proyecto Backlighting:

```
POST /admin/draft-orders/:id/set-bl-link
Body: { backlighting_project_id: string, backlighting_seq_id?: string | null }

Mergea en metadata del orden (no sobreescribe otros campos).
```

### Navegación Prev/Next

Al hacer click en una fila de la lista:
```typescript
saveEstimateNavList(sorted.map(s => s.id))  // sessionStorage
router.push(`/estimates/${o.id}`)
```
Permite navegar Prev/Next en el detalle sin re-fetchear.

### Precios Offline (availablePrices)

Los precios se pre-fetchean desde MeiliSearch al seleccionar un ítem y se almacenan en `item.availablePrices`. Esto permite cambiar entre "Default" y "Wholesale" en estimates nuevos (`/estimates/new`) antes de guardar en la BD.

---

## API / Interfaces

### Endpoints Backend

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/admin/draft-orders?limit=250&fields=...` | Lista estimates |
| `POST` | `/admin/draft-orders` | Crear estimate |
| `POST` | `/admin/draft-orders/:id` | Actualizar estimate |
| `POST` | `/admin/draft-orders/:id/convert-force` | Convertir a Order con backorder fallback |
| `POST` | `/admin/draft-orders/:id/add-item-force` | Agregar ítem sin validación Medusa |
| `POST` | `/admin/draft-orders/:id/update-item-force` | Actualizar qty/precio |
| `POST` | `/admin/draft-orders/:id/delete-item-force` | Hard delete de línea (no qty=0) |
| `POST` | `/admin/draft-orders/:id/add-shipping-force` | Agregar shipping |
| `DELETE` | `/admin/draft-orders/:id/remove-shipping/:methodId` | Remover shipping |
| `GET` | `/admin/draft-orders/:id/compute-tax` | Calcular y persistir impuesto |
| `GET` | `/admin/draft-orders/:id/variant-prices` | Precios Default + Wholesale por variante |
| `POST` | `/admin/draft-orders/:id/send-email` | Enviar estimate via Resend |
| `POST` | `/admin/draft-orders/:id/set-bl-link` | Vincular con proyecto Backlighting |
| `GET` | `/admin/draft-orders/sync-pos` | Sync masivo de draft orders al POS |
| `GET` | `/admin/estimate-options` | Opciones dinámicas de dropdowns |
| `POST` | `/admin/quickbooks/draft-order` | Crear/actualizar QB Estimate |

---

## Note Presets — Presets de Notas

Las notas de estimates y órdenes pueden rellenarse desde presets predefinidos:

```
GET  /admin/note-presets
     → { presets: NotePreset[] }  (ordenados por group_name, sort_order, title)

POST /admin/note-presets
     Body: { group_name, title, content, sort_order? }

PATCH /admin/note-presets/:id
     Body: { group_name?, title?, content?, sort_order? }

DELETE /admin/note-presets/:id
```

### Tabla `note_presets`

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | UUID | Primary key |
| `group_name` | TEXT | Grupo lógico (ej. "Store Policy", "Scope of Work", "Installation", "Projects") |
| `title` | TEXT | Título corto |
| `content` | TEXT | Texto completo del preset |
| `sort_order` | INT | Orden dentro del grupo |

### Grupos predeterminados (seed automático en primera carga)

| Grupo | Presets incluidos |
|-------|-----------------|
| Store Policy | Payment Terms, Lead Time, Validity, Warranty, Scope Note |
| Scope of Work | Materials Only, Custom Fabrication, Partial Orders |
| Installation | No Service, Assembly – LED Panels, Assembly – Linear |
| Projects | Project Notes |

> La tabla se auto-crea y se siembra en la primera llamada a `GET /admin/note-presets` si no existe. No requiere migración explícita.

---

## Reglas Críticas

- `delete-item-force` usa hard delete (no qty=0) — los "zombie items" a qty=0 están eliminados
- `convert-force` incluye backorder fallback: `allow_backorder=true` en variantes
- `convert-force` aplica `tax_mode` de metadata (FL 7% o EXEMPT) al crear la orden
- El `computed_total` en metadata es la fuente de verdad para los totales en lista (no `draft_order.total`)
- Al re-sincronizar un Estimate con `status: Cancelled`, el bridge recibe `IsActive: true` y el status vuelve a `Created` automáticamente
- `set-bl-link` mergea metadata manualmente — Medusa v2 reemplaza metadata por completo si se usa PATCH nativo

---

## Archivos Clave

| Tipo | Ruta Completa | Propósito |
|------|---------------|-----------|
| API | `backend/src/api/admin/draft-orders/[id]/convert-force/route.ts` | Convert con backorder y tax |
| API | `backend/src/api/admin/draft-orders/[id]/add-item-force/route.ts` | Add ítem bypass |
| API | `backend/src/api/admin/draft-orders/[id]/delete-item-force/route.ts` | Hard delete ítem |
| API | `backend/src/api/admin/draft-orders/[id]/compute-tax/route.ts` | Tax computation + persist |
| API | `backend/src/api/admin/draft-orders/[id]/variant-prices/route.ts` | Dual pricing |
| API | `backend/src/api/admin/draft-orders/[id]/send-email/route.ts` | Email via Resend |
| API | `backend/src/api/admin/draft-orders/[id]/set-bl-link/route.ts` | Vincular proyecto BL |
| API | `backend/src/api/admin/draft-orders/sync-pos/route.ts` | Sync POS estimates |
| API | `backend/src/api/admin/estimate-options/route.ts` | Opciones dinámicas de dropdowns |
| API | `backend/src/api/admin/note-presets/route.ts` | CRUD presets de notas |
| API | `backend/src/api/admin/note-presets/[id]/route.ts` | PATCH + DELETE preset |
| API | `backend/src/api/admin/quickbooks/draft-order/route.ts` | QB Estimate sync |

---

## Historial de Decisiones

- **`computed_total` como fuente de verdad** (2026-03-17): El bug de totales a $0 en lista venía de usar `order.total` primero. El fix fue usar `metadata.computed_total` (escrito por `compute-tax`) como fuente primaria.
- **Hard delete en `delete-item-force`**: Los "zombie items" (qty=0) rompían cálculos en QB. El hard delete resuelve esto permanentemente.
- **Note Presets en tabla propia** (2026-03-09): Se eligió una tabla dedicada con auto-seed para no contaminar `system_defaults` con contenido largo de presets.
- **`set-bl-link` como endpoint dedicado** (2026-04): El PATCH nativo de Medusa reemplaza todo el objeto metadata. El endpoint custom hace merge manual para evitar perder datos.
