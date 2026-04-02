# POS Inventory — Gestión de Inventario
> **Tipo**: Technical Reference
> **Repo**: backend
> **Última verificación**: 2026-04-02
> **Estado**: ✅ Current

---

## ¿Qué es y por qué existe?

El módulo de Inventory tiene dos niveles: (1) la página de consulta rápida de stock para el staff del POS `/inventory`, y (2) el panel avanzado `Admin > Inventory Advanced` con edición, precios por lista y sync. El índice MeiliSearch `inventory` es la fuente primaria para búsquedas; Medusa es la fuente de verdad para stock en tiempo real.

---

## Arquitectura

```
POS /inventory
    └── MeiliSearch (índice: inventory) → searchAdvancedInventory()

Admin /inventory-advanced
    ├── MeiliSearch (búsqueda rápida)
    ├── GET /admin/inventory-items/:id/location-levels (stock real-time)
    └── GET /admin/stock-locations

Sync en 3 capas:
    ├── Middleware automático → syncInventoryWorkflow (al detectar cambio)
    ├── Cron job cada 5 min → syncInventoryWorkflow (reconciliation)
    └── Manual → POST /admin/search/inventory/sync (smart) o ?force=true
```

### Índice MeiliSearch `inventory`

```typescript
// Un documento por VARIANTE (flattened):
{
    id: string,               // inventoryItemId
    title: string,            // product.title + " — " + variant.title
    thumbnail: string | null,
    sku: string,
    handle: string,           // product.handle (para link al storefront)
    price: number,            // precio retail en DÓLARES
    currencyCode: string,     // 'usd'
    pricesByList: Record<string, number>, // { "Wholesale": 45.00, ... }
    variantId: string,
    productId: string,
    status: string,           // 'published' | 'draft'
}
// Campos buscables: title, sku, handle
```

---

## Modelo de Datos / Estructura

### Selección de Precio según Customer

```typescript
// Al seleccionar un ítem en ItemSearch.tsx:
const customerPriceLevel = customer?.metadata?.price_level  // ej. 'Wholesale'
const unitPrice = hit.pricesByList?.[customerPriceLevel] ?? hit.price
```

### Columna Status en Tabla de Inventario POS

| Valor `hit.status` | Badge | Color | Comportamiento |
|--------------------|-------|-------|----------------|
| `draft` | LOCAL | Gris neutro | No clickeable |
| `published` | LIVE ↗ | Verde | Clickeable → abre storefront |

**URL del badge LIVE:**
```typescript
// NEXT_PUBLIC_STOREFRONT_URL del .env del POS
const storefrontUrl = `${STOREFRONT_URL}/products/${hit.handle}`
```

### ItemDetailModal — Dos Entidades

| Entidad | Campos |
|---------|--------|
| `InventoryItem` | `sku`, `title`, `weight`, `length`, `width`, `height`, `hs_code`, `mid_code`, `material` |
| `Product` (metadata) | `sales_description`, `mpn`, `vendor` |

Las dimensiones del `InventoryItem` tienen prioridad sobre las del `Variant` para cotizaciones UPS.

---

## Flujo de Implementación

### Sync Manual — Diferencia entre Smart y Force

| Botón | Comportamiento |
|-------|---------------|
| Check Inventory Sync | Smart: compara count + timestamp entre Medusa y MeiliSearch; solo re-indexa si difieren |
| Force Sync | Bypasea el smart check y re-indexa completo — usar cuando los datos cambiaron sin cambiar el count (ej. se agregó campo `handle`) |

### Workflow `syncInventoryWorkflow`

Campos que se fetchean de Medusa por variante:
```typescript
select: [
    'id', 'sku', 'title', 'thumbnail', 'status',
    'product.id', 'product.title', 'product.thumbnail',
    'product.handle',
    'product.status',
    'prices.*',
    'inventory_items.*',
]
```

### Endpoint `/admin/inventory/with-prices`

Endpoint custom que devuelve inventario con precios por lista de precio, usado en Admin panel avanzado:

```
GET /admin/inventory/with-prices
→ Lista de variantes con pricesByList incluido
```

---

## API / Interfaces

### Endpoints de Stock

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/admin/inventory-items` | Lista general |
| `GET` | `/admin/inventory-items/:id` | Item individual |
| `GET` | `/admin/inventory-items/:id/location-levels` | Stock por ubicación (real-time) |
| `POST` | `/admin/inventory-items/:id/location-levels` | Ajuste manual de stock |
| `GET` | `/admin/stock-locations` | Ubicaciones disponibles |
| `GET` | `/admin/inventory/with-prices` | Inventario con precios por lista (custom) |

### Endpoints de Sync

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/admin/search/inventory/sync` | Smart sync |
| `POST` | `/admin/search/inventory/sync?force=true` | Force sync |
| `POST` | `/admin/search/inventory/update` | Actualización incremental |
| `POST` | `/admin/search/inventory/query` | Query custom al índice |

---

## Variables de Entorno

| Variable | Archivo | Descripción |
|----------|---------|-------------|
| `NEXT_PUBLIC_STOREFRONT_URL` | `store-pos/.env` | URL base del storefront para links de productos |
| `NEXT_PUBLIC_MEILISEARCH_HOST` | `store-pos/.env` | URL MeiliSearch |
| `NEXT_PUBLIC_MEILISEARCH_SEARCH_KEY` | `store-pos/.env` | API key read-only |
| `MEILISEARCH_HOST` | `backend/.env` | URL MeiliSearch (backend) |
| `MEILISEARCH_API_KEY` | `backend/.env` | API key con permisos de escritura |

---

## Reglas Críticas

- La búsqueda de productos en POS (Estimates, Orders, Inventory) usa el índice `inventory`, NO el índice `products`. Cada variante es un documento independiente.
- Items con `handle: null` rompen el link del badge LIVE — ejecutar Force Sync para regenerar con el campo `handle` (agregado al workflow en 2026-03-11)
- Si los precios cambiaron pero el count no → usar Force Sync (el smart check no lo detecta)
- `ItemDetailModal` omite atributos del nivel `Variant` (barcode, country_of_origin) del payload de `InventoryItem` para evitar HTTP 400

---

## Archivos Clave

| Tipo | Ruta Completa | Propósito |
|------|---------------|-----------|
| Workflow | `backend/src/workflows/sync-inventory.ts` | Sync completo Medusa → MeiliSearch |
| API | `backend/src/api/admin/search/inventory/sync/route.ts` | Smart/Force sync endpoint |
| API | `backend/src/api/admin/search/inventory/update/route.ts` | Actualización incremental |
| API | `backend/src/api/admin/search/inventory/query/route.ts` | Query custom |
| API | `backend/src/api/admin/inventory/with-prices/route.ts` | Inventario con precios por lista |
| Admin UI | `backend/src/admin/routes/inventory-advanced/page.tsx` | Página Inventory Advanced |

---

## Troubleshooting

| Error | Solución |
|-------|---------|
| Badge LIVE abre URL incorrecta | Verificar `NEXT_PUBLIC_STOREFRONT_URL` en `.env` del POS |
| Item aparece como LOCAL aunque esté publicado | Force Sync en Admin > Inventory Advanced |
| Precio no actualizado en ItemSearch | Force Sync — el count puede ser igual aunque los precios cambiaron |
| Stock no coincide con Medusa Admin | Datos de location-levels son real-time — verificar sesión o red |
| Items con `handle` null (link roto) | Force Sync — el campo `handle` fue agregado al workflow en 2026-03-11 |
