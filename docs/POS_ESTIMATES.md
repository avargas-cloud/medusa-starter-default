# POS_ESTIMATES — Estimates / Draft Orders (POS App)

| Campo | Detalle |
|-------|---------|
| **Módulo** | Estimates |
| **Rutas POS** | `/estimates`, `/estimates/[id]`, `/estimates/new` |
| **Medusa** | Draft Orders (`GET /admin/draft-orders`) |
| **QB** | Estimates → Sales Orders |
| **Última revisión** | 2026-03-07 |

---

## Descripción

El módulo de Estimates maneja cotizaciones para clientes B2B desde el POS. Un Estimate es un Draft Order en Medusa que se sincroniza como un **QB Estimate** en QuickBooks Desktop. Cuando el cliente aprueba, se convierte a Order y se crea un **QB Sales Order**.

---

## Flujo Completo

```
POS Staff crea Estimate
│
├── 1. POST /admin/draft-orders
│        { customer_id, items, sales_channel_id }
│        → draft_order.id creado en Medusa
│
├── 2. [Save] → POST /admin/quickbooks/draft-order
│        { orderId: draft_order.id }
│        → QB Estimate creado via bridge
│        → Metadata: qb_estimate_txn_id, qb_estimate_ref_num
│
├── 3. [Opcionales: editar líneas, precios, notas, Save vuelve a sincronizar]
│
├── 4. [Cliente aprueba] → Convert to Order
│        → POST /admin/draft-orders/:id/convert-force
│        → Medusa crea Order confirmada
│
└── 5. POST /admin/quickbooks/order
         { orderId: order.id }
         → QB Sales Order creado (estimate → SO)
```

---

## Dashboard de Estimates (`/estimates`)

**Archivo:** `ecopowertech-store-pos/app/(pos)/estimates/page.tsx`

### Fuente de Datos

- **Primaria:** `GET /admin/draft-orders?limit=250&fields=...` (mismo endpoint del admin panel)
- La lista trae hasta 250 draft orders. Si se necesita más, usar filtros/búsqueda.

### Campos Expandidos en el Fetch

```
id, display_id, status, email, currency_code, total, created_at, metadata,
+customer.first_name, +customer.last_name, +customer.email,
+customer.phone, +customer.company_name,
+sales_channel.name
```

### Columnas de la Tabla

| Columna | Fuente |
|---------|--------|
| Ref Num | `display_id` |
| QB Ref # | `metadata.qb_estimate_ref_num` |
| Date | `created_at` (format: MMM d, yyyy) |
| Company | `customer.company_name` |
| Customer | `customer.first_name + last_name` |
| Email | `customer.email` o `email` |
| Sales Channel | `sales_channel.name` |
| Status | `metadata.estimate_status` (con badge de color) |
| QB Synced | presencia de `metadata.qb_estimate_txn_id` |
| Total | `metadata.computed_total` o `total / 100` |

### Filtros (client-side)

Los filtros operan sobre `metadata.estimate_status` (**NO** sobre `o.status`):

| Filtro | Oculta por defecto | Cómo activarlo |
|--------|-------------------|----------------|
| Not Approved | ✅ sí | Toggle "Show Not Approved" |
| Cancelled | ✅ sí | Toggle "Show Cancelled" |

```ts
// Valores exactos que filtran:
s !== 'Not Approved' && s !== 'not_approved'
s !== 'Cancelled'    && s !== 'cancelled'
```

### Búsqueda

Busca por: `customer name`, `email`, `#display_id`, `phone (solo dígitos)`.

```ts
name.includes(q) || email.includes(q) ||
`#${o.display_id}`.includes(q) ||
(searchDigits.length > 0 && phone.includes(searchDigits))
```

### Sort (client-side)

| Opción | Descripción |
|--------|-------------|
| `display_id_desc` | # (Newest first) — **default** |
| `display_id_asc` | # (Oldest first) |
| `created_at_desc` | Date (Newest) |
| `created_at_asc` | Date (Oldest) |
| `total_desc` | Total (High → Low) |
| `total_asc` | Total (Low → High) |

### Navegación al abrir un Estimate

Al hacer click en una fila, se guarda el array de IDs ordenados en `sessionStorage` antes de navegar:

```ts
saveEstimateNavList(sorted.map(s => s.id))
router.push(`/estimates/${o.id}`)
```

Esto permite el Prev/Next en la página de detalle sin re-fetchear la lista.

---

## Detalle de Estimate (`/estimates/[id]`)

**Archivos:**
- `ecopowertech-store-pos/app/(pos)/estimates/[id]/page.tsx`
- `ecopowertech-store-pos/lib/estimateNav.ts`

### Acciones (DocumentToolbar)

| Botón | Descripción |
|-------|-------------|
| **Prev / Next** | Navegar entre estimates (sorted list) |
| **Save** | Guarda en Medusa + re-sincroniza con QB |
| **Email** | Envía estimate al cliente |
| **Payment** | Captura de pago parcial o total |
| **History** | Ver historial del cliente |

### Prev/Next Navigation

**Estrategia:** sessionStorage + API fallback.

**`lib/estimateNav.ts`:** helpers `saveEstimateNavList(ids)` / `getEstimateNavList()`.

```
sessionStorage key: 'pos_estimate_nav_ids'
Valor: JSON array de IDs ordenados (newest-first = display_id_desc)
```

**Flujo de carga en el detail page:**
1. Lee `getEstimateNavList()` del sessionStorage al montar
2. Si está vacío o el `id` actual no está en la lista → fallback: fetch `GET /admin/draft-orders?limit=250&fields=id,display_id,status,metadata`
3. El fallback excluye Cancelled y Not Approved (igual que la lista)
4. Los IDs resultantes se guardan en sessionStorage y en estado

**Dirección de navegación** (navIds es newest-first):

```
navIds = ['id_1093', 'id_1092', 'id_1091', ...]
          index 0      index 1    index 2

Prev (más antiguo) = navIds[currentIdx + 1]
Next (más reciente) = navIds[currentIdx - 1]
```

**Caso especial `/estimates/new`:**
- `Prev` → `navIds[0]` (estimate más reciente existente)
- `Next` → deshabilitado (nada después de /new)

**Caso especial `navIds[0]` (el más reciente):**
- `Prev` → `navIds[1]` (siguiente más antiguo)
- `Next` → `/estimates/new`

**Prefetch:** cuando se conocen `prevId` y `nextId`, se pre-fetchean
sus datos via `queryClient.prefetchQuery` para navegación instantánea.

### Metadata QB guardada

```json
{
  "qb_estimate_txn_id": "12345",
  "qb_estimate_ref_num": "E18024591",
  "qb_estimate_synced_at": "2026-03-07T...",
  "estimate_status": "Created",
  "computed_total": 56.75
}
```

### Status Values (`metadata.estimate_status`)

| Valor | Badge |
|-------|-------|
| `Created` / `Draft` | gris (neutral) |
| `Sent` | azul |
| `Accepted` | verde |
| `Declined` / `Not Approved` | rojo |
| `Cancelled` | rojo |
| `Expired` / `Pending` | ámbar |

---

## Cancel vs Delete

| Acción | Medusa | QB |
|--------|--------|----|
| **Cancel** | `metadata.estimate_status = 'Cancelled'` | `IsActive: false` en EstimateMod |
| **Delete** | Draft eliminado | `DELETE /quickbooks/draft-order` → IsActive = false |

> ⚠️ Si el cliente rechaza, usar **Cancel** para mantener historial. Delete es permanente.

---

## Re-activate (Re-sync cancelado)

Si un estimate está en `Cancelled` y se vuelve a sincronizar con `force: true`:
- El bridge recibe `IsActive: true` automáticamente → QB Estimate reactivado
- `estimate_status` se resetea a `Created`

---

## Known Issues

| Issue | Fix |
|-------|-----|
| Re-sync falla si QB Estimate fue editado manualmente | Error 3175 del bridge (QB abierto en modo edición) — cerrar el estimate en QB y reintentar |
| Estimate sin QB Ref # | Bridge falló en el primer sync — llamar `POST /quickbooks/draft-order` manualmente |
| Prev/Next deshabilitados al abrir URL directa | El fallback fetcha `/admin/draft-orders` automáticamente. Si `token` no está listo, esperar un segundo y refrescar |
| `metadata.computed_total` vacío | El total se calcula y guarda al hacer Save. Antes del primer Save, el total puede ser `—` en la lista |
