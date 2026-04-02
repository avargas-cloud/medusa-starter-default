# Categories — Products Endpoint Optimizations
> **Tipo**: Technical Reference
> **Repo**: backend
> **Última verificación**: 2026-04-02
> **Estado**: ✅ Current

---

## ¿Qué es y por qué existe?

Documenta las optimizaciones de rendimiento del endpoint `/store/product-categories/:id/products-with-filters`, que combina fetch de productos con generación de filtros para páginas de categoría en el storefront.

**Mejora obtenida:** 85-97% de reducción en latencia para categorías grandes (de 7.9s a <400ms en estado cacheado).

---

## Arquitectura

### Endpoint

```
GET /store/product-categories/:id/products-with-filters?page=1&limit=20&sort=title&order=asc
```

**Archivo:** `src/api/store/product-categories/[id]/products-with-filters/route.ts`

### Tres capas de optimización

```
1. Batch Price Query      → 1 query para todos los variantes (en lugar de N+1)
2. Direct SQL COUNT       → Conteo sin fetch previo de todos los productos
3. Recursive CTE          → Descendientes de categoría en 1 sola query SQL
```

---

## Modelo de Datos / Estructura

### Paginación y respuesta

```typescript
// Query params
?page=1&limit=20&sort=title&order=asc

// Response
{
  products: EnrichedProduct[],
  pagination: {
    total: number,
    page: number,
    limit: number,
    total_pages: number
  },
  filters: FilterConfig   // Generados por filter-generator.ts
}
```

---

## Flujo de Implementación

### Optimización 1: Batch Price Query

**Archivo:** `src/api/store/_shared/product-enrichment.ts`

En lugar de query por variante, una sola query para todos los variantes:

```typescript
const allVariantIds = products.flatMap(p => p.variants.map(v => v.id))

const allPrices = await knex("price")
  .select("price.amount", "price.currency_code", "product_variant_price_set.variant_id")
  .join("product_variant_price_set", "price.price_set_id", "product_variant_price_set.price_set_id")
  .whereIn("product_variant_price_set.variant_id", allVariantIds)
  .where("price.currency_code", "usd")
  .whereNull("price.deleted_at")

// Map O(1) para acceso
const pricesByVariant = new Map(allPrices.map(p => [p.variant_id, p.amount]))
```

**Resultado:** ~42% de mejora (3.2s → 1.8s)

### Optimización 2: Direct SQL COUNT

```typescript
const countResult = await knex("product")
  .join("product_category_product", "product.id", "product_category_product.product_id")
  .whereIn("product_category_product.product_category_id", categoryIds)
  .where("product.status", "published")
  .whereNull("product.deleted_at")
  .countDistinct("product.id as count")
  .first()

const totalCount = parseInt(String(countResult?.count || "0"))
```

**Resultado:** Elimina el fetch redundante de todos los productos solo para contarlos.

### Optimización 3: PostgreSQL Recursive CTE

En lugar de múltiples queries para obtener descendientes:

```typescript
async function getCategoryDescendants(categoryId: string, knex: Knex): Promise<string[]> {
  const result = await knex.raw(`
    WITH RECURSIVE descendants AS (
      SELECT id FROM product_category
      WHERE parent_category_id = ? AND deleted_at IS NULL
      UNION
      SELECT pc.id FROM product_category pc
      INNER JOIN descendants d ON pc.parent_category_id = d.id
      WHERE pc.deleted_at IS NULL
    )
    SELECT id FROM descendants;
  `, [categoryId])

  return result.rows.map((row: { id: string }) => row.id)
}
```

**Resultado:** 1 query para cualquier cantidad de descendientes (vs 125 queries para 125 categorías).

### Activación de descendientes

La categoría debe tener `metadata.include_descendants_tree = true` para activar la traversal de descendientes. Si no está explícitamente seteado, no incluye descendientes.

---

## API / Interfaces

```http
GET /store/product-categories/:id/products-with-filters?page=1&limit=20
```

**Rendimiento esperado:**

| Tipo de categoría | Descendientes | Cold (sin cache) | Hot (con Redis) |
|------------------|--------------|-----------------|-----------------|
| Pequeña | 1-20 | < 1.5s | < 500ms |
| Mediana | 20-50 | < 2.0s | < 500ms |
| Grande | 50+ | < 3.0s | < 500ms |

Redis TTL: 15 minutos.

---

## Reglas Críticas

1. **Batch queries siempre** — nunca queries dentro de loops de productos o variantes
2. **Recursive CTE para descendientes** — no loops con queries individuales por nivel
3. **`include_descendants_tree: true` en metadata** — la categoría debe habilitarlo explícitamente
4. **`whereNull("deleted_at")`** en todas las queries — productos y categorías eliminados deben excluirse

---

## Archivos Clave

| Tipo | Ruta Completa | Propósito |
|------|---------------|-----------|
| Endpoint | `backend/src/api/store/product-categories/[id]/products-with-filters/route.ts` | Endpoint principal con CTE + COUNT |
| Enrichment | `backend/src/api/store/_shared/product-enrichment.ts` | Batch price query |
| Filter calc | `backend/src/api/store/_shared/filter-calculation.ts` | Cálculo de filtros disponibles |

---

## Historial de Decisiones

| Fecha | Decisión | Razón |
|-------|----------|-------|
| ~2026-01 | Recursive CTE en lugar de loops de queries | 7.9s → <400ms en categorías con 125 descendientes |
| ~2026-01 | Batch price query en `product-enrichment.ts` | N+1 queries eran el principal cuello de botella |
| ~2026-01 | Direct SQL COUNT | Eliminar fetch completo de productos solo para contar |
