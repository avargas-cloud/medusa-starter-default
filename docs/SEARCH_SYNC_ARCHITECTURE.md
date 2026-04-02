# Search — Sync Architecture (Products, Customers, Inventory)
> **Tipo**: Technical Reference
> **Repo**: backend
> **Última verificación**: 2026-04-02
> **Estado**: ✅ Current

---

## ¿Qué es y por qué existe?

Documenta la arquitectura de sincronización de los tres índices de MeiliSearch: Products, Customers e Inventory. Cada uno tiene una página "advanced" en el admin panel que reemplaza la vista nativa de Medusa con búsqueda en tiempo real y sync automático.

**Problema de raíz:** Los subscribers de Medusa v2 no se disparan de forma confiable. La solución es una arquitectura de **3 capas de redundancia** para garantizar consistencia.

---

## Arquitectura de 3 Capas (Aplicable a las 3 Entidades)

| Capa | Trigger | Tipo | Latencia | Propósito |
|------|---------|------|----------|-----------|
| 1. Middleware | Cada edit via API | Incremental (1 item o workflow) | ~50ms | Sync en tiempo real |
| 2. Reconciliation Job | Cron cada 5 min | Full re-index | ~2-8s | Red de seguridad |
| 3. Sync Manual | Click del admin | Full re-index inteligente | ~2-12s | Control del usuario |

---

## Estructura de Archivos (compartida)

```
src/
├── admin/
│   ├── routes/
│   │   ├── products-advanced/     # /app/products-advanced
│   │   ├── customers-advanced/    # /app/customers-advanced
│   │   └── inventory-advanced/    # /app/inventory-advanced
│   ├── widgets/
│   │   └── sidebar-hijacker.tsx   # Redirige Products/Customers/Inventory → advanced
│   └── lib/
│       ├── meili-client.ts        # Cliente MeiliSearch frontend
│       └── meili-types.ts         # Types TypeScript
│
├── api/
│   ├── middlewares.ts             # Auto-sync interceptor
│   └── admin/
│       └── search/
│           ├── products/{sync,update,route.ts}
│           ├── customers/{sync,update}
│           └── inventory/{sync,query}
│
├── jobs/
│   ├── reconcile-meilisearch.ts   # Products + Customers — cron cada 5 min
│   └── reconcile-inventory.ts    # Inventory — cron cada 5 min
│
└── workflows/
    ├── sync-products.ts
    ├── sync-customers.ts
    └── sync-inventory.ts
```

### Sidebar Hijacker

`src/admin/widgets/sidebar-hijacker.tsx` — widget global que usa event capture en `document` para interceptar clics en los links nativos del sidebar ("/app/products", "/app/customers", "/app/inventory") y redirigirlos a las páginas `-advanced` sin romper la navegación SPA.

Usa History API (`pushState` + `dispatchEvent(new PopStateEvent('popstate'))`) y un singleton pattern (`window.__hijackerInstalled`) para evitar duplicados.

---

## Products Advanced

### MeiliSearch Index Schema

```typescript
{
  id: string,
  title: string,
  description: string | null,
  handle: string,
  thumbnail: string | null,
  variant_sku: string[],        // Array de TODOS los SKUs de todas las variantes
  status: string,               // "published" | "draft"
  metadata: object,
  metadata_material: string | null,  // Aplanado para búsqueda
  metadata_category: string | null,  // Aplanado para búsqueda
  updated_at: number,           // Unix milliseconds
  created_at: number,           // Unix milliseconds
}
```

### Capa 1: Middleware (Incremental)

Intercepta `data?.product` o `data?.products` en respuestas 2xx de `/admin/products*`.

**CRÍTICO:** Siempre hace fetch adicional con `relations: ["variants"]` antes de sincronizar — las respuestas HTTP de Medusa no incluyen variantes por defecto.

```typescript
// ✅ CORRECTO
const [fullProduct] = await productModule.listProducts(
    { id: [data.product.id] },
    { relations: ["variants"] }
)
await index.addDocuments([transformProduct(fullProduct)])

// ❌ ROTO — variant_sku queda vacío
await index.addDocuments([transformProduct(data.product)])
```

### Capa 2: Reconciliation Job

`src/jobs/reconcile-meilisearch.ts` — cron `*/5 * * * *`. Hace full sync de todos los productos con `take: 10000`.

### Capa 3: Sync Manual

`POST /admin/search/products/sync` — Smart sync: verifica count + timestamp antes de ejecutar. Soporta `?force=true`.

### Cache Invalidation Frontend

La página invalida el cache de React Query al montar:
```typescript
useEffect(() => {
    queryClient.invalidateQueries({ queryKey: ["meili-products"] })
}, [queryClient])
```

Config del query: `staleTime: 5000, refetchOnWindowFocus: true`.

---

## Customers Advanced

### MeiliSearch Index Schema

```typescript
{
  id: string,
  email: string,
  first_name: string,
  last_name: string,
  company_name: string,
  phone: string,
  has_account: boolean,
  status: "Registered" | "Guest",   // Derivado de has_account
  groups: string[],                  // Nombres de grupo (no IDs)
  metadata: object,
  created_at: number,                // Unix milliseconds
  updated_at: number,                // Unix milliseconds
  // Campos aplanados de metadata (para columnas de tabla y filtros)
  customer_type: string,             // meta.qb_customer_type || meta.customer_type || "Standard"
  price_level: string,               // Derivado de grupos + meta QB
  acquisition_channel: string,       // meta.acquisition_channel
  list_id: string,                   // meta.qb_list_id (QuickBooks ListID)
}
```

### Lógica de price_level en transformer

Prioridad (de mayor a menor):
1. `meta.price_level` o `meta.qb_price_level` (explícito en metadata)
2. Si tiene grupo "Wholesale" → "Wholesale"
3. Default: "Retail"

### Filterable Attributes del Índice

`customer_type`, `price_level`, `has_account`, `groups`, `status`

Estos atributos soportan filtrado en el query, e.g.:
```
filter: "customer_type = Commercial AND price_level = Wholesale"
```

### Capa 1: Middleware (Incremental)

Intercepta `data?.customer` en respuestas de `/admin/customers*`. Más simple que products: no necesita fetch adicional (el customer ya tiene toda la data necesaria en la respuesta).

### Capa 2: Reconciliation Job

Mismo job que products (`reconcile-meilisearch.ts`). Sincroniza customers con `take: 10000`.

### Capa 3: Sync Manual

`POST /admin/search/customers/sync` — Smart sync con count + timestamp comparison (tolerancia 2000ms para customers, más estricto que products).

### Filtros Especiales

La página customers-advanced expone filtros por `customer_type` ("commercial" / "residential") y `price_level` ("wholesale" / "retail" / "contractor"). También permite buscar por QuickBooks ListID directamente.

---

## Inventory Advanced

### MeiliSearch Index Schema

```typescript
{
  id: string,                         // inventory item ID
  sku: string,
  title: string,
  thumbnail: string | null,
  totalStock: number,                 // stocked_quantity
  totalReserved: number,              // reserved_quantity
  price: number,                      // RETAIL price (max USD amount, price_list IS NULL)
  currencyCode: "USD",
  pricesByList: Record<string, number>,  // { [price_list_id]: amount }
  variantId: string,
  productId: string | null,
  category_handles: string[],         // handles de categoría + padres (flatteado)
  status: string,                     // del producto asociado
  created_at: number,                 // Unix milliseconds (del inventory item)
  updated_at: number,                 // Unix milliseconds (del inventory item)
}
```

**Nota sobre `price`:** Es el precio máximo USD con `price_list_id IS NULL` — es el precio retail base.

**Nota sobre `pricesByList`:** Mapa de price_list_id → amount para todas las price lists activas. Permite columnas dinámicas sin múltiples queries.

**Nota sobre `category_handles`:** Array flatteado que incluye handles de la categoría directa + el padre. Permite filtrar por categoría en el inventario.

### Sync Workflow (`sync-inventory.ts`) — Lógica Completa

El workflow hace **atomic replace** (deleteAll + addDocuments):

1. Bulk-load de TODOS los precios de price lists:
   ```typescript
   const allPriceLists = await pricingService.listPriceLists()
   const priceListPrices = await pricingService.listPrices({ price_list_id: priceListIds })
   // Build map: priceSetId → { price_list_id: amount }
   ```

2. Query de todos los variants con relaciones via `query.graph`:
   - `variant.sku`, `variant.prices` (amount, currency_code, price_list_id)
   - `variant.price_set.id` (para lookup en el bulk map)
   - `variant.product.id/title/thumbnail/status/categories`
   - `variant.inventory_items.inventory.*`

3. Para cada variant + inventory item:
   - `price` = max USD amount donde `price_list_id IS NULL` (retail)
   - `pricesByList` = lookup en el bulk map por `price_set_id`
   - Filtra items "huérfanos" sin `variantId` o `productId`

4. `deleteAllDocuments()` + `addDocuments(validItems)` + `waitForTask()`

**¿Por qué sync completo en lugar de incremental?** Inventory tiene relaciones complejas entre 3 módulos (product, inventory, pricing). El sync granular sería complejo y propenso a inconsistencias.

### Capa 1: Middleware (Workflow completo)

Intercepta `data?.inventory_item` o `data?.inventory_items` en `/admin/inventory-items*`. Ejecuta el workflow completo (no sync granular). Toma ~500ms pero es acceptable para inventory.

También detecta cambios de precio via `/admin/products/:id/variants/batch` (formato `{updated: [...]}`) para sincronizar cuando se editan precios en batch.

### Capa 2: Reconciliation Job

`src/jobs/reconcile-inventory.ts` — cron `*/5 * * * *`. Ejecuta el mismo `syncInventoryWorkflow`.

### Capa 3: Sync Manual

`POST /admin/search/inventory/sync` — usa el mismo Smart Sync con count + timestamp comparison.

Query proxy: `POST /admin/search/inventory/query` — evita CORS al hacer search desde el frontend admin.

### Feature Flags y Columnas Dinámicas

```bash
# backend/.env
ENABLE_DYNAMIC_PRICING=true   # muestra columnas por price list
```

`GET /admin/config/features` expone el flag y la lista de price lists al frontend:
```typescript
{ enableDynamicPricing: boolean, priceLists: Array<{id, title}> }
```

Hook `use-feature-flags.ts` con `staleTime: Infinity` (env vars no cambian en runtime).

### Columnas de la tabla Inventory Advanced

| Columna | Siempre visible | Condición | Acción al click |
|---------|----------------|-----------|-----------------|
| Image | ✅ | — | — |
| Title / SKU | ✅ | — | Inventory item detail |
| Reserved | ✅ | — | Abre Stock Level Modal |
| In Stock | ✅ | — | Abre Stock Level Modal |
| Available | ✅ | `In Stock − Reserved` | Abre Stock Level Modal |
| Retail Price | ✅ | — | Abre variant prices en nueva pestaña |
| `{Price List name}` | ❌ | `ENABLE_DYNAMIC_PRICING=true` | Abre price list editor en nueva pestaña |

**Fallback:** Si el item no tiene precio en una price list específica, muestra el precio retail en gris/italic.

### Stock Level Modal

`src/admin/routes/inventory-advanced/components/inventory-stock-modal.tsx`

Usa `GET /admin/inventory-items/{id}/location-levels?fields=+stock_locations.id,+stock_locations.name`.

**CRÍTICO:** El campo es `stock_locations` (plural, array), no `stock_location` (singular).

Muestra breakdown por location: Location, Reserved, In Stock, Available. Footer con totales si hay > 1 location.

---

## Reglas Críticas

1. **Products middleware: fetch con `relations: ["variants"]`** — sin esto los SKUs desaparecen
2. **Inventory: atomic replace (deleteAll + add)** — garantiza consistencia en sincronización completa
3. **Orphan filtering en inventory** — solo indexar items con `variantId` y `productId` válidos
4. **Bulk price load en inventory** — evita N+1 queries; carga todos los precios de una vez
5. **`category_handles` como array** — nunca como string; permite filtrado multi-nivel
6. **React Query key alignment** — el sync button debe invalidar el mismo query key que usa el hook
7. **`ENABLE_DYNAMIC_PRICING` requiere restart** — variable de entorno, no configurable en runtime

---

## Archivos Clave

| Tipo | Ruta Completa | Propósito |
|------|---------------|-----------|
| Sidebar hijacker | `backend/src/admin/widgets/sidebar-hijacker.tsx` | Redirige nav nativa a advanced pages |
| Middleware | `backend/src/api/middlewares.ts` | Auto-sync interceptor para las 3 entidades |
| Workflow products | `backend/src/workflows/sync-products.ts` | Full sync de productos con variantes |
| Workflow customers | `backend/src/workflows/sync-customers.ts` | Full sync de clientes con metadata QB |
| Workflow inventory | `backend/src/workflows/sync-inventory.ts` | Atomic replace + bulk price loading |
| Workflow single | `backend/src/workflows/update-single-product.ts` | Incremental product update |
| Job products+customers | `backend/src/jobs/reconcile-meilisearch.ts` | Cron 5 min |
| Job inventory | `backend/src/jobs/reconcile-inventory.ts` | Cron 5 min |
| Features endpoint | `backend/src/api/admin/config/features/route.ts` | Feature flags para frontend |
| Page products | `backend/src/admin/routes/products-advanced/page.tsx` | Products Advanced UI |
| Page customers | `backend/src/admin/routes/customers-advanced/page.tsx` | Customers Advanced UI |
| Page inventory | `backend/src/admin/routes/inventory-advanced/page.tsx` | Inventory Advanced UI |
| Hook inventory | `backend/src/admin/routes/inventory-advanced/hooks/use-feature-flags.ts` | Feature flags |
| Stock modal | `backend/src/admin/routes/inventory-advanced/components/inventory-stock-modal.tsx` | Modal por location |

---

## Historial de Decisiones

| Fecha | Decisión | Razón |
|-------|----------|-------|
| ~2026-01 | 3 capas de redundancia (middleware + cron + manual) | Subscribers de Medusa v2 no confiables; múltiples capas garantizan consistencia |
| ~2026-01 | Sidebar hijacker con History API | Redirigir sin romper la navegación SPA de React Router del admin |
| 2026-01-28 | Atomic replace para inventory | Relaciones complejas entre 3 módulos hacen el sync granular propenso a errores |
| 2026-01-28 | Bulk price load en inventory workflow | Evita N+1 queries (una query por variant para precios es inviable con 344+ items) |
| 2026-02-04 | Fix: React Query key mismatch en inventory | El sync button invalidaba un key diferente al que usaba el hook; UI no se actualizaba |
| 2026-02-22 | Stock Level Modal inline | Evitar navegación fuera de inventory-advanced para ver breakdown por location |
| 2026-02-22 | `ENABLE_DYNAMIC_PRICING` feature flag | Columnas dinámicas de price list son opcionales; no todas las instancias tienen wholesale |
| ~2026-01 | `category_handles` como array flatteado con padres | Permite filtrar por categoría padre ("wire") aunque el producto esté en la sub-categoría |
