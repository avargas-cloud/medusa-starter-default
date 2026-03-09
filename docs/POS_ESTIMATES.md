# POS_ESTIMATES — Estimates / Draft Orders (POS App)

| Campo | Detalle |
|-------|---------|
| **Módulo** | Estimates |
| **Rutas POS** | `/estimates`, `/estimates/[id]`, `/estimates/new` |
| **Medusa** | Draft Orders (`GET /admin/draft-orders`, `POST /admin/draft-orders`) |
| **QB** | Estimates → Sales Orders |
| **Última revisión** | 2026-03-07 |

---

## Descripción General e Hidratación Híbrida

El módulo de Estimates maneja cotizaciones para clientes B2B desde el POS. Un Estimate es un Draft Order en Medusa que se sincroniza como un **QB Estimate** en QuickBooks Desktop. Cuando el cliente aprueba, se convierte a Order y se crea un **QB Sales Order**.

La persistencia del módulo se basa en un cache local robusto usando `Zustand` (`posStore`) y `localStorage`. Un flujo "Offline-First" permite crear o modificar borradores de forma segura; la sincronización con el servidor ocurre de manera explícita:

1. **Auto-Hydration de Clientes**: Al seleccionar un cliente desde el dropdown (en `new` o draft existente), el POS automáticamente carga sus direcciones predeterminadas (`shipping_address` & `billing_address`) y aplica su canal de venta o grupo de cliente. De esta forma, cada nuevo ítem hereda de manera automática fijaciones de precio (ej. _Wholesale_).
2. **Offline Price Caching (`availablePrices`)**: Previamente el selector de precios requería del endpoint `/admin/draft-orders/:id/variant-prices`. Ahora, la integración pre-fetchea el arreglo directo desde MeiliSearch y lo inserta en `item.availablePrices` al seleccionar un ítem. Esto habilita modificar entre "Default" y "Wholesale" incluso en cotizaciones nuevas (`/estimates/new`) sin haber guardado el borrador en la DB de Medusa aún.

---

## Flujo Completo

```
POS Staff crea Estimate (Local Cache ID: 'new')
│
├── 0. [Navegación /estimates/new]
│        → Crea un objeto en posStore aislado bajo la llave "new"
│        → Auto-carga de metadata y direcciones al escoger cliente en UI
│
├── 1. POST /admin/draft-orders
│        { customer_id, items, sales_channel_id }
│        → draft_order.id creado en Medusa
│        → router.replace('/estimates/draft_etc') evita recarga abrupta de la página
│
├── 2. [Save] → POST /admin/quickbooks/draft-order
│        { orderId: draft_order.id }
│        → QB Estimate creado via bridge
│        → Metadata: qb_estimate_txn_id, qb_estimate_ref_num
│
├── 3. [Opcionales: editar líneas, precios, notas, Save vuelve a sincronizar]
│
├── 4. [Cliente aprueba] → Convert to Order (Botón Confirm Order)
│        → POST /admin/draft-orders/:id/convert-force
│        → Medusa crea Order confirmada (Convierte el draft order permanentemente)
│
└── 5. POST /admin/quickbooks/order
         { orderId: order.id }
         → QB Sales Order creado (estimate → SO)
```

---

## Document Toolbar (Acciones Principales del Estimate)

La barra de herramientas principal (`DocumentToolbar`) concentra el ciclo de vida del borrador directamente desde el componente visual:

| Botón | Acción y Endpoints Asociados | Condicionales o Fallbacks |
|-------|------------------------------|---------------------------|
| **Save** | `POST /admin/draft-orders` (Si es new), `POST /admin/draft-orders/:id` (Actualizamos cart y líneas). Luego avisa a QB Bridge para generar la transacción del lado de QB. | El borrador en el cache de estado cambia de modo "Dirty" a "Saved". |
| **Confirm Order** | `POST /admin/draft-orders/:id/convert-force`. Fuerza la conversión en Medusa, se deshabilita la edición del frontend. Emite al Bridge de QB convertir en un _Sales Order_. | Bloqueará componentes de UI en la página, no es reversible desde Estimates. |
| **Email** | Envía correo del estimate al Customer utilizando la API y el SendGrid Notification Provider. | Requiere que el estimado se guarde primero. |
| **Print** | Redirige al Template Render de impresiones para Estimates comerciales B2B. | Funcionalidad en constante desarrollo visual. |
| **History** | Lanza el timeline / log de auditoría guardado de las interacciones previas con el estimate o el cliente específico. | – |
| **Discard** | Descarta la sesión sin guardar de "new" desde el locale storage y resetea el formulario al estado base vacio. | Exclusivo para `/estimates/new`. |

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

## Detalle de Estimate Avanzado (`/estimates/[id]`)

**Principales Rutas:**
- `ecopowertech-store-pos/app/(pos)/estimates/[id]/page.tsx`
- `ecopowertech-store-pos/app/(pos)/estimates/new/page.tsx` (Reutiliza la misma estructura)

### Arquitectura de Archivos y Fragmentación de Hooks

Para promover escalabilidad y limpieza de código en la página de detalle, la lógica monolítica fue dividida en múltiples "Custom Hooks" y componentes aislados dentro del directorio `/estimates/[id]/`:

- **Hooks Especializados (`/hooks/`):**
  - `useEstimateData.ts`: Encargado exclusivamente del fetch de Medusa (`GET /draft-orders/:id`) usando React Query y devolviendo el estado de la carga.
  - `useEstimateActions.ts`: Contiene la lógica transaccional de los botones del Toolbar (Save, Print, Confirm Order, Email) comunicándose con los endpoints de Medusa y QB Bridge.
  - `useEstimateNavigation.ts`: Administra el almacenamiento persistente (`sessionStorage`) del array de UUIDs para proveer desplazamiento con Prev/Next.
  - `useEstimate.tsx`: Orquestador principal que consolida los hooks anteriores, inicializa el `posStore` (layer local de Drafts) y expone la Interfaz unificada a la Vista (`page.tsx`).

- **Componentes (`/components/`):**
  - `CustomerStrip.tsx`: Desacopla visual y funcionalmente la primera fila del documento (el buscador de cliente, la direcciones y fecha de validez). Alberga toda la lógica de auto-hidratación descrita previamente, inyectando las direcciones físicas y niveles de preció (sales channels) al seleccionar al cliente objetivo.

---

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

## Mejoras Funcionales y Troubleshooting (Marzo 2026)

Esta sección consolida resoluciones a bugs complejos de interfaz y lógica resueltos recientemente durante el flujo de trabajo de creación B2B:

1. **Bug: Duplicación de Stock en MeiliSearch (`ItemSearch`)**
   - **Contexto:** Se detectó repetidamente que todos los ítems resultantes de la barra de búsqueda compartían la misma cifra de inventario (ej. "todos en 27 unidades").
   - **Solución Táctica:** En el archivo `lib/meilisearch.ts` (índice avanzado `searchAdvancedInventory`), se añadió el requerimiento lógico subyacente de traer el atributo `variantId` omitido previamente. Esta ausencia hacía que la llave dinámica `stockMap[undefined]` sobrescribiera universalmente la referencia para todos los elementos iterados por la tabla, por ende todas las filas heredaban el índice del último elemento fetcheado de Medusa.
   - Adicionalmente, se corrigió el querystring de fetch a la API nativa de `/admin/inventory-items` migrando el parámetro roto `sku[]=` hacia `sku=` directo.

2. **Flujo de Inventario Detallado en Popover Local (`InventoryPopover`)**
   - **Contexto:** Posibilidad de verificar stock sin salir de los estimados actuales para agilizar confirmaciones (mismo ux que admin dashboard). 
   - **Implementación:** Se agregó en `components/pos/LineItemsTable.tsx` un icono de "Home" que, usando un React Hook `useQuery`, desencadena interacciones a `/admin/inventory-items` y luego `/location-levels` del id resultante de manera anidada en segundo plano con *staleTime: 60_000*. Emite un recuadro React Portal de UI limpio y preciso reportando `locName` y `available`.

3. **Restricción Clipping a Menú de Precios (`PriceDropdown`)**
   - **Troubleshooting:** Elementos en `overflow: hidden` cortaban la ventana contextual impidiendo elegir opciones de Wholesale/Customer levels.
   - **Fix Definitivo:** Implementación de `react-dom.createPortal()` para desterrar los popups visuales del árbol DOM delimitado de Line Items. La función `getBoundingClientRect()` se alió a la refacturización para calcular top/left relativos, posicionando el control en `zIndex: 9999` bajo viewport base (`document.body`).

4. **El Fallback Local (Offline) de Precios Alternos (`availablePrices`)**
   - **Troubleshooting:** `/estimates/new` al carecer del Id persistido en medusa no autorizaba el backend de Prices a devolver combinaciones.
   - **Fix Arquitectónico:** Agregación global a la estructura transitoria `store/posStore.ts` del vector opcional `availablePrices`. Este almacena los sets de precios generados directamente por MeiliSearch en el frontend (sin backend), y se lo entrega al `PriceDropdown` como set estático. El usuario ahora puede configurar wholesale antes del primer click a 'Save'.

5. **Integración de Tax Mode y Tax Exemption B2B**
   - **Contexto:** Se necesitaba abstraer el cálculo manual de impuestos e integrarse con el estatus real de Exención Fiscal (Tax Exempt) de los clientes B2B traídos de QuickBooks.
   - **Fix:** Refactorización de la lógica del Checkout en `posStore.ts` y la vista visual `OrderSummary.tsx`. Se migró de variables numéricas libres (`taxRate: 7`) a un Enum estricto `taxMode: 'auto' | 'florida' | 'exempt'`.
   - Si un cliente tiene metadata `is_tax_exempt: 'Yes'`, los selectores visuales cambian automáticamente a 'exempt', forzando tax a 0% visualmente e inyectando `tax_mode` en el payload final de Medusa para respetar la sincronización contable.

6. **Unificación Frontend de System Defaults (`EstimateMetaFields`)**
   - **Contexto:** Los dropdowns administrativos de _Lead Time_, _Order Type_, _Payment Terms_ y _Status_ estaban dispersos y usaban hardcodings en algunos modales.
   - **Integración:** El componente `EstimateMetaFields.tsx` ahora se alimenta nativamente del endpoint `GET /admin/system-defaults` a través de `useQuery`, absorbiendo dinámicamente cualquier cambio jerárquico que suceda en el Admin.

7. **Corrección: Save as Default (Sales Rep)**
   - **Resolución:** El front-end del POS en los "Meta Fields" intentaba empujar el guardado por defecto al objeto del cliente bajo una llave errónea (`default_sales_rep`), mientras que el Admin lo leía bajo `default_rep`. Se unificó `CUSTOMER_META_KEYS` para que el POS grabe y pre-llene la llave universal `default_rep`. El widget `↑ Save as default` ahora aparece de manera inteligente respetando el scope global.

8. **Hard Reset Completo en "Discard"**
   - **Contexto:** Al hacer click en el botón `Discard` de una sesión temporal `/estimates/new`, el estado local (items y sumatorias) persistía provocando ítems fantasma en futuros Draft Orders.
   - **Fix:** Se vinculó el action click al hook nativo `resetDocument()` interno del `usePOSStore`, garantizando la limpieza total a estado zero del Cache Local en `localStorage`.

---

## Known Issues Generales

| Issue | Fix |
|-------|-----|
| Re-sync falla si QB Estimate fue editado manualmente | Error 3175 del bridge (QB abierto en modo edición) — cerrar el estimate en QB y reintentar |
| Estimate sin QB Ref # | Bridge falló en el primer sync — llamar `POST /quickbooks/draft-order` manualmente |
| Prev/Next deshabilitados al abrir URL directa | El fallback fetcha `/admin/draft-orders` automáticamente. Si `token` no está listo, esperar un segundo y refrescar |
| `metadata.computed_total` vacío | El total se calcula y guarda al hacer Save. Antes del primer Save, el total puede ser `—` en la lista |
