# Search — MeiliSearch Configuration & Indexes
> **Tipo**: Technical Reference
> **Repo**: backend
> **Última verificación**: 2026-04-02
> **Estado**: ✅ Current

---

## ¿Qué es y por qué existe?

MeiliSearch es el motor de búsqueda de la plataforma, usado para búsqueda de productos, clientes e inventario en tiempo real. Medusa v2 incluye integración oficial con MeiliSearch via el plugin `@rokmohar/medusa-plugin-meilisearch`.

El sistema tiene **dos mecanismos de sincronización**:
1. **Middleware auto-sync** — actualización incremental (~50ms) después de cada edición via API
2. **Sync manual** — re-indexación completa desde las páginas `-advanced` del admin

El motivo de usar middleware en lugar de subscribers de Medusa: los **subscribers de Medusa v2 no se disparan de forma confiable** (bug documentado en `MEDUSA_V2_SUBSCRIBER_BUG_AND_MIDDLEWARE_FIX.md`).

---

## Arquitectura

### Índices

| Índice | Contenido | Plugin auto-sync | Manual sync |
|--------|-----------|-----------------|-------------|
| `products` | Productos con SKUs, metadata | ✅ Vía plugin | `POST /admin/search/products/sync` |
| `customers` | Clientes con metadata de QB | ✅ Vía plugin | `POST /admin/search/customers/sync` |
| `inventory` | Variants + inventory + precios | — (workflow separado) | `POST /admin/search/inventory/sync` |

### Plugin: `@rokmohar/medusa-plugin-meilisearch`

Configurado en `medusa-config.ts`. Maneja la sincronización automática inicial de `products` y `customers`.

---

## Configuración del Plugin (medusa-config.ts)

### Índice `products`

```typescript
products: {
  indexSettings: {
    searchableAttributes: [
      "title",
      "description",
      "handle",
      "variant_sku",
      "metadata_material",
      "metadata_category"
    ],
    displayedAttributes: [
      "id", "title", "handle", "thumbnail", "variant_sku",
      "status", "metadata", "updated_at", "created_at"
    ],
    sortableAttributes: ["title", "id", "created_at", "updated_at", "status"],
  },
  primaryKey: "id",
  transformer: (product: any) => ({
    id: product.id,
    title: product.title,
    description: product.description,
    handle: product.handle,
    thumbnail: product.thumbnail,
    variant_sku: product.variants?.map((v: any) => v.sku).filter(Boolean) || [],
    status: product.status,
    metadata: product.metadata || {},
    metadata_material: product.metadata?.material || null,
    metadata_category: product.metadata?.category || null,
    // Timestamps como unix ms — CRÍTICO para detección de staleness
    updated_at: new Date(product.updated_at).getTime(),
    created_at: new Date(product.created_at).getTime(),
  })
}
```

**Campos no documentados anteriormente en el transformer:**
- `metadata_material` y `metadata_category` son campos aplanados de `product.metadata` para búsqueda
- `variant_sku` es un array de todos los SKUs de variantes (no solo el primero)
- `updated_at` y `created_at` se convierten a **unix milliseconds** para la detección de staleness del sync manual

### Índice `customers`

```typescript
customers: {
  indexSettings: {
    searchableAttributes: ["email", "first_name", "last_name", "company_name", "phone"],
    filterableAttributes: ["customer_type", "price_level", "has_account", "groups", "status"],
    displayedAttributes: [
      "id", "email", "first_name", "last_name", "company_name", "phone",
      "has_account", "groups", "metadata", "created_at", "updated_at",
      "customer_type", "price_level", "acquisition_channel", "list_id", "status"
    ],
  },
  primaryKey: "id",
  transformer: (customer: any) => {
    const meta = customer.metadata || {}
    const groupNames = customer.groups?.map((g: any) => g.name) || []
    // Price level: deriva de grupos o metadata QB
    let priceLevel = "Retail"
    if (groupNames.includes("Wholesale")) priceLevel = "Wholesale"
    if (meta.price_level || meta.qb_price_level) priceLevel = meta.price_level || meta.qb_price_level

    return {
      id: customer.id,
      email: customer.email,
      first_name: customer.first_name,
      last_name: customer.last_name,
      company_name: customer.company_name,
      phone: customer.phone,
      has_account: customer.has_account,
      status: customer.has_account ? "Registered" : "Guest",
      groups: groupNames,
      metadata: meta,
      created_at: new Date(customer.created_at).getTime(),
      updated_at: new Date(customer.updated_at).getTime(),
      // Campos aplanados para columnas del POS
      customer_type: meta.qb_customer_type || meta.customer_type || "Standard",
      price_level: priceLevel,
      acquisition_channel: meta.acquisition_channel || "",
      list_id: meta.qb_list_id || ""
    }
  }
}
```

**Campos no documentados anteriormente:**
- `status` → derivado de `has_account` ("Registered" o "Guest")
- `groups` → array de nombres de grupo (no IDs)
- `list_id` → read de `meta.qb_list_id` (QuickBooks ListID)
- `price_level` → lógica de prioridad: grupo "Wholesale" > `meta.price_level` > `meta.qb_price_level` > "Retail"
- `acquisition_channel` → `meta.acquisition_channel`

### Índice `inventory`

El índice de inventory **no usa el plugin** — tiene su propio workflow (`src/workflows/sync-inventory.ts`) que hace atomic replace (deleteAll + addDocuments). Ver `SEARCH_SYNC_ARCHITECTURE.md` para detalles completos del schema.

---

## Auto-Sync via Middleware

**Archivo:** `src/api/middlewares.ts`

El middleware intercepta respuestas exitosas (2xx) de la Admin API y dispara sync non-blocking via `setImmediate`:

```typescript
// Producto individual
if (data?.product) → fetch producto completo con relations: ["variants"] → sync a Meili

// Múltiples productos  
if (data?.products) → fetch completo con variantes → sync batch

// Customer
if (data?.customer) → sync directo (no necesita fetch adicional)

// Inventory item
if (data?.inventory_item || data?.inventory_items) → ejecuta syncInventoryWorkflow completo
```

**CRÍTICO para products:** El middleware **DEBE** hacer un fetch adicional con `relations: ["variants"]` antes de sincronizar. La respuesta HTTP de Medusa no incluye variantes por defecto. Sin esto, los SKUs quedan vacíos en el índice.

### Endpoints interceptados automáticamente

- `/admin/products*` → sync product(s)
- `/admin/customers*` → sync customer
- `/admin/inventory-items*` → sync inventory completo
- `/admin/products/:id/variants*` → sync inventory (cambios de precio/stock via batch)

**No dispara para:**
- Queries SQL directas
- Scripts de migración/seed
- Bulk imports externos

---

## Sync Manual (Smart Sync)

### Endpoints de sync

| Endpoint | Entidad | Usa workflow |
|----------|---------|-------------|
| `POST /admin/search/products/sync` | Products | `syncProductsWorkflow` |
| `POST /admin/search/customers/sync` | Customers | `syncCustomersWorkflow` |
| `POST /admin/search/inventory/sync` | Inventory | `syncInventoryWorkflow` |

Todos soportan `?force=true` para forzar sync aunque el sistema considere que está actualizado.

### Lógica de detección de staleness (Smart Sync)

Antes de ejecutar sync completo, cada endpoint verifica:

```typescript
const isCountSync = dbCount === meiliCount             // conteos iguales
const timeDiff = dbLastUpdate - meiliLastUpdate
const isTimeSync = timeDiff <= 5000                    // DB no más de 5s delante de Meili

if (isCountSync && isTimeSync) → return "already_synced"
// else → ejecuta sync completo
```

**¿Por qué 5s de tolerancia?** MeiliSearch indexing es async y hay latencia de red entre servicios Railway.

### Orphan detection (Inventory)

El sync de inventory filtra items "huérfanos" (sin `variantId` o `productId` válidos):
```typescript
const validItems = inventoryItems.filter(item => item.variantId && item.productId)
```

Esto previene indexar variants/inventory de productos eliminados.

---

## Búsqueda desde Admin

### Productos

```http
GET /admin/search/products?q=<query>
```

Busca en el índice `products` con límite 50. Retorna: `{ hits, query, processingTimeMs, estimatedTotalHits }`.
Requiere autenticación como `user`.

### Update de un producto (incremental)

```http
POST /admin/search/products/update
Body: { productId: string }
```

Actualiza un único producto en el índice vía `updateSingleProductWorkflow`. Usado internamente por el middleware.

### Query de inventory (proxy)

```http
POST /admin/search/inventory/query
Body: { q, offset, limit, filter, sort }
```

Proxy server-side para evitar CORS al consultar MeiliSearch desde el admin frontend.

---

## Variables de Entorno

```bash
MEILISEARCH_HOST=https://...        # URL de la instancia MeiliSearch
MEILISEARCH_API_KEY=...             # Master/Admin key para el backend
PUBLIC_MEILISEARCH_HOST=https://... # Mismo host pero para el frontend (Store)
PUBLIC_MEILISEARCH_SEARCH_KEY=...   # Search-only key para el frontend
```

---

## Logs de Referencia

### Auto-sync exitoso
```
[MEILI-PRODUCT-SYNC] 🔄 Product prod_01JKH... changed, incremental update
[MEILI-PRODUCT-SYNC] ✅ Updated: UL FREECUT COB LED Strip
```

### Sync manual — ya sincronizado
```
🔍 [Sync Check] DB Count: 200 | Meili Count: 200
🔍 [Sync Status] Count Match: true, Time Sync: true
✅ [Sync Check] Already in sync!
```

### Sync manual — necesita sync
```
🔍 [Inventory Sync Check] DB Valid: 344 (346 total, 2 orphaned) | Meili: 0
🔍 [Inventory Sync Status] Count Match: false
🔄 [Inventory Sync] Starting full sync...
```

---

## Troubleshooting

### Precios no se actualizan en Inventory-Advanced
Causa: MeiliSearch no se sincronizó después de cambios directos en DB.
Solución: Click "Check Inventory Sync" → esperar 3-5s → hard refresh (Ctrl+Shift+R).

### Sync button dice "Already Synced" pero datos son incorrectos
Causa: React Query cache en frontend.
Solución: Agregar `staleTime: 0, gcTime: 0` al hook; invalidar con el query key correcto.

### SKU desaparece al editar producto
Causa: Middleware no está haciendo fetch de variantes antes de sincronizar.
Verificar: Los logs deben mostrar `✅ Product xxx synced with N variants`.

### Auto-sync no funciona después de reinicio del servidor
Causa: El middleware necesita al menos una request para activarse.
Solución: Hacer cualquier edición en el Admin UI para activar el middleware.

### Precios de batch variant no sincronizan
El endpoint `/admin/products/:id/variants/batch` retorna `{updated: [...]}` — el middleware detecta `hasBatchUpdate` para este caso. Verificar logs: `[MEILI-INVENTORY-SYNC] 📦 Batch update detected: N variants`.

---

## Reglas Críticas

1. **Fetch con `relations: ["variants"]` en el middleware de products** — la respuesta HTTP no incluye variantes
2. **Atomic replace en inventory** — deleteAll + addDocuments garantiza consistencia
3. **5s de tolerancia** en timestamp comparison — evitar falsos positivos de staleness
4. **`setImmediate` para sync no-bloqueante** — el sync nunca debe ralentizar la respuesta HTTP
5. **Solo sync manual después de scripts SQL directos** — el middleware no detecta cambios que no pasan por la API

---

## Archivos Clave

| Tipo | Ruta Completa | Propósito |
|------|---------------|-----------|
| Plugin config | `backend/medusa-config.ts` (línea ~400) | Transformers products + customers |
| Middlewares | `backend/src/api/middlewares.ts` | Auto-sync interceptor |
| Sync products | `backend/src/api/admin/search/products/sync/route.ts` | Manual sync endpoint |
| Sync customers | `backend/src/api/admin/search/customers/sync/route.ts` | Manual sync endpoint |
| Sync inventory | `backend/src/api/admin/search/inventory/sync/route.ts` | Manual sync endpoint |
| Update product | `backend/src/api/admin/search/products/update/route.ts` | Incremental update endpoint |
| Query inventory | `backend/src/api/admin/search/inventory/query/route.ts` | Proxy search para frontend |
| Search products | `backend/src/api/admin/search/products/route.ts` | Admin search endpoint |
| Workflow products | `backend/src/workflows/sync-products.ts` | Full sync de productos |
| Workflow customers | `backend/src/workflows/sync-customers.ts` | Full sync de clientes |
| Workflow inventory | `backend/src/workflows/sync-inventory.ts` | Full sync de inventory con pricesByList |
| Workflow single | `backend/src/workflows/update-single-product.ts` | Incremental product update |
| Job reconcile | `backend/src/jobs/reconcile-meilisearch.ts` | Cron cada 5 min — red de seguridad |

---

## Historial de Decisiones

| Fecha | Decisión | Razón |
|-------|----------|-------|
| ~2026-01 | Middleware en lugar de subscribers | Subscribers de Medusa v2 no se disparan de forma confiable |
| ~2026-01 | `setImmediate` para sync non-blocking | El sync no debe ralentizar la respuesta HTTP al cliente |
| ~2026-01 | Fetch completo con variantes en middleware | La respuesta HTTP de Medusa no incluye relaciones por defecto |
| 2026-02-04 | Detección de `hasBatchUpdate` en middleware | El endpoint de batch variants retorna formato diferente al de un solo producto |
| ~2026-01 | Atomic replace en inventory (deleteAll + add) | Inventory tiene relaciones complejas; sync granular es más complejo que confiable |
| ~2026-01 | 5s de tolerancia en timestamp comparison | MeiliSearch indexing es async + latencia Railway |
| ~2026-01 | Campos `metadata_material` y `metadata_category` en transformer | Permite filtrar/buscar por metadata sin parsear JSON en MeiliSearch |
| ~2026-01 | `updated_at` y `created_at` como unix ms en transformer | Smart sync compara timestamps; ms permite comparación directa con `new Date()` |
