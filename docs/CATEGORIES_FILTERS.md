# Categories — Filters System
> **Tipo**: Technical Reference
> **Repo**: backend
> **Última verificación**: 2026-04-02
> **Estado**: ✅ Current

---

## ¿Qué es y por qué existe?

El sistema de Category Filters permite configurar qué atributos de producto aparecen como filtros en la sidebar de las páginas de categoría en el frontend. Medusa v2 no tiene un sistema nativo de filtros por categoría.

Cada categoría almacena su configuración en `category.metadata.filter_config`. Los filtros disponibles (`available_filters`) se populan mediante Nuclear Sync; los activos (`active_filters`) los configura el admin manualmente.

---

## Arquitectura

### Flujo de datos

```
Nuclear Sync endpoint
    └─► Escanea productos en categoría + descendientes (recursión JS)
    └─► Query única con JOIN sobre tablas relacionales
    └─► Escribe available_filters en category.metadata.filter_config

Admin UI (/app/filters o widget en category detail)
    └─► Lee available_filters (curado)
    └─► Admin activa/desactiva filtros
    └─► Escribe active_filters en category.metadata.filter_config

Middleware (src/api/middlewares.ts)
    └─► Intercepta mutaciones de productos/categorías
    └─► Llama POST /admin/product-categories/:id/sync-attributes
    └─► Reconcilia available_filters (añade nuevos, elimina huérfanos)

Store API (/store/product-categories/:id/filters)
    └─► Lee filter_config
    └─► Resuelve herencia de padre si override_inheritance = false
    └─► Retorna filtros enriquecidos con metadata de AttributeKey
```

### Componentes

| Componente | Ruta | Propósito |
|-----------|------|-----------|
| Store API | `src/api/store/product-categories/[id]/filters/route.ts` | Endpoint público para frontend |
| Admin page | `src/admin/routes/filters/page.tsx` | Página `/app/filters` con drag-and-drop |
| Category widget | `src/admin/widgets/category-filters-widget.tsx` | Widget inline en category detail page |
| Nuclear sync (all) | `src/api/admin/product-categories/nuclear-sync/route.ts` | Popula available_filters en todas las categorías |
| Sync attributes (one) | `src/api/admin/product-categories/[id]/sync-attributes/route.ts` | Reconcilia una categoría (llamado por middleware) |
| Generate filters | `src/api/admin/product-categories/[id]/generate-filters/route.ts` | Guarda active_filters + genera filter counts |
| Resync all | `src/api/admin/product-categories/resync-all/route.ts` | Llama sync-attributes en todas las categorías |
| Cascade DELETE | `src/api/admin/attributes/[id]/route.ts` | Limpia referencias al eliminar un AttributeKey |

---

## Modelo de Datos / Estructura

### `category.metadata.filter_config`

```typescript
{
  available_filters: Array<{    // Populado por Nuclear Sync / sync-attributes
    attribute_id: string,       // ID del AttributeKey
    order: number,
    type: string                // "checkbox" (único tipo actual)
  }>,
  active_filters: Array<{       // Configurado por admin (subconjunto de available)
    attribute_id: string,
    order: number,
    type: string
  }>,
  override_inheritance: boolean // false = hereda filtros del padre
}
```

**Campo legacy (siendo eliminado):**
```typescript
category.metadata.available_attributes?: string[]  // IDs de AttributeKey — mantenido por middleware legacy
```

**Compatibilidad de formatos:** El sistema soporta tanto el formato string[] (viejo) como el formato objeto[] (nuevo) en `active_filters`. El código normaliza internamente.

```typescript
// Old format (still supported)
active_filters: ["attr_id_1", "attr_id_2"]

// New format (recommended)
active_filters: [
  { attribute_id: "attr_id_1", order: 0, type: "checkbox" },
  { attribute_id: "attr_id_2", order: 1, type: "checkbox" }
]
```

### Herencia de filtros

```
Electronics (override_inheritance: true, active_filters: [Power, Voltage])
├── LED Strips (override_inheritance: false)  → HEREDA [Power, Voltage]
└── Power Supplies (override_inheritance: true, active_filters: [Wattage, IP])
```

Cuando `override_inheritance: false`, el endpoint de store resuelve los filtros del padre y los valida contra el `available_filters` del hijo (solo muestra filtros que el hijo realmente tiene productos para).

### `category.metadata.include_descendants_tree`

Flag (default: `true`) que controla si al generar filtros se incluyen los productos de todas las subcategorías descendientes. Si `false`, solo se escanean los productos directamente en esa categoría.

---

## Flujo de Implementación

### 1. Nuclear Sync (poblar available_filters en todas las categorías)

```bash
# Via HTTP (botón en UI)
POST /admin/product-categories/nuclear-sync

# Via script
npx medusa exec src/scripts/nuclear/true-nuclear-sync.ts
```

**Algoritmo (dos fases):**

**Fase 1 — Auto-discover:**
1. Carga todas las categorías en memoria
2. Para cada categoría, calcula IDs de descendientes recursivamente (app-level JS, NO DB recursion)
3. Respeta `metadata.include_descendants_tree` (default: true)
4. Query de productos publicados en esas categorías
5. Query de attribute_values de esos productos via `query.graph`
6. Escribe `filter_config.available_filters` + auto-activa TODOS los filtros encontrados
7. Preserva `override_inheritance` existente

**Fase 2 — Generar filter counts:**
1. Re-fetch de categorías actualizadas
2. Para cada categoría con `active_filters`: llama a `generateFiltersForCategory`
3. Actualiza `metadata.filters` con los conteos calculados

**Métricas:** Redujo latencia de >7,936ms (timeout con CTEs recursivos de PostgreSQL) a ~225ms.

### 2. Sync-attributes (reconciliar una categoría — llamado por middleware)

```
POST /admin/product-categories/:id/sync-attributes
```

A diferencia del Nuclear Sync que auto-activa filtros, este endpoint **reconcilia sin auto-activar**:
1. Carga categoría con su metadata actual
2. Calcula descendientes con recursión JS en app-code
3. Query SQL directa con Knex: JOIN entre tabla pivot, attribute_value y product_category_product
4. Filtra `.whereNull("ppav.deleted_at")` y `.whereNull("av.deleted_at")`
5. **Reconcilia** `available_filters`: elimina los que ya no tienen productos, añade los nuevos
6. **Reconcilia** `active_filters`: elimina los que ya no están en `available_filters`
7. Preserva todos los demás campos de metadata (bug fix crítico)

### 3. Generate-filters (guardar active_filters del admin + generar conteos)

```
POST /admin/product-categories/:id/generate-filters
```

Body: `{ active_filters: [...], override_inheritance: boolean }`

1. Normaliza `active_filters` a string[] para el generator
2. Respeta `metadata.include_descendants_tree`
3. Si `available_filters` está vacío, genera uno automáticamente (mini nuclear sync)
4. Si `override_inheritance: false`, valida los filtros heredados contra el `available_filters` del hijo
5. Escribe metadata con Knex directo (más seguro que Medusa ORM para metadata)
6. Retorna `{ success, filters_generated, total_products }`

### 4. Configurar active_filters (Admin UI)

**Opción A — Filters page (`/app/filters`):**
1. Seleccionar categoría
2. Marcar/desmarcar atributos de `available_filters` (solo los curados, no los 121 del sistema)
3. Ajustar orden con drag-and-drop
4. Guardar → POST `/admin/product-categories/:id/generate-filters`

**Opción B — Widget en category detail:**
1. Ir a `/app/categories/:id`
2. Scroll al widget "Category Filters"
3. Click "Edit" → modal con checkboxes (solo curated list)
4. Guardar → POST nativo de categoría con merge de metadata

**Bug fix crítico (2026-01-31):** El endpoint de save excluye explícitamente `available_filters` del spread para no sobreescribirlo:
```typescript
const {
    filter_config: _removed,  // Excluir para rebuild
    ...cleanExistingMetadata
} = category.metadata || {}
```

### 5. Cascade deletion al eliminar attributo

Al hacer `DELETE /admin/attributes/:id`, el endpoint limpia las referencias de filtros de TODAS las categorías:
1. Fetch de todas las categorías via HTTP
2. Para cada categoría con `filter_config`: eliminar el atributo de `active_filters` y `available_filters`
3. Recomputa `order` de los filtros que quedan (sin gaps)

---

## Nuclear Sync Algorithm — Query SQL Clave

```sql
SELECT DISTINCT av.attribute_key_id
FROM product_product_productattributes_attribute_value ppav
INNER JOIN attribute_value av ON ppav.attribute_value_id = av.id
INNER JOIN product_category_product pcp ON ppav.product_id = pcp.product_id
WHERE pcp.product_category_id = ANY(?::text[])
  AND ppav.deleted_at IS NULL
  AND av.deleted_at IS NULL
```

Esta query con `ANY($array)` en lugar de subquery es 100x más rápida que N+1 queries o CTEs recursivos.

---

## Store API: Respuesta de Filtros

```http
GET /store/product-categories/:id/filters
```

```json
{
  "category_id": "pcat_01...",
  "category_name": "LED Strips",
  "category_handle": "led-strips",
  "filters": [
    {
      "id": "attr_key_01...",
      "label": "Power",
      "handle": "power",
      "type": "checkbox",
      "order": 0,
      "display_name": "Wattage",
      "unit": "W",
      "icon": "bolt",
      "description": "Select power consumption",
      "values": [
        { "id": "attr_val_01...", "value": "12W" },
        { "id": "attr_val_02...", "value": "24W" }
      ]
    }
  ],
  "inherited": false
}
```

---

## Admin API — Todas las Rutas

| Método | Ruta | Propósito |
|--------|------|-----------|
| `POST` | `/admin/product-categories/nuclear-sync` | Nuclear sync en TODAS las categorías (2 fases) |
| `POST` | `/admin/product-categories/resync-all` | Llama sync-attributes en todas las categorías |
| `POST` | `/admin/product-categories/:id/sync-attributes` | Reconciliar available/active filters (middleware) |
| `POST` | `/admin/product-categories/:id/generate-filters` | Guardar active_filters + generar conteos |
| `GET` | `/store/product-categories/:id/filters` | Obtener filtros para el frontend (público) |

---

## Widget de Category Detail

**Archivo:** `src/admin/widgets/category-filters-widget.tsx`

El widget pasa `availableAttrs` (filtrado desde `filter_config.available_filters`) al modal — **no** el listado completo de 121+ atributos del sistema:

```tsx
// ✅ CORRECTO — lista curada (e.g. 33 filtros)
<ManageFiltersModal availableAttributes={availableAttrs} ... />

// ❌ INCORRECTO — mostraría 121 atributos del sistema
<ManageFiltersModal availableAttributes={attributes} ... />
```

**Funcionalidades del widget:**
- View mode: Active Filters (badges azules), Available Filters, badge "Override" si herencia desactivada
- Edit mode: checkboxes sobre la lista curada, toggle de herencia, counter en tiempo real

---

## Soft-Delete Filtering — Regla Crítica

`remoteLink.delete()` de Medusa v2 **NO elimina el registro** — lo marca con `deleted_at`. Sin filtrar este campo, atributos eliminados aparecen como opciones de filtro válidas.

**Todas las queries sobre la tabla pivot deben incluir:**
```typescript
.whereNull("deleted_at")  // Excluir links soft-deleted
```

**NUNCA usar `remoteLink.delete()`** para links producto-atributo. Usar siempre hard delete via Knex `.del()`.

**Cleanup de ghost data acumulado:**
```bash
npx medusa exec src/scripts/fix/cleanup-all-soft-deletes.ts
npx medusa exec src/scripts/sync/mass-sync-all-filters.ts
npx medusa exec src/scripts/verify/verify-category-filters.ts
```

---

## Reglas Críticas

1. **NUNCA sobrescribir `available_filters` al guardar `active_filters`** — usar destructuring exclusion
2. **Siempre filtrar `.whereNull("deleted_at")`** al leer la tabla pivot de atributos
3. **HTTP pattern para categorías en admin context** — no se puede resolver `productCategoryModuleService` directamente en admin routes
4. **Nuclear sync es el paso previo obligatorio** — sin él, `available_filters` está vacío y el widget muestra todos los atributos del sistema
5. **Recursión JS, no CTE recursivo** — los CTEs recursivos de PostgreSQL son más lentos para árboles grandes
6. **`ANY($array)` en lugar de IN con subquery** — PostgreSQL optimiza mejor `ANY`
7. **Knex directo para escritura de metadata** — más confiable que Medusa ORM para JSONB

---

## Archivos Clave

| Tipo | Ruta Completa | Propósito |
|------|---------------|-----------|
| Store API filters | `backend/src/api/store/product-categories/[id]/filters/route.ts` | Endpoint público |
| Nuclear sync | `backend/src/api/admin/product-categories/nuclear-sync/route.ts` | Poblar available_filters en todo |
| Sync-attributes | `backend/src/api/admin/product-categories/[id]/sync-attributes/route.ts` | Reconciliar una categoría |
| Generate-filters | `backend/src/api/admin/product-categories/[id]/generate-filters/route.ts` | Guardar activos + conteos |
| Resync-all | `backend/src/api/admin/product-categories/resync-all/route.ts` | Trigger en todas |
| Cascade DELETE | `backend/src/api/admin/attributes/[id]/route.ts` | Cleanup al eliminar atributo |
| Generator util | `backend/src/modules/category-filters/utils/filter-generator.ts` | Genera objetos de filtro con conteos |
| Admin filters page | `backend/src/admin/routes/filters/page.tsx` | UI de configuración con drag-and-drop |
| Category widget | `backend/src/admin/widgets/category-filters-widget.tsx` | Widget inline en category detail |
| Middlewares | `backend/src/api/middlewares.ts` | Auto-sync de available_filters vía sync-attributes |
| Script cleanup | `backend/src/scripts/fix/cleanup-all-soft-deletes.ts` | Elimina ghost records definitivamente |
| Script mass sync | `backend/src/scripts/sync/mass-sync-all-filters.ts` | Regenera filtros en todas las categorías |
| Script verify | `backend/src/scripts/verify/verify-category-filters.ts` | Verifica consistencia de filtros |

---

## Historial de Decisiones

| Fecha | Decisión | Razón |
|-------|----------|-------|
| ~2026-01 | Recursión JS en lugar de CTE recursivo | CTEs recursivos se colgaban con 125+ descendientes (>7,936ms → ~225ms) |
| ~2026-01 | JOIN con `ANY($array)` en lugar de N+1 queries | Reducción masiva de latencia |
| 2026-01-30 | `.whereNull("deleted_at")` en filter generator | Links soft-deleted causaban valores fantasma |
| 2026-01-31 | Preservar `available_filters` en save endpoint | Bug: spread conflict borraba `available_filters` al guardar `active_filters` |
| 2026-01-31 | Widget inline en category detail page | Acceso rápido sin navegar a `/app/filters` |
| 2026-01-31 | Mostrar lista curada en widget modal | Modal mostraba 121 atributos del sistema en lugar de los 33 curados |
| ~2026-01 | HTTP pattern para categorías en admin context | Admin routes no pueden resolver `productCategoryModuleService` directamente |
| ~2026-01 | `include_descendants_tree` en metadata | Algunas categorías solo deben mostrar sus propios productos, no los de subcategorías |
