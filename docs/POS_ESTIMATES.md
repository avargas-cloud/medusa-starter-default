# POS_ESTIMATES — Estimates / Draft Orders (POS App)

| Campo | Detalle |
|-------|---------|
| **Módulo** | Estimates |
| **Rutas POS** | `/estimates`, `/estimates/[id]`, `/estimates/new` |
| **Medusa** | Draft Orders (`GET /admin/draft-orders`, `POST /admin/draft-orders`) |
| **QB** | Estimates → Sales Orders |
| **Última revisión** | 2026-03-10 |

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
   - **Fix:** Refactorización de la lógica del Checkout en `posStore.ts` y la vista visual `OrderSummary.tsx`. Se migró de variables numéricas libres (`taxRate`) a un Enum estricto `taxMode: 'florida' | 'exempt'`.
   - Si un cliente tiene metadata `is_tax_exempt: 'Yes'`, los selectores visuales cambian automáticamente a 'exempt', forzando tax a 0% visualmente e inyectando `tax_mode` en el payload final de Medusa para respetar la sincronización contable.

6. **Unificación Frontend de System Defaults (`EstimateMetaFields`)**
   - **Contexto:** Los dropdowns administrativos de _Lead Time_, _Order Type_, _Payment Terms_ y _Status_ estaban dispersos y usaban hardcodings en algunos modales.
   - **Integración:** El componente `EstimateMetaFields.tsx` ahora se alimenta nativamente del endpoint `GET /admin/system-defaults` a través de `useQuery`, absorbiendo dinámicamente cualquier cambio jerárquico que suceda en el Admin.

7. **Corrección: Save as Default (Sales Rep)**
   - **Resolución:** El front-end del POS en los "Meta Fields" intentaba empujar el guardado por defecto al objeto del cliente bajo una llave errónea (`default_sales_rep`), mientras que el Admin lo leía bajo `default_rep`. Se unificó `CUSTOMER_META_KEYS` para que el POS grabe y pre-llene la llave universal `default_rep`. El widget `↑ Save as default` ahora aparece de manera inteligente respetando el scope global.

8. **Hard Reset Completo en "Discard"**
   - **Contexto:** Al hacer click en el botón `Discard` de una sesión temporal `/estimates/new`, el estado local (items y sumatorias) persistía provocando ítems fantasma en futuros Draft Orders.
   - **Fix:** Se vinculó el action click al hook nativo `resetDocument()` interno del `usePOSStore`, garantizando la limpieza total a estado zero del Cache Local en `localStorage`.

9. **Gestor Avanzado de Direcciones B2B (`AddressModal` & `AddressBookOptions`)**
   - **Contexto:** Al editar la dirección física dentro del Estimate, los comerciantes debían poder discernir si el cambio aplicaba singularmente de una vez para esa cotización, o si afectaba la libreta de direcciones permanente del cliente.
   - **Fix:** Se modularizó el componente `AddressModal.tsx` (Patrón Barrel) aislando la vista del formulario (`AddressFormFields`) de la lógica condicional de guardado (`AddressBookOptions`).
   - Se introdujeron 3 opciones nativas cuando un cliente asocia direcciones predefinidas: 
     1. Actualizar sólo este borrador (No afectar el Book de la DB).
     2. Sobreescribir el Record central y este Borrador.
     3. Conservar la anterior y crear un nuevo Record bajo una etiqueta personalizada (`e.g "Warehouse"`).

10. **Refactor de Cotización de Envíos (`ShippingModal`)**
    - **Contexto:** Se necesitaba abstraer la lógica rígida de Shipping y soportar UPS + Métodos planificados de Tienda B2B.
    - **Fix:** El `ShippingModal` ahora pre-evalúa automáticamente la elegibilidad de *Envío Gratis (Free Ground Shipping)* interceptando `/admin/shipping-settings` y comparando el Subtotal del carrito. 
    - Se integró la API `admin/ups-rate-preview` exigiendo validación estricta de Código Postal (`postal_code`) para mostrar un formulario en-línea (Inline Address Form) si el cliente o el borrador carecen de éste, evitando llamadas fallidas.

11. **Descuentos y Promociones Transaccionales (`PromotionsModal` & `PromotionStrip`)**
    - **Contexto:** Habilitar descuentos centralizados B2B directos sobre el Order Total.
    - **Fix:** Integración de la UI híbrida que soporta tanto Códigos Promocionales pre-fabricados en el sistema (via `GET /admin/pos-promotions`), como **Descuentos Customizados (Manuales)** en tarifa Fija ($) o Porcentual (%), enviando el payload directamente a `/admin/pos-discount`.

12. **Line-Item Discounts (Descuentos Individuales por Producto)**
    - **Contexto:** Permitir al Staff rebajar un renglón en particular por fuera de su *Price List* genérica sin afectar la orden entera.
    - **Fix:** Dentro de `LineItemsTable.tsx` se construyó un Popover-Portal de `Line Discount`. Modifica el cache local (`_discountTotal`) sumando deducciones en % o Fixed rate que el `posStore.ts` luego computa en la base `_afterLineDiscountTotal` para reflejar con un tachado (*strikethrough*) el precio base al renderizado.

13. **Plantillas Rápidas para Notas (`NoteArea` & `QuickNotesModal`)**
    - **Contexto:** Los Estimates B2B requieren cláusulas legales o de alcance de trabajo que demoran en escribirse manualmente.
    - **Fix:** Se integró un Gestor de Plantillas Rápidas inyectando llamadas nativas a `/admin/note-presets`. Esto abre un portal que clasifica jerárquica y localmente por `group_name` (*Store Policy, Installation, Scope of Work*), permitiendo al usuario inyectar bloques gigantes de contenido al textarea nativo con un solo click (`appendNote`).

---

## Known Issues Generales

| Issue | Fix |
|-------|-----|
| Re-sync falla si QB Estimate fue editado manualmente | Error 3175 del bridge (QB abierto en modo edición) — cerrar el estimate en QB y reintentar |
| Estimate sin QB Ref # | Bridge falló en el primer sync — llamar `POST /quickbooks/draft-order` manualmente |
| Prev/Next deshabilitados al abrir URL directa | El fallback fetcha `/admin/draft-orders` automáticamente. Si `token` no está listo, esperar un segundo y refrescar |
| `metadata.computed_total` vacío | El total se calcula y guarda al hacer Save. Antes del primer Save, el total puede ser `—` en la lista |

---

## Changelog — Marzo 10, 2026

### 14. `sales_description` por Variante (QB SalesDesc)

**Problema:** El POS y el admin mostraban el título genérico del producto en lugar de la descripción de venta específica del SKU proveniente de QuickBooks.

**Fix:**
- `variant.metadata.sales_description` ← migrado via `migrate-variant-sales-descriptions.ts` (prioridad QB Bridge → fallback product-level)
- `product.metadata.sales_description` → limpiado (ya no se usa)
- `useEstimateData.ts` → hidrata `salesDescription` desde `i.variant?.metadata?.sales_description` primero, fallback a `i.metadata?.sales_description`
- `LineItemsTable.tsx` → muestra `salesDescription` como descripción principal en la tabla del POS
- MeiliSearch re-indexado con 2,431 items actualizados

### 15. Hard Delete de Line Items (No más Zombie Items)

**Problema:** `delete-item-force` ponía `quantity = 0` en lugar de eliminar el item. Esto causaba "zombie items" visibles en el POS.

**Fix:**
- `delete-item-force/route.ts` → ahora usa `orderModule.deleteOrderLineItems()` (hard delete real)
- Soporta tanto `DELETE` como `POST` para compatibilidad con POS y admin panel
- `useEstimateData.ts` → filtro de seguridad: `.filter(i => i.quantity > 0)` en la hydration
- Items con `quantity === 0` nunca aparecen en el POS, aunque queden en la BD por alguna razón

### 16. Drag-to-Reorder con `sort_order` Persistente

**Funcionalidad:** El usuario puede arrastrar items para reordenarlos en el POS. El orden se persiste en Medusa y es respetado en el admin panel.

**Arquitectura:**

| Capa | Cambio |
|------|--------|
| `POSLineItem` (`posStore.ts`) | Campo `sortOrder?: number` (0-indexed) |
| `posStore.reorderItems(activeId, overId)` | Acción de drag: reordena array y normaliza índices |
| `LineItemsTable.tsx` | `@dnd-kit/sortable` con `GripVertical` handle en hover (izquierda del trash) |
| `useEstimateData.ts` | Ordena items por `metadata.sort_order` ascendente al hidratar |
| `useEstimateActions.ts` | Incluye `sort_order` en `update-item-force` y `add-item-force` al guardar |
| `add-item-force/route.ts` | Guarda `sort_order` en `line_item.metadata` |
| `update-item-force/route.ts` | Acepta `sort_order`, lo mergea en metadata (preserva `sales_description`) |
| Admin `InlineItemsTable.tsx` | Ordena items por `metadata.sort_order` antes de renderizar |

**Flujo de drag:**
1. Usuario arrastra fila → `reorderItems(activeId, overId)` reordena el array local
2. `sortOrder` indices se normalizan a `0, 1, 2…` en el store
3. Al hacer Save → `update-item-force` envía `sort_order` de cada item
4. Al recargar → `useEstimateData` ordena por `metadata.sort_order` → orden restaurado
5. Admin panel → `InlineItemsTable` también ordena por `metadata.sort_order`

### 17. Custom Titles & Descriptions (Override nativo)

**Contexto:** Los Estimates B2B requieren a menudo cambiar temporalmente el título de un ítem listado ("Special Item") o alterar profundamente su descripción de ventas por defecto.
**Implementación:**
- Se exponen `custom_title` y `custom_description` en el API de `add-item-force` y `update-item-force`.
- Si se proporcionan, estos campos inyectan metadatos y sobreescriben `item.title` temporalmente sin mutar el Product nativo en la base de datos de Storefront.
- El POS UI en `LineItemsTable.tsx` permite editar `title` y `salesDescription` localmente si el producto está marcado como "Editable" (ej. items especiales configurados para uso manual).
- `handleSave` identifica si difieren del original y empuja los overrides al endpoint.

### 18. Consolidación de Descuentos (Order & Line-Level)

**Implementación Híbrida de Promociones:**
- **Order Level:** Se creó un endpoint nativo `POST /admin/pos-discount` para insertar y/o crear códigos de descuento "sobre la marcha" en Medusa (Fixed Amount `$` o Percentage `%`). Si ya existe un código promocional estático (ej. `ORDER-DISCOUNT-10%`), se llama a la ruta `POST /admin/pos-discount/apply-existing`. Todo esto permite aplicar descuentos masivos en un solo click desde `PromotionStrip`.
- **Line Level:** Calculado visualmente en el UI local `posStore` en las variables `_discountTotal` y `_afterLineDiscountTotal` para fines estéticos, permitiendo ajustar los `unitPrice` directamente. Durante el Save, los custom prices (calculados tras aplicar el descuento de línea local) reemplazan el `unit_price`, afectando la suma sin requerir módulos masivos de promociones por línea para Estimates temporales.

### 19. Comment Lines / Section Headers (Interleaving)

**Contexto:** Necesidad de intercalar cabeceras descriptivas (ej. "Area 1", "Installation Fees") visualmente *entre* los items reales, y que esto viaje íntegro hasta QuickBooks.
**Arquitectura:**
1. Se definió `POSCommentLine { localId, text, sortOrder }` en el store.
2. La vista hace un "Merged Array" (`useMemo`) entre items y comentarios, lo ordena por `sortOrder` y el UI de `@dnd-kit/sortable` permite agarrar, soltar e intercalar indiscriminadamente entre renglones de descripción pura y renglones de productos.
3. Al guardar (`useEstimateActions.ts`), las líneas de comentario reales se filtran y empaquetan en el array y se guardan intactas en `draftOrder.metadata.pos_comment_lines`.
4. Al recargar (`useEstimateData.ts`), se extraen de la metadata y se resucitan en el UI intercalándose dinámicamente según `sort_order`.

### 20. Confirm Order Flow & Unsaved Changes Modal

**Bloqueo Inteligente:**
- **isDirty Guardian:** Se detectó que convertir el Draft a Order sin presionar `Save` causaba pérdida de datos locales. La mitigación implementada inyecta una validación en `handleConfirmOrder` (`useEstimateActions.ts` vs `page.tsx`).
- Si el store del POS detecta `isDirty: true`, lanza un `ConfirmModal` amarillo exigiendo un "Save & Confirm" atómico.
- **Convert-Force Nativo:** Una vez todo guardado, se pulsa `POST /admin/draft-orders/:id/convert-force`, que llama eficientemente la rutina nativa de Medusa, preservando todo (custom prices, metadata description override, address metadata, discount promos, y *pos_comment_lines*) durante su ascenso a *Sales Order*.

### 21. Sincronización Avanzada a QuickBooks

**Traducción del Payload:**
- La capa de QB Bridge no posee un equivalente 1:1 para "Comments". Para solventar esto, se refactorizó masivamente la función constructora `buildQbItems` en `order-flow-core.ts`.
- La función ahora extrae iterativamente `metadata.pos_comment_lines`. Luego, compara iterativamente los `_sortOrder` entre los ítems reales del producto y estas líneas fantasmas. 
- Genera Items de QB con esquema `{ ItemRef: undefined, Desc: comment.text, noSite: true }`. Esto envía instructivos *Desc-only* puros a Quickbooks Desktop. Su ubicación relativa se conserva milimétricamente.
- Exclusión condicional general de `POS`: Actualmente blindado por `POS_SALES_CHANNEL_ID` en `qb-order-subscriber.ts` evitando envíos automáticos no solicitados del POS hasta autorizar su manual sync.

---

## Changelog — Marzo 10, 2026 (Sesión 2)

### 22. Activity Log — Corrección de Endpoint y Timestamps

**Problema:** El Activity Log usaba `/admin/notes` (endpoint legacy) y mostraba el timestamp incorrecto para "Order placed" (usaba `created_at` del draft, que podía ser días o semanas viejo).

**Fix implementado:**
- Endpoint corregido a `GET /admin/orders/{id}/changes` (nativo Medusa v2)
- El componente `ActivityLog.tsx` recibe `context: 'estimate' | 'order'`
- Evento ancla según contexto:
  - `context='estimate'` → **"Estimate created"** (usa `order.created_at`)
  - `context='order'` → **"Sales Order created"** (usa `metadata.confirmed_at` → fallback `order.created_at`)
- Nombre del admin visible en cada entrada via `/api/pos/admin-user?id={userId}`

**Props en Estimates page.tsx:**
```tsx
<ActivityLog
    medusaId={estimate.doc.medusaId}
    metadata={estimate.order?.metadata}
    createdAt={estimate.order?.created_at}
    context="estimate"
/>
```

---

### 23. `confirmed_at` — Timestamp Real de Conversión

**Problema:** Medusa preserva el `created_at` del draft original al convertir a order. Un draft creado hace 2 semanas mostraría "Order placed: 2 weeks ago" — incorrecto.

**Fix:** Después del `convert-force` en `useEstimateActions.ts → handleConfirmOrder`:

```ts
const res = await medusaFetch(
    `/admin/draft-orders/${doc.medusaId}/convert-force`,
    { method: 'POST', token }
)
const newOrderId = res.order?.id

// ⚠️ CRITICAL: write confirmed_at for correct Activity Log timestamp
if (newOrderId && token) {
    await medusaFetch(`/admin/orders/${newOrderId}`, {
        method: 'POST', token,
        body: { metadata: { confirmed_at: new Date().toISOString() } }
    }).catch(() => {/* non-critical */})
}
```

---

### 24. BulkDiscountModal — Descuentos Masivos por Línea

**Botón "Discounts"** (ámbar, ícono `Tag`) en el toolbar de items → abre `components/pos/BulkDiscountModal.tsx`.

**⚠️ REGLA CRÍTICA:** Usar `updateItemDiscount`, NUNCA `updateItemPrice`:

```ts
// ✅ CORRECTO — aplica lineDiscount con indicador visual de tachado
usePOSStore.getState().updateItemDiscount(localId, 'percent', 5)
usePOSStore.getState().updateItemDiscount(localId, 'fixed', 10)
// Nota: enum es 'percent' | 'fixed' (NO 'pct')

// ❌ INCORRECTO — cambia el precio base sin mostrar descuento
usePOSStore.getState().updateItemPrice(localId, newPrice, priceListId, label)
```

**Wiring completo en estimates page.tsx:**

```tsx
const [discountModalOpen, setDiscountModalOpen] = useState(false)

// Toolbar:
<button onClick={() => setDiscountModalOpen(true)}
        disabled={estimate.doc.items.length === 0}>
    <Tag /> Discounts
</button>

// JSX final:
<BulkDiscountModal
    open={discountModalOpen}
    onClose={() => setDiscountModalOpen(false)}
    items={estimate.doc.items.map(item => ({
        id: item.localId,
        sku: item.sku ?? undefined,
        title: item.title ?? '',
        description: item.salesDescription ?? null,
        thumbnail: item.thumbnail ?? null,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        existingDiscount: item.lineDiscount ?? null,
    }))}
    onApply={(updates) => {
        updates.forEach(({ itemId, discountType, discountValue }) => {
            const item = estimate.doc.items.find(i => i.localId === itemId)
            if (item) usePOSStore.getState().updateItemDiscount(
                item.localId, discountType, discountValue
            )
        })
    }}
/>
```

**Detalles de implementación del modal:**

1. **Init checkboxes** — `useEffect` resetea `selected`, `value`, `mode` cuando `open = true`. Sin esto los checkboxes aparecen vacíos (bug de timing de estado).

2. **Quick Presets** (franja indigo entre config y lista de items):
   - Botones: `LEG · 2.5%`, `LEG · 5%`, `LEG · 7.5%`
   - Click → selecciona SOLO items cuyo SKU empieza con `LEG` + fija el valor
   - Muestra count `(N)` de items coincidentes; deshabilitado si N = 0

3. **Sistema de 2 badges por item:**
   - 🟡 **Amber** `"5% off"` — siempre visible cuando item tiene `lineDiscount` existente
   - 🔴 **Red** `"↳ will be replaced"` — solo cuando el item está seleccionado Y `numValue > 0`

4. **Preview de precio en columna derecha:**
   - Sin valor nuevo: verde `→ $46.13 −10%` (descuento existente)
   - Con valor nuevo escrito: emerald `→ $XX.XX −Y%` (tiene prioridad)

---

### 25. Items Toolbar — Diferencia Estimates vs Orders

| Botón | Estimates | Orders |
|-------|-----------|--------|
| `ItemSearch` | ✅ | ✅ |
| `Categories` | ✅ | ❌ |
| `Comment` | ✅ | ❌ |
| `Discounts` (BulkDiscountModal) | ✅ | ❌ |
| `Expand` (Maximize2, far-right) | ✅ | ✅ |

**Razón:** Orders son órdenes confirmadas — modificaciones van por Order Edit de Medusa, no por POS.

**Layout Estimates:**
```tsx
<Package /> Items (N) | <ItemSearch /> | Categories | Comment | Discounts | <div flex-1/> | <Maximize2 />
```
**Layout Orders (read-only):**
```tsx
<Package /> Items (N) | <ItemSearch /> | <Maximize2 />
```

---

### 26. LineItemsTable — Headers de Texto

Headers cambiados de íconos a texto para mayor claridad profesional:

```tsx
// ✅ Actual
Img | SKU | Description | Qty | Stk | Price | Total | % Disc.

// Solo íconos conservados:
<GripVertical />  // drag handle
<Trash2 />        // eliminar
```

Aplica tanto en Estimates como en Orders (mismo `LineItemsTable.tsx`).

---

### 27. SendEstimateModal — Integración de Email

Botón **"Email"** en `DocumentToolbar` (`onEmail` prop) → `SendEstimateModal.tsx`.

```tsx
<SendEstimateModal
    open={emailModalOpen}
    onClose={() => setEmailModalOpen(false)}
    orderId={estimate.doc.medusaId ?? ''}
    displayId={estimate.order?.display_id ?? ''}
    customerEmail={estimate.doc.customerEmail ?? undefined}
    onSuccess={() => {
        // Invalida Activity Log para mostrar evento "Email sent"
        queryClient.invalidateQueries({ queryKey: ['order-changes', estimate.doc.medusaId] })
        queryClient.invalidateQueries({ queryKey: ['estimate', estimate.doc.medusaId] })
    }}
/>
```

Después del envío, se escribe en `order.metadata`:
```json
{
  "estimate_sent_at": "2026-03-10T20:00:00Z",
  "estimate_sent_to": "customer@email.com",
  "estimate_sent_by": "admin_user_id"
}
```

---

## REFERENCIA TÉCNICA EXHAUSTIVA

> Esta sección documenta el código fuente completo para que un desarrollador pueda implementar o mantener el módulo sin necesidad de leer los archivos fuente.

---

## A. posStore — Tipos Completos

**Archivo:** `store/posStore.ts`  
**Persistencia:** Zustand + `localStorage` (clave: `pos-documents`)  
**Cache máximo:** 20 documentos simultáneos (el slot `'new'` nunca se evicta)

### A.1 POSAddress

```ts
export interface POSAddress {
    id?: string | null           // Medusa address ID (si viene de libreta de direcciones)
    first_name?: string
    last_name?: string
    company?: string
    address_1?: string
    address_2?: string
    city?: string
    province?: string
    postal_code?: string
    country_code?: string        // siempre lowercase, ej. 'us'
    phone?: string
}
```

### A.2 POSLineItem

```ts
export interface POSLineItem {
    localId: string             // temp ID = UUID local; reemplazado por Medusa line_item.id al guardar
    variantId: string           // Medusa variant ID
    productId: string           // Medusa product ID
    title: string               // nombre del producto, editable vía updateItemText()
    variantTitle: string        // descripción de la variante (tamaño, color, etc.)
    sku: string                 // SKU de QuickBooks
    thumbnail: string | null    // URL de imagen (o null)
    salesDescription: string | null  // variant.metadata.sales_description (QB SalesDesc por SKU)
    options?: { title: string; value: string }[]  // opciones de variante (excluye 'Default Title')
    lineDiscount?: { type: 'percent' | 'fixed'; value: number }  // descuento inline; NO usar 'pct'
    quantity: number
    unitPrice: number           // en DÓLARES (ej. 51.25 = $51.25). NUNCA en centavos.
    priceListId: string | null  // si tiene precio de lista aplicado
    priceListLabel: string      // 'Default' | 'Wholesale' | nombre del price list
    availablePrices?: { id: string | null; label: string; amount: number }[]  // no marca dirty
    _discountTotal?: number          // calculado por computeTotals(), solo lectura visual
    _afterLineDiscountTotal?: number // calculado por computeTotals(), solo lectura visual
    _baseTotal?: number              // calculado por computeTotals(), solo lectura visual
    sortOrder?: number          // índice 0-based; persistido en line_item.metadata.sort_order
}
```

> **Unidad de precio:** El comentario original en el store decía "cents" pero es incorrecto. El store usa DÓLARES. El endpoint `add-item-force` también espera dólares. No hacer conversión.

### A.3 POSCommentLine

```ts
export interface POSCommentLine {
    localId: string       // UUID local, solo frontend
    text: string          // contenido de la sección/header
    sortOrder: number     // comparte espacio de sortOrder con items; determina posición en merge
}
```

> Comment lines NO tienen precio ni SKU. En QB se traducen como `DescOnly` items (sin ItemRef).

### A.4 POSDocument

```ts
export interface POSDocument {
    medusaId: string | null      // null = no guardado aún en Medusa
    type: 'estimate' | 'order'
    customerId: string | null
    customerName: string
    customerCompany: string
    customerPhone: string
    customerEmail: string
    shippingAddress: POSAddress | null
    billingAddress: POSAddress | null
    shippingAddressId: string | null   // compat con payload Medusa
    items: POSLineItem[]
    commentLines: POSCommentLine[]    // sección/headers QB-style; separados de items
    discountType: 'percent' | 'fixed' // descuento a nivel orden (PromotionStrip)
    discountValue: number
    note: string                    // metadata.pos_notes
    shippingOptionId: string | null
    shippingOptionName: string | null
    shippingPrice: number           // en DÓLARES (ej. 14.90 = $14.90)
    estimateStatus: string          // 'Created' | 'Sent' | 'Accepted' | etc.
    leadTime: string                // metadata.lead_time
    paymentTerms: string            // metadata.payment_terms
    orderType: string               // metadata.order_type
    projectName: string             // metadata.project_name
    customerPO: string              // metadata.customer_po
    salesRep: string                // metadata.sales_rep
    taxEnabled: boolean
    taxRate: number                 // 7 = 7%, pero la lógica real usa taxMode
    taxMode: 'auto' | 'florida' | 'exempt'
    lastSavedAt: string | null
    promotionCode: string | null    // código del descuento de orden aplicado
    promotionId: string | null      // ID del promotion en Medusa
}
```

### A.5 POSState — Acciones Completas

```ts
interface POSState {
    doc: POSDocument
    currentDocId: string          // 'new' | 'dorder_xxx'
    isDirty: boolean              // true = hay cambios no guardados
    isSaving: boolean             // true = save en progreso (deshabilita botón Save)
    draftCache: Record<string, { doc: POSDocument; isDirty: boolean }>

    // ── Navegación entre documentos ──────────────────────────────────────────
    switchDoc(id: string): void
    // Guarda el doc actual en draftCache y carga el doc destino.
    // Si el doc destino no tiene cache, inicia con defaultDocument().
    // El slot 'new' NUNCA se evicta del cache — es la única excepción.
    // MAX_CACHE_SIZE = 20 slots (los más viejos se eliminan primero).

    // ── Mutaciones de documento ───────────────────────────────────────────────
    setDocument(patch: Partial<POSDocument>): void     // marca isDirty = true
    hydrateDocument(doc: POSDocument): void            // NO marca dirty (viene del server)
    resetDocument(): void                              // vuelve a defaultDocument() + dirty = false

    // ── Items ─────────────────────────────────────────────────────────────────
    addItem(item: Omit<POSLineItem, 'localId'>): void
    // Genera localId con tempId(), sortOrder = doc.items.length (append al final)

    removeItem(localId: string): void

    reorderItems(activeId: string, overId: string): void
    // Hace un merge de items + commentLines por sortOrder, reordena en el merge,
    // y asigna nuevos sortOrders desde las posiciones resultantes.
    // Funciona con drag-and-drop ENTRE items y comment lines (pueden intercalarse).

    updateItemQty(localId: string, quantity: number): void
    updateItemPrice(localId: string, unitPrice: number, priceListId: string | null, label: string): void
    // ⚠️ SOLO para cambiar el precio base. NO usar para descuentos.

    updateItemText(localId: string, title: string, salesDescription: string): void

    updateItemDiscount(localId: string, discountType: 'percent' | 'fixed', value: number): void
    // ✅ Usar este para BulkDiscountModal y línea inline. Actualiza lineDiscount.

    removeItemDiscount(localId: string): void
    // Elimina lineDiscount del item (restaura precio base visual)

    enrichItemPrices(localId: string, availablePrices: {...}[]): void
    // Agrega opciones de precio al item SIN marcar isDirty. Solo para display.

    // ── Comment lines ──────────────────────────────────────────────────────────
    addCommentLine(): void
    // sortOrder = max(todos los sortOrders) + 1; se agrega al final del merge.

    removeCommentLine(localId: string): void
    updateCommentLine(localId: string, text: string): void

    // ── Control de guardado ────────────────────────────────────────────────────
    markSaved(medusaId: string): void
    // Actualiza doc.medusaId + doc.lastSavedAt + isDirty = false

    setIsSaving(v: boolean): void

    discardDraft(docId: string): void
    // Elimina el slot del draftCache. Si es el doc activo, también pone isDirty = false.
}
```

---

## B. computeTotals — Fórmula de Totales

**Archivo:** `store/posStore.ts` (función exportada, línea 417)

```ts
export function computeTotals(doc: POSDocument): {
    subtotal: number
    lineDiscountsTotal: number
    orderDiscount: number
    totalDiscount: number
    shipping: number
    tax: number
    total: number
    afterDiscount: number
    itemsWithTotals: (POSLineItem & { _baseTotal, _discountTotal, _afterLineDiscountTotal })[]
}
```

**Fórmula exacta (en orden de aplicación):**

```
1. Por cada item:
   baseTotal = unitPrice × quantity
   
   Si lineDiscount.type === 'percent':
     effectiveUnitPrice = unitPrice × (1 - value/100)
   Si lineDiscount.type === 'fixed':
     perUnitDeduction = value / quantity
     effectiveUnitPrice = max(0, unitPrice - perUnitDeduction)
   
   afterLineDiscountTotal = effectiveUnitPrice × quantity
   itemDiscount = baseTotal - afterLineDiscountTotal

2. subtotal = Σ(baseTotal de todos los items)
   lineDiscountsTotal = Σ(itemDiscount de todos los items)
   afterLineDiscountsSubtotal = subtotal - lineDiscountsTotal

3. Si doc.discountType === 'percent':
     orderDiscount = afterLineDiscountsSubtotal × (discountValue / 100)
   Si doc.discountType === 'fixed':
     orderDiscount = discountValue

4. totalDiscount = lineDiscountsTotal + orderDiscount
   afterAllDiscounts = subtotal - totalDiscount

5. shipping = doc.shippingPrice (en dólares)

6. taxRate = (taxMode === 'exempt') ? 0 : 0.07  ← siempre 7% para Florida
   tax = afterAllDiscounts × taxRate
   ⚠️  El shipping NO se tasa (Florida law)

7. total = afterAllDiscounts + shipping + tax
```

**Uso en componentes:**

```ts
import { computeTotals, usePOSStore } from '@/store/posStore'

const doc = usePOSStore(s => s.doc)
const { subtotal, lineDiscountsTotal, orderDiscount, tax, total, itemsWithTotals } = computeTotals(doc)
```

### Mapeo de valores a filas del Order Summary (`components/pos/OrderSummary.tsx`)

| Fila UI | Valor mostrado | Descripción |
|---------|---------------|-------------|
| **Item Subtotal (N items)** | `subtotal - lineDiscountsTotal` | Precio bruto menos los descuentos inline por ítem. Los descuentos por línea **ya están absorbidos** en este número. |
| **Discount** | `orderDiscount` | Solo el descuento global de la orden — manual (fixed/percent) o código de promoción. |
| **Order Subtotal** | `afterDiscount` (= `subtotal - lineDiscountsTotal - orderDiscount`) | Base después de todos los descuentos. |
| **Shipping** | `shipping` | `doc.shippingPrice` — no está sujeto a impuestos (Florida law). |
| **Tax** | `tax` | `afterDiscount × 0.07` (o 0 si `taxMode = 'exempt'`). |
| **Total** | `total` | `afterDiscount + shipping + tax`. |

> **Regla de diseño:** Los descuentos inline (BulkDiscountModal / por línea) se muestran directamente en la columna `% Disc.` de la `LineItemsTable`. **No se repiten** como fila separada en el Order Summary — el Item Subtotal ya los refleja. Solo el descuento de orden global aparece en la fila Discount.

---

## C. useEstimateData — Hidratación desde Medusa

**Archivo:** `app/(pos)/estimates/[id]/hooks/useEstimateData.ts`

### C.1 Campos expandidos en el fetch

```ts
const DRAFT_ORDER_FIELDS = [
    '+items.*', '+items.metadata',
    '+items.variant.*', '+items.variant.metadata', '+items.variant_id',
    '+shipping_address.*', '+billing_address.*',
    '+shipping_methods.*',
    '+cart.*', '+cart.items.*', '+cart.items.metadata',
    '+cart.items.variant.*', '+cart.items.variant.metadata',
    '+cart.shipping_address.*', '+cart.billing_address.*',
    '+cart.shipping_methods.*',
    '+customer_id', '+customer.*', '+metadata', '+email', '+status',
].join(',')
// Query: GET /admin/draft-orders/{id}?fields=...
```

> **¿Por qué `+cart.*`?** Medusa v2 draft orders a veces guardan items en `order.items` y otras veces en `order.cart.items`. El hook intenta ambos con `o.items ?? o.cart?.items`.

### C.2 Fetch paralelo de customer

```ts
// GET /admin/orders/{id}?fields=+customer.*
// ¿Por qué /orders y no /draft-orders? Medusa v2 a veces devuelve customer_id = null
// en draft orders (limitación del ORM). El endpoint /admin/orders siempre resuelve el customer.
const CUSTOMER_FIELDS = '+customer.id,+customer.first_name,+customer.last_name,+customer.email,+customer.phone,+customer.company_name'
```

### C.3 Hydration guard

```ts
// La hidratación se saltea SOLO si:
// 1. isDirty = true (hay cambios locales no guardados)
// 2. customerId existe (doc no está vacío)
// 3. items.length > 0 (doc tiene contenido)
// 4. doc.medusaId === o.id (el doc activo es el mismo que llegó del server)
const hasLocalWork = current.isDirty
    && !!current.doc.customerId
    && current.doc.items.length > 0
    && current.doc.medusaId === o.id
if (hasLocalWork) return  // No sobreescribir trabajo en progreso
```

### C.4 Mapeo exacto de items desde Medusa

```ts
items: (o.items ?? o.cart?.items ?? [])
    .filter((i) => (i.quantity ?? 0) > 0)     // elimina zombie items (qty=0)
    .sort((a, b) => {                          // sort por sort_order guardado
        const aOrder = a.metadata?.sort_order ?? 9999
        const bOrder = b.metadata?.sort_order ?? 9999
        return aOrder - bOrder
    })
    .map((i, idx) => ({
        localId: i.id,                          // el ID de Medusa ES el localId
        variantId: i.variant_id ?? '',
        productId: i.variant?.product_id ?? '',
        title: i.title ?? '',
        salesDescription:
            (i.variant?.metadata?.sales_description)  // prioridad 1: por variante (post-migración)
            ?? (i.metadata?.sales_description)          // prioridad 2: en el item (pre-migración)
            ?? undefined,
        variantTitle: i.description ?? i.variant?.title ?? '',
        sku: i.variant?.sku ?? i.variant_sku ?? '',
        thumbnail: i.thumbnail ?? null,
        options: (i.variant?.options ?? [])
            .filter(opt => opt.value && opt.value !== 'Default Title')
            .map(opt => ({ title: opt.option?.title ?? '', value: opt.value })),
        quantity: i.quantity,
        unitPrice:
            (i.metadata?.original_unit_price)    // si tenía descuento, el precio original
            ?? i.unit_price,                       // si no, el precio guardado directamente
        priceListId: null,
        priceListLabel: 'Default',
        lineDiscount: (i.metadata?.line_discount) ?? undefined,  // rehydrata el badge y tachado
        sortOrder: i.metadata?.sort_order ?? idx,
    }))
```

### C.5 Precio pre-descuento vs. precio efectivo

Cuando se guarda un item con `lineDiscount`, el endpoint `update-item-force` recibe:
- `unit_price: effectiveUnitPrice` — el precio ya descontado (es lo que Medusa almacena)
- `original_unit_price: item.unitPrice` — el precio base original (guardado en metadata)
- `line_discount: { type, value }` — el descuento (guardado en metadata)

Al recargar, la hydration:
- Lee `metadata.original_unit_price` como `unitPrice` → el POS muestra el precio base
- Lee `metadata.line_discount` como `lineDiscount` → el POS recalcula y muestra el tachado
- El `unit_price` en Medusa siempre refleja el precio efectivo (para totales correctos en QB)

### C.6 Batch-fetch de precios disponibles

```ts
// Una sola llamada con todos los variant_ids de los items del documento:
GET /admin/draft-orders/{id}/variant-prices?variant_ids[]=xxx&variant_ids[]=yyy

// Retorna:
{
    prices: {
        "variant_id_1": {
            default: { amount: 51.25 },
            list: [{ price_list_id: "...", price_list_name: "Wholesale", amount: 45.00 }]
        },
        "variant_id_2": { ... }
    }
}

// Enriquece cada item con availablePrices para el PriceDropdown
// NO marca isDirty (es solo enrichment de display)
enrichItemPrices(item.localId, availablePrices)
```

---

## D. Save Flow — Todas las Llamadas API en Secuencia

**Archivo:** `app/(pos)/estimates/[id]/hooks/useEstimateActions.ts`

### D.1 Pre-validaciones antes de guardar

```ts
// 1. getMissingMetaFields(doc) — valida campos requeridos
if (missingFields.length > 0) {
    toast.error(`Please fill in: ${missingFields.join(', ')}`)
    return
}
// 2. token requerido
// 3. doc.items.length > 0 — no se guarda un estimate vacío
// 4. Auto-apply Local Pickup si no hay shipping method
if (!localHasShipping && !existingHasShipping) {
    await shippingRef?.current?.applyLocalPickup()
}
```

### D.2 CREATE — Primer guardado (`wasNew = true`)

```
Llamada 1: GET /admin/regions?limit=1
           → obtiene regionId para crear el draft order

Llamada 2: POST /admin/draft-orders
           Body completo (ver buildCreatePayload más abajo)
           → retorna { draft_order: { id, cart_id } }
           → store.markSaved(resolvedId)
           → router.replace('/estimates/{resolvedId}')

Llamadas 3..N (parallel): POST /admin/draft-orders/{id}/add-item-force
           Por cada item:
           {
               variant_id: item.variantId,
               quantity: item.quantity,
               unit_price: item.unitPrice,       ← en dólares, precio base (sin descuento)
               custom_title: item.title,
               custom_description: item.salesDescription || ''
           }
           ⚠️ Los descuentos se aplican en el UPDATE (no en CREATE primera vez)

Llamada adicional (si shipping): POST /admin/draft-orders/{id}/add-shipping-force
           { shipping_option_id, custom_amount: shippingPrice / 100 }
           ⚠️ Aquí sí se divide /100 porque add-shipping-force espera dólares/100? Verificar.

Llamada adicional (si promotionId): POST /admin/pos-discount/apply-existing
           { order_id, promotion_code, promotion_id }
O bien: POST /admin/pos-discount
           { order_id, discount_type, discount_value }
```

**buildCreatePayload — Body completo:**

```ts
{
    customer_id: doc.customerId ?? undefined,
    email: doc.customerEmail || undefined,
    items: [],    // ← siempre vacío en el create; items se agregan via add-item-force
    region_id: regionId,
    shipping_address: { first_name, last_name, company, address_1, address_2, city, province, postal_code, country_code, phone },
    billing_address: { ...mismos campos... },
    metadata: {
        estimate_status: doc.estimateStatus,    // 'Created'
        lead_time: doc.leadTime,
        payment_terms: doc.paymentTerms,
        order_type: doc.orderType,
        project_name: doc.projectName,
        customer_po: doc.customerPO,
        sales_rep: doc.salesRep,
        pos_notes: doc.note,
        tax_mode: doc.taxMode,                  // 'auto' | 'florida' | 'exempt'
        discount_type: doc.discountValue > 0 ? doc.discountType : null,
        discount_value: doc.discountValue > 0 ? doc.discountValue : null,
        promotion_code: doc.promotionCode ?? null,
        pos_comment_lines: JSON.stringify(doc.commentLines)  // o null si vacío
    }
}
```

> **¿Por qué items vacíos?** Medusa valida stock en el create. `add-item-force` bypasea esa validación, permitiendo agregar items con 0 o stock negativo.

### D.3 UPDATE — Guardados subsiguientes

```
Llamada 1: POST /admin/draft-orders/{id}  (PATCH semántico en Medusa v2)
           Body: buildUpdatePayload(doc)   ← sin 'items', solo metadata+addresses

Llamada 2: GET /admin/draft-orders/{id}?fields=+items.*,+items.variant_id
           → obtiene oldItems fresh del servidor (evita race conditions con React Query)

Llamadas (parallel): DELETE y ADD/UPDATE de diferencias
   ─ eliminar items que ya no están:
     POST /admin/draft-orders/{id}/delete-item-force
          { line_item_id: old.id }

   ─ para cada item en doc.items:
     Si ya existe en oldItems (matched por id ó variant_id):
       Si cambió qty | precio | sort_order | lineDiscount | title | salesDesc:
         POST /admin/draft-orders/{id}/update-item-force
              {
                  line_item_id: existing.id,
                  quantity: item.quantity,
                  unit_price: effectiveUnitPrice,         ← precio DESPUÉS del descuento
                  sort_order: item.sortOrder,
                  line_discount: item.lineDiscount,       ← se guarda en metadata
                  original_unit_price: item.unitPrice,   ← precio BASE, se guarda en metadata
                  custom_title: item.title,
                  custom_description: item.salesDescription || ''
              }
     Si es nuevo (no existe en oldItems):
       POST /admin/draft-orders/{id}/add-item-force
            { variant_id, quantity, unit_price: effectiveUnitPrice, sort_order, line_discount, original_unit_price, custom_title, custom_description }

Llamadas (parallel independientes):
   ─ Si shippingOptionId cambió:
     Nuevo: POST /admin/draft-orders/{id}/add-shipping-force
            { shipping_option_id, custom_amount: freshPrice }
     Removido: DELETE /admin/draft-orders/{id}/remove-shipping

   ─ Si promotionCode cambió:
     apply-existing / pos-discount POST / pos-discount DELETE
```

**computeEffectivePrice (usada en el save):**

```ts
const computeEffectivePrice = (item) => {
    if (!item.lineDiscount || item.lineDiscount.value <= 0) return item.unitPrice
    if (item.lineDiscount.type === 'percent') {
        return Number((item.unitPrice * (1 - item.lineDiscount.value / 100)).toFixed(2))
    }
    const perUnit = item.lineDiscount.value / item.quantity
    return Number(Math.max(0, item.unitPrice - perUnit).toFixed(2))
}
```

### D.4 handleConfirmOrder — Flujo de Confirmación

```ts
// 1. writeActivityNote → escribe en Medusa notes antes de convertir
await writeActivityNote(doc.medusaId, {
    event: 'order_confirmed',
    user: actingUser,
    detail: `Estimate #${order?.display_id ?? doc.medusaId}`,
})

// 2. Convertir draft → order (irreversible)
const res = await medusaFetch<{ order: { id: string; display_id: number } }>(
    `/admin/draft-orders/${doc.medusaId}/convert-force`,
    { method: 'POST', token }
)
const newOrderId = res.order?.id

// 3. Escribir confirmed_at — CRÍTICO para Activity Log de Orders
await medusaFetch(`/admin/orders/${newOrderId}`, {
    method: 'POST',
    token,
    body: { metadata: { confirmed_at: new Date().toISOString() } }
}).catch(() => { /* non-critical, Activity Log tendrá fallback */ })

// 4. Limpiar estado y navegar
switchDoc('new')
router.push(`/orders/${newOrderId}`)
```

> **Por qué se escribe la nota ANTES del convert-force:**
> El draft order ID es el que se usa para escribir notas. Una vez convertido, el entity es un Order con un ID diferente. Las notas del draft order se consultan via el mismo endpoint `/admin/orders/{id}/changes`, que incluye el historial del draft.

---

## E. ActivityLog — Implementación Completa

**Archivo:** `components/pos/ActivityLog.tsx`

### E.1 Props

```ts
export interface ActivityLogProps {
    medusaId: string | null        // draft order ID o order ID
    metadata?: Record<string, any> | null
    createdAt?: string | null      // ISO — timestamp del evento ancla
    context?: 'estimate' | 'order' // determina el label del evento ancla
}
```

### E.2 Query de datos

```ts
// Query key: ['order-changes', medusaId]
// Proxy: GET /api/pos/order-changes?id={medusaId}
// → backend: GET /admin/orders/{id}/changes
// → retorna: { order_changes: OrderChange[] }
// staleTime: 15_000ms
// retry: false
// refetchOnWindowFocus: true
```

**Después de invalidar la query (en onApply, onSuccess, etc):**
```ts
queryClient.invalidateQueries({ queryKey: ['order-changes', orderId] })
```

### E.3 Tipos de eventos parseados

| `change_type` / actions | Título mostrado | Ícono | Color |
|---|---|---|---|
| Evento ancla (`context='estimate'`) | "Created" | `<FileText />` | `text-accent` |
| Evento ancla (`context='order'`) | "Order placed" | `<ShoppingCart />` | `text-accent` |
| `metadata.estimate_sent_at` presente | "Email sent" | `<Mail />` | `text-sky-400` |
| `metadata.confirmed_at` presente | "Order confirmed" | `<ClipboardCheck />` | `text-emerald-400` |
| Actions con shipping_add solamente | "Shipping added" | `<Truck />` | `text-sky-400` |
| Actions con item_add solamente | "Items added" | `<Package />` | `text-emerald-400` |
| Actions con item_delete solamente | "Items removed" | `<Package />` | `text-rose-400` |
| Actions con item_amend solamente | "Items updated" | `<PenLine />` | `text-amber-400` |
| Mixto | "Order edited" | `<PenLine />` | `text-muted` |
| `change_type='order_edit'` + `status='confirmed'` | "Order edit confirmed" | `<ClipboardCheck />` | `text-emerald-400` |

### E.4 Resolución de nombres de usuario

```ts
// Por cada userId en los OrderChanges.created_by, resuelve el nombre via:
GET /api/pos/admin-user?id={userId}
// Retorna: { name: "First Last" }
// Se cacha en estado local del componente: Record<string, string>
// Es best-effort — si falla, simplemente no muestra "by [name]"
```

### E.5 Formato de timestamps relativos

```ts
function formatRelative(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime()
    const mins = Math.floor(diff / 60_000)
    if (mins < 1) return 'Just now'
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    const days = Math.floor(hrs / 24)
    if (days < 30) return `${days}d ago`
    return new Date(iso).toLocaleDateString()  // fecha absoluta para eventos > 1 mes
}
// El timestamp '1970-01-01T00:00:00Z' es el epoch fallback — se oculta en el render
```

### E.6 Layout del componente

```
┌─────────────────────────────────────┐  ← pos-card w-52 flex-shrink-0
│ 🕐  ACTIVITY LOG                    │  ← header fijo
├─────────────────────────────────────┤
│ ○ Order placed          → top       │  ← eventos, newest first
│   "Order placed by POS"             │
│   by John Smith · 2m ago            │
│                       │             │
│ ○ Items added                       │  ← vertical timeline line: left-6, w-px
│   "Added 2 items"                   │
│   by John Smith · 1h ago            │
│                       │             │
│ ○ Created             → bottom      │  ← evento ancla siempre al fondo
│   "Estimate created"                │
│   5d ago                            │
└─────────────────────────────────────┘
```

---

## F. Estructura de Archivos

```
ecopowertech-store-pos/
├── store/
│   └── posStore.ts                    ← Estado global (Zustand + localStorage)
├── app/(pos)/
│   ├── estimates/
│   │   ├── page.tsx                   ← Lista de estimates
│   │   ├── new/
│   │   │   └── page.tsx               ← Redirige a /estimates/[id] con id='new'
│   │   └── [id]/
│   │       ├── page.tsx               ← Detalle del estimate (7-row layout)
│   │       ├── types.ts               ← Address type local
│   │       ├── components/
│   │       │   └── CustomerStrip.tsx  ← Row 1: Customer + addresses
│   │       └── hooks/
│   │           ├── useEstimateData.ts ← React Query + hydration
│   │           ├── useEstimateActions.ts ← Save, Email, Confirm, History, Discard
│   │           ├── useEstimateNavigation.ts ← Prev/Next con sessionStorage
│   │           └── useEstimate.tsx    ← Orquestador: combina los 3 hooks anteriores
│   └── orders/
│       ├── page.tsx                   ← Lista de órdenes
│       └── [id]/
│           ├── page.tsx               ← Detalle de la orden (7-row layout, read-ish)
│           ├── components/
│           │   └── CustomerStrip.tsx
│           └── hooks/
│               └── useOrder.ts        ← Equivalente de useEstimate para órdenes
├── components/pos/
│   ├── ActivityLog.tsx                ← Panel derecho del timeline
│   ├── BulkDiscountModal.tsx          ← Descuentos masivos por línea
│   ├── CapturePaymentModal.tsx        ← Modal de captura de pago (crédito + método)
│   ├── CategoriesModal.tsx            ← Browser de productos por categoría
│   ├── CustomerHistoryModal.tsx       ← Modal de historial del cliente (Activity inline)
│   ├── EstimateMetaFields.tsx         ← Row 2: 4 dropdowns (status/lead/terms/type)
│   ├── ItemSearch.tsx                 ← Búsqueda de productos (MeiliSearch)
│   ├── ItemsExpandedModal.tsx         ← Vista expandida de la tabla
│   ├── LineItemsTable.tsx             ← La tabla principal (DnD, precios, descuentos)
│   ├── NoteArea.tsx                   ← Row 5: notas + plantillas rápidas
│   ├── OrderSummary.tsx               ← Row 7: ledger de totales
│   ├── PromotionStrip.tsx             ← Row 4: descuento a nivel orden
│   ├── SendEstimateModal.tsx          ← Email del estimate al cliente
│   └── ShippingSection.tsx            ← Row 6: shipping + modal
└── lib/
    ├── estimateNav.ts                  ← sessionStorage helpers: saveEstimateNavList/getEstimateNavList
    └── medusa.ts                       ← medusaFetch() wrapper con auth
```

---

## 14. Customer History Modal

El botón **History** en el toolbar de estimates abre `CustomerHistoryModal` inline — sin navegar fuera del documento.

### Componente (`components/pos/CustomerHistoryModal.tsx`)

**Props**

| Prop | Type | Descripción |
|---|---|---|
| `open` | `boolean` | Controla visibilidad |
| `onClose` | `() => void` | Handler de cierre |
| `customerId` | `string` | UUID del cliente Medusa |
| `customerName` | `string \| undefined` | Mostrado en el header del modal |

**APIs (lazy — solo cuando `open === true`)**

```
GET /admin/orders?customer_id={id}&limit=50&fields=id,display_id,status,payment_status,total,created_at
GET /admin/draft-orders?customer_id={id}&limit=50&fields=id,display_id,status,total,created_at
```

**Funcionalidades** — idénticas a la sección Activity de la página de Customer:

- Tabs: **All / Estimates / Orders / Open / Closed** (con conteos en tiempo real)
- Toggle **Show Cancelled** con badge de count
- Dropdown **Date filter**: All time / This week / This month / This year / Last year / Date range personalizado
- Columnas: `Type | # | Date | Items | Total | Status` con `StatusBadge` colorido
- Click en fila: cierra modal → `router.push(/estimates/{id})` o `router.push(/orders/{id})`
- Ancho: `max-w-7xl` (~1280px) — suficiente para todas las tabs sin truncar

**Wiring en `estimates/[id]/page.tsx`**

```tsx
const [historyModalOpen, setHistoryModalOpen] = useState(false)

<DocumentToolbar
    onHistory={estimate.doc.customerId ? () => setHistoryModalOpen(true) : undefined}
    ...
/>

{estimate.doc.customerId && (
    <CustomerHistoryModal
        open={historyModalOpen}
        onClose={() => setHistoryModalOpen(false)}
        customerId={estimate.doc.customerId}
        customerName={estimate.doc.customerName || undefined}
    />
)}
```

> **Nota**: `onHistory` se pasa como `undefined` cuando no hay cliente — esto deshabilita el botón automáticamente en `DocumentToolbar`.

---

## Changelog — Marzo 11, 2026

### 28. Modal "Add New Customer" — Rediseño de Validación y Metadata

El modal de nuevo cliente (disponible en Estimates al seleccionar un cliente) fue rediseñado:

**Cambios:**
- **Validación:** `(First Name AND Last Name) OR Company Name` — antes requería ambos sin opción de solo empresa
- **Email opcional:** Si el usuario no provee email, se genera automáticamente `noemail-{timestamp}@ecopowertech.com` (mismo patrón del script de importación QB)
- **Sección Alt. Contact & Notifications** (nueva):
  - `alt_contact` — nombre de persona de referencia alterna
  - `alt_phone` — teléfono del contacto alterno
  - `alt_email` — email directo del contacto alterno (separado de CC)
  - `cc_emails` — lista comma-separated de emails para CC en estimates e invoices
- **Hint contextual** — aparece cuando email está vacío indicando que se generará uno automáticamente

Para documentación completa del modal, ver `POS_CUSTOMERS.md § 3`.

---

## Changelog — Marzo 13, 2026

### 29. Order Summary — Separación de Descuentos Inline vs. Global

**Cambio en `components/pos/OrderSummary.tsx`** (compartido entre Estimates, Orders e Invoices POS).

**Antes:**
- **Item Subtotal** = precio bruto de todos los ítems sin ningún descuento
- **Discount** = suma de descuentos inline por línea + descuento global de la orden

**Ahora:**
- **Item Subtotal** = precio bruto **menos los descuentos inline por línea** (ya reflejan el precio efectivo negociado)
- **Discount** = solo el **descuento global** de la orden (PromotionStrip / código de descuento / porcentaje fijo manual)

**Justificación:** Los descuentos por línea ya se muestran en la columna `% Disc.` de la tabla de ítems. Repetirlos como descuento separado en el summary era confuso. El descuento global (promo code o porcentaje de orden) es el único que aplica "post-negociación" y merece su propia fila.

**Sin cambio numérico:** `Order Subtotal`, `Tax` y `Total` son idénticos — solo cambia cómo se distribuyen los valores entre las filas superiores del ledger.

**Archivo modificado:** `ecopowertech-store-pos/components/pos/OrderSummary.tsx`

```ts
// computeTotals() ya retornaba lineDiscountsTotal y orderDiscount por separado.
// El orden de uso en OrderSummary.tsx cambió de:
const itemSubtotal = subtotal                                    // antes
const discountRow  = totalDiscount                              // antes (inline + global)

// A:
const itemSubtotal = subtotal - lineDiscountsTotal               // ahora (inline absorbido)
const discountRow  = orderDiscount                              // ahora (solo global)
```
