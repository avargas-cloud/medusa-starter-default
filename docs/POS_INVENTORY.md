# POS_INVENTORY — Inventario

| Campo | Detalle |
|-------|---------|
| **Módulo** | Inventory |
| **Ruta POS** | `/inventory` |
| **Admin Avanzado** | `Admin > Inventory Advanced` |
| **Search** | MeiliSearch (`inventory` index) |
| **Backend** | Medusa v2 Inventory Module |
| **Sync Workflow** | `backend/src/workflows/sync-inventory.ts` |
| **Última revisión** | 2026-03-11 |

---

## Descripción General

El módulo de Inventory tiene dos niveles:

1. **POS (`/inventory`)** — Página de consulta de stock en tiempo real para el staff
2. **Admin Advanced (`/inventory-advanced`)** — Vista con MeiliSearch avanzado, columnas de precio por lista, modal de stock por location, y botones de sync

El índice MeiliSearch `inventory` es la fuente primaria para búsquedas rápidas. Medusa es la fuente de verdad para stock levels en tiempo real.

---

## 1. Búsqueda de Productos — `ItemSearch` (POS-wide)

**Componente:** `components/pos/ItemSearch.tsx`

La búsqueda de productos en el POS (usada en Estimates, Orders y la página de Inventory) consulta el índice **`inventory`** en MeiliSearch — **no** el índice `products`.

### ¿Por qué el índice `inventory` y no `products`?

El índice `inventory` es un "Gold Standard" porque:

- Cada **variante** es un documento independiente (flattened)
- Incluye precios precomputados por Price List (`pricesByList`)
- Incluye `variantId`, `productId`, `sku`, `handle`
- Elimina la lógica de mapeo de variantes en el frontend
- Latencia < 50ms vs. ~200ms de una query Medusa

### Estructura del Documento `inventory` en MeiliSearch

```typescript
// Index: inventory — un documento por variante
{
    id: string,               // inventoryItemId
    title: string,            // product.title + " — " + variant.title
    thumbnail: string | null, // product.thumbnail
    sku: string,              // variant.sku
    handle: string,           // product.handle (usado para link al storefront)
    price: number,            // precio retail base en DÓLARES
    currencyCode: string,     // 'usd'
    pricesByList: Record<string, number>, // { "Wholesale": 45.00, "list_xxx": 38.00 }
    variantId: string,        // variant.id de Medusa
    productId: string,        // product.id de Medusa
    status: string,           // 'published' | 'draft'
}
// Campos buscables: title, sku, handle
```

### Selección de Precio según Customer

Al agregar un item, el POS evalúa el `Price Level` del cliente contra `pricesByList`:

```typescript
// lib/meilisearch.ts → searchAdvancedInventory()
// attributesToRetrieve incluye: ..., 'handle', 'status', 'pricesByList', 'variantId'

// En ItemSearch.tsx, al seleccionar:
const customerPriceLevel = doc.customer?.metadata?.price_level  // ej. 'Wholesale'
const unitPrice = hit.pricesByList?.[customerPriceLevel] ?? hit.price
```

---

## 2. Lista de Inventario POS (`/inventory`)

**Archivo:** `app/(pos)/inventory/page.tsx`

### 2.1 Fuente de Datos

- MeiliSearch (`searchAdvancedInventory`) → todos los items del índice `inventory`
- Búsqueda por: SKU, nombre de producto, handle
- Filtros: ubicación, nivel de stock (en stock / bajo stock / agotado)

### 2.2 Columnas de la Tabla

```
SKU | Descripción | Variante | [Precio por price list...] | WHOLESALE PRICE | Status
```

Layout: `gridTemplateColumns` en `page.tsx` — la columna Description tiene **+20% de ancho** y hay una columna `Status` de 90px al final.

| Columna | Fuente |
|---------|--------|
| SKU | `hit.sku` |
| Description | `hit.title` (ancho expandido ~30%) |
| Variant | `hit.variantTitle` |
| [Price lists] | `hit.pricesByList` dinámico |
| WHOLESALE PRICE | precio de la lista "Wholesale" |
| **Status** | `hit.status` — badge coloreado |

### 2.3 Columna Status

| Valor | Badge | Color |
|-------|-------|-------|
| `draft` | **LOCAL** | Gris neutro |
| `published` | **LIVE ↗** | Verde — clickeable, abre el storefront |

**Link del badge LIVE:**

```typescript
// InventoryRow.tsx
const STOREFRONT_URL = process.env.NEXT_PUBLIC_STOREFRONT_URL?.replace(/\/$/, '')
    || 'https://ecopowertech.com'

// El link usa el handle del producto:
const storefrontUrl = `${STOREFRONT_URL}/products/${hit.handle}`
// Abre en nueva pestaña con target="_blank" + rel="noopener noreferrer"
```

> ⚙️ Configurar `NEXT_PUBLIC_STOREFRONT_URL` en `.env` del POS. Valor actual: `https://ecopowertech-headless-medusa.vercel.app`

### 2.4 Headers de Precio

Los headers de columnas de Price Lists tienen el sufijo " Price" para claridad:
- `Wholesale` → **"Wholesale Price"**
- `Custom List` → **"Custom List Price"**
- La columna "WHOLESALE PRICE" tiene el título en mayúsculas como diferenciador visual

---

## 3. Stock por Ubicación

Medusa v2 soporta múltiples `stock_locations`. El POS muestra el stock por location en tiempo real:

```
Product: EcoPower Solar Panel 300W (SKU: SP-300W)
│
├── Warehouse A    → 45 units
├── Warehouse B    →  8 units (⚠️ bajo stock)
└── Floor/Display  →  2 units
```

**Endpoints:**

```
GET /admin/inventory-items                         Lista general
GET /admin/inventory-items/:id/location-levels     Stock por ubicación (real-time)
GET /admin/stock-locations                         Lista de ubicaciones configuradas
POST /admin/inventory-items/:id/location-levels   Ajuste manual de stock
```

**Ajuste de stock:**

```typescript
POST /admin/inventory-items/:id/location-levels
{
    location_id: "sloc_01XXX",
    stocked_quantity: 50
}
```

---

## 4. Admin Advanced (`/inventory-advanced`)

**Ruta Admin:** Medusa Admin → sidebar → Inventory Advanced

Este es el reemplazo completo de la página nativa de Inventory de Medusa, con:

- Búsqueda en tiempo real con MeiliSearch
- Columnas dinámicas de precio por Price List
- Columna "Available" (In Stock − Reserved, calculado en frontend)
- **Stock Level Modal** — breakdown por location al dar clic en Reserved/In Stock/Available
- **Click-to-edit prices** — Retail Price y Price List prices abren editor en nueva pestaña

### 4.1 Sync Buttons

El header de Inventory Advanced tiene dos botones:

| Botón | Qué hace |
|-------|---------|
| **Check Inventory Sync** | Smart check: compara count y timestamp entre Medusa y MeiliSearch; solo re-indexa si difieren |
| **Force Sync** | Bypasea el smart check y re-indexa completamente sin importar el estado |

**¿Cuándo usar Force Sync?**
- Después de correr un script que modifica el contenido de documentos sin cambiar el total de items (ej. agregar campo `handle` al índice)
- Cuando sospechas que el índice tiene datos corruptos o stale

---

## 5. Sincronización MeiliSearch — Auto-Sync en 3 Capas

### 5.1 Capa 1: Middleware Automático

El middleware detecta cambios en inventory y dispara `syncInventoryWorkflow` automáticamente:

```
Cambio en /admin/inventory-items/*
  → Middleware detecta la ruta
  → Ejecuta syncInventoryWorkflow
  → MeiliSearch actualizado en segundos
```

### 5.2 Capa 2: Reconciliation Job

Cron job cada 5 minutos que ejecuta `syncInventoryWorkflow` como backup:

- Garantiza consistencia aunque el middleware falle
- Sin impacto en performance del usuario

### 5.3 Capa 3: Sync Manual

**Via botón en Admin:**
- `Admin > Inventory Advanced` → **Check Inventory Sync** o **Force Sync**
- Llama a `POST /admin/search/inventory/sync` (o `?force=true` para Force Sync)

**Via script desde terminal:**

```bash
# Script de sync directo:
cd backend && npx ts-node src/scripts/sync/sync-meili-inventory.ts

# Via endpoint con fuerza:
curl -X POST "http://localhost:9000/admin/search/inventory/sync?force=true" \
  -H "Authorization: Bearer $TOKEN"
```

### 5.4 Workflow de Sync (`sync-inventory.ts`)

El workflow `syncInventoryWorkflow` hace una query GraphQL completa a Medusa que incluye:

```typescript
// backend/src/workflows/sync-inventory.ts
// Campos fetcheados por cada variante:
select: [
    'id', 'sku', 'title', 'thumbnail', 'status',
    'product.id', 'product.title', 'product.thumbnail',
    'product.handle',      // ← para links al storefront
    'product.status',
    'prices.*',            // todos los price lists
    'inventory_items.*',
]
```

El documento generado en MeiliSearch incluye `handle` para que el badge LIVE pueda construir el URL del storefront.

---

## 6. Edición de Ítems — `ItemDetailModal`

El POS permite editar propiedades físicas y comerciales directamente desde la grilla de inventario. Los datos provienen de **dos entidades distintas** en Medusa v2:

| Entidad | Campos |
|---------|--------|
| `InventoryItem` | `sku`, `title`, `weight`, `length`, `width`, `height`, `hs_code`, `mid_code`, `material` |
| `Product` (metadata) | `sales_description`, `mpn`, `vendor` |

### Estrategia de Fetch y Guardado

```typescript
// Al abrir el modal: dos queries en paralelo
Promise.all([
    GET /admin/inventory-items/:id,
    GET /admin/products/:productId?fields=+metadata
])

// Al guardar: dos POST en paralelo
Promise.all([
    POST /admin/inventory-items/:id,     // dimensiones y atributos aduaneros
    POST /admin/products/:productId,     // metadata (sales_description, mpn, vendor)
])
```

> ⚠️ **Importante:** Las dimensiones de envío (`weight`, `length`, `width`, `height`) del `InventoryItem` son la fuente primaria para el cotizador UPS — tienen prioridad sobre las dimensiones del `Variant`.

### Validación de Guardado

- El botón "Save Changes" está deshabilitado hasta que el usuario modifique al menos un campo (`isDirty`)
- Se omiten atributos del nivel `Variant` (como `barcode` y `country_of_origin`) del payload de `InventoryItem` para prevenir errores HTTP 400

---

## 7. Endpoints Relevantes

```
# MeiliSearch (POS Frontend)
searchAdvancedInventory(query, filters)   → lib/meilisearch.ts

# Medusa Admin API (backend)
GET  /admin/inventory-items               Lista de inventory items
GET  /admin/inventory-items/:id           Item individual
GET  /admin/inventory-items/:id/location-levels  Stock por ubicación
POST /admin/inventory-items/:id/location-levels  Ajuste de stock
GET  /admin/stock-locations               Ubicaciones disponibles
GET  /admin/products/:id                  Para metadata del producto

# Sync Endpoints (admin auth requerida)
POST /admin/search/inventory/sync         Smart sync (count + timestamp check)
POST /admin/search/inventory/sync?force=true  Force sync (bypasea smart check)
```

---

## 8. Variables de Entorno

| Variable | Archivo | Descripción |
|----------|---------|-------------|
| `NEXT_PUBLIC_STOREFRONT_URL` | `ecopowertech-store-pos/.env` | URL base del storefront para links de productos |
| `NEXT_PUBLIC_MEILISEARCH_HOST` | `ecopowertech-store-pos/.env` | URL del servidor MeiliSearch |
| `NEXT_PUBLIC_MEILISEARCH_SEARCH_KEY` | `ecopowertech-store-pos/.env` | API key de solo lectura |
| `MEILISEARCH_HOST` | `backend/.env` | URL MeiliSearch para el backend |
| `MEILISEARCH_API_KEY` | `backend/.env` | API key con permisos de escritura |

---

## 9. Known Issues

| Issue | Fix |
|-------|-----|
| Badge LIVE abre URL incorrecta | Verificar `NEXT_PUBLIC_STOREFRONT_URL` en `.env` del POS |
| Item aparece como LOCAL aunque esté publicado | Re-sincronizar: Force Sync en Admin > Inventory Advanced |
| Precio no actualizado en ItemSearch | Force Sync — el count puede ser igual aunque los precios hayan cambiado |
| Stock no coincide con Medusa Admin | Datos de location-levels vienen de Medusa real-time — verificar sesión o red |
| Múltiples variantes con mismo SKU | SKU debe ser único por variante en el índice `inventory` |
| Items con `handle` null (link roto) | Ejecutar Force Sync — el `handle` se añadió al workflow en 2026-03-11. Items indexados antes de esa fecha no lo tienen |

---

## Changelog

### 2026-03-11 — Status Column + Force Sync + Storefront Link

**Cambios en la tabla de inventario POS (`/inventory`):**

1. **Nueva columna Status** — al final de la tabla, 90px de ancho
2. **Badge "Local"** (antes "Draft") — items no publicados
3. **Badge "LIVE ↗"** — items publicados, clickeable, abre el producto en el storefront
4. **Descripción más ancha** — +30% vs. antes (`0.5fr` → `0.65fr`)
5. **Headers de precio con sufijo " Price"** — "Wholesale Price", "Custom List Price", etc.
6. **`NEXT_PUBLIC_STOREFRONT_URL`** — nuevo env var para el URL del storefront

**Cambios en el backend:**

1. **`sync-inventory.ts`** — agrega `product.handle` a los campos fetcheados de Medusa y al documento de MeiliSearch
2. **`lib/meilisearch.ts`** — agrega `'handle'` a `attributesToRetrieve` de `searchAdvancedInventory`
3. **Endpoint `/admin/search/inventory/sync`** — soporte para `?force=true` que bypasea el smart check
4. **Endpoint `/admin/search/products/sync`** — soporte para `?force=true`
5. **`SyncStatusButton`** — nuevo prop `showForceSync={true}` para mostrar el botón Force Sync
6. **Admin Inventory Advanced** — botón Force Sync visible junto a Check Inventory Sync
7. **Admin Products Advanced** — botón Force Sync visible junto a Check Sync
