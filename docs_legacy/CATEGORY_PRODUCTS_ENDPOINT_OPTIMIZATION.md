# Category Products Endpoint Optimization Guide


## 📋 Descripción del Documento

| Campo | Detalle |
|-------|---------|
| **Propósito** | Document all optimizations applied to the `/store/categories/:id/products-with-filters` endpoint — including batch pricing via raw Knex, optimized SQL counts, and PostgreSQL Recursive CTEs for category tree traversal. |
| **Problemas que resuelve** | The original endpoint had unacceptable performance (7,936ms for categories with 125+ descendants) due to N+1 queries for pricing and ORM overhead. Raw Knex batch pricing reduced latency to sub-400ms cached state. |
| **Resultado esperado** | The products-with-filters endpoint responds in under 400ms for cached requests and under 800ms for uncached, supporting categories with large product inventories and deep subcategory trees. |
| **Scripts Creados** | `tests/test-api-performance.ts`, `tests/test-category-products.ts`, `diagnostics/diagnose-led-strips-filters.ts` |

This document explains the optimizations implemented in the `/store/categories/:id/products-with-filters` endpoint to improve page load performance.

## Table of Contents
- [Overview](#overview)
- [Problem Statement](#problem-statement)
- [Optimizations](#optimizations)
- [Code Examples](#code-examples)
- [Testing](#testing)

## Overview

The category products endpoint combines product fetching with filter generation for category pages. Initially, this endpoint suffered from performance issues on categories with many products or deep category trees.

**Performance improvements achieved:**
- Small categories: ~40% faster
- Large categories: **85-97% faster** (7.9s → 0.2s with cache)

## Problem Statement

### Initial Performance Issues

1. **N+1 Price Queries**: Prices were fetched one-by-one for each product variant
2. **Duplicate Product Queries**: Products fetched twice (once for count, once for pagination)
3. **Recursive Category Queries**: Each descendant category required a separate database query

### Example Baseline Performance
```
LED Strips (17 descendants): ~2,000ms
By-Categories (125 descendants): ~7,936ms (almost 8 seconds!)
```

## Optimizations

### 1. Batch Price Query (Fase 2)

**File:** `src/api/store/_shared/product-enrichment.ts`

**Before:**
```typescript
// N+1 problem - one query per product
for (const product of products) {
    for (const variant of product.variants) {
        const prices = await knex("price")
            .where("variant_id", variant.id)
            // ... fetch price for THIS variant only
    }
}
```

**After:**
```typescript
// Single batch query for ALL variants
const allVariantIds = products.flatMap(p => 
    p.variants.map(v => v.id)
)

const allPrices = await knex("price")
    .select("price.amount", "price.currency_code", "product_variant_price_set.variant_id")
    .join("product_variant_price_set", "price.price_set_id", "product_variant_price_set.price_set_id")
    .whereIn("product_variant_price_set.variant_id", allVariantIds)
    .where("price.currency_code", "usd")
    .whereNull("price.deleted_at")

// Create lookup map for O(1) access
const pricesByVariant = new Map()
allPrices.forEach(p => pricesByVariant.set(p.variant_id, p.amount))
```

**Result:** 42% improvement (3.2s → 1.8s)

---

### 2. Direct SQL COUNT Query (Fase 3)

**File:** `src/api/store/categories/[id]/products-with-filters/route.ts`

**Before:**
```typescript
// Fetching ALL products just to count them
const { data: allProducts } = await query.graph({
    entity: "product",
    filters: productFilters,
    fields: ["id"]
})
const totalCount = allProducts.length // Wasteful!
```

**After:**
```typescript
// Direct COUNT query
const knex = req.scope.resolve("__pg_connection__")

const countResult = await knex("product")
    .join("product_category_product", "product.id", "product_category_product.product_id")
    .whereIn("product_category_product.product_category_id", categoryIds)
    .where("product.status", "published")
    .whereNull("product.deleted_at")
    .countDistinct("product.id as count")
    .first()

const totalCount = parseInt(String(countResult?.count || "0"))
```

**Result:** Eliminated redundant product fetch

---

### 3. PostgreSQL Recursive CTE (Fase 4)

**File:** `src/api/store/categories/[id]/products-with-filters/route.ts`

**Before:**
```typescript
// Recursive loop - N queries for N category levels
async function getCategoryDescendants(categoryId, query) {
    const descendants = []
    const queue = [categoryId]

    while (queue.length > 0) {
        const currentId = queue.shift()
        
        // SEPARATE QUERY for each level!
        const { data: children } = await query.graph({
            entity: "product_category",
            filters: { parent_category_id: currentId },
            fields: ["id"]
        })
        
        descendants.push(...children.map(c => c.id))
        queue.push(...children.map(c => c.id))
    }
    
    return descendants // 125 queries for 125 descendants!
}
```

**After:**
```typescript
// Single recursive CTE query
async function getCategoryDescendants(categoryId, knex) {
    const result = await knex.raw(`
        WITH RECURSIVE descendants AS (
            -- Base case: direct children
            SELECT id
            FROM product_category
            WHERE parent_category_id = ?
              AND deleted_at IS NULL
            
            UNION
            
            -- Recursive case: children of children
            SELECT pc.id
            FROM product_category pc
            INNER JOIN descendants d ON pc.parent_category_id = d.id
            WHERE pc.deleted_at IS NULL
        )
        SELECT id FROM descendants;
    `, [categoryId])

    return result.rows.map(row => row.id)
    // Just 1 query for ANY number of descendants!
}
```

**Result:** 85-97% improvement on categories with many descendants

---

## Code Examples

### Complete Flow

```typescript
export const GET = async (req, res) => {
    const { id } = req.params
    const includeDescendants = category.metadata?.include_descendants_tree === true
    
    // Step 1: Get all category IDs (parent + descendants)
    let categoryIds = [id]
    if (includeDescendants) {
        const knex = req.scope.resolve("__pg_connection__")
        const descendants = await getCategoryDescendants(id, knex) // CTE magic!
        categoryIds = [id, ...descendants]
    }
    
    // Step 2: Get total count (optimized SQL COUNT)
    const countResult = await knex("product")
        .join("product_category_product", "product.id", "product_category_product.product_id")
        .whereIn("product_category_product.product_category_id", categoryIds)
        .countDistinct("product.id as count")
        .first()
    
    // Step 3: Fetch paginated products
    const { data: products } = await query.graph({
        entity: "product",
        filters: { id: { $in: categoryIds } },
        pagination: { skip, take }
    })
    
    // Step 4: Enrich with prices (batch query)
    const enrichedProducts = await enrichProducts(products, knex)
    
    return res.json({ products: enrichedProducts, pagination: { total: totalCount } })
}
```

## Testing

### Manual Testing

1. Start the dev server:
```bash
cd backend
yarn dev
```

2. Navigate to a category page:
```
http://localhost:4321/category/by-categories
```

3. Check backend logs for timing:
```bash
# Look for lines like:
[PRODUCTS-WITH-FILTERS] 👨‍👩‍👧‍👦 Including 125 descendant categories
http: GET /store/categories/.../products-with-filters ← - (200) - 377ms
```

### Expected Performance

| Category Type | Descendants | Expected Time (Cold) |
|--------------|-------------|---------------------|
| Small | 1-20 | < 1.5s |
| Medium | 20-50 | < 2.0s |
| Large | 50+ | < 3.0s |

With Redis cache (15min TTL): **< 500ms** for all categories

## Key Concepts

### What is N+1 Query Problem?

Instead of:
```typescript
// BAD: 1 query to get products + N queries for prices
const products = await getProducts() // 1 query
for (const product of products) {
    product.price = await getPrice(product.id) // N queries!
}
```

Do:
```typescript
// GOOD: 1 query for products + 1 query for ALL prices
const products = await getProducts() // 1 query
const allPrices = await getPrices(products.map(p => p.id)) // 1 query
products.forEach(p => p.price = allPrices[p.id])
```

### What is a Recursive CTE?

A **Common Table Expression (CTE)** that references itself to traverse hierarchical data:

```sql
WITH RECURSIVE tree AS (
    SELECT id FROM categories WHERE parent_id = 1  -- Start
    UNION
    SELECT c.id FROM categories c 
    JOIN tree t ON c.parent_id = t.id              -- Recurse
)
SELECT * FROM tree;
```

This is much faster than iterative querying in application code.

## Troubleshooting

### High Response Times

1. Check if Redis is running: `docker ps | grep redis`
2. Clear cache: Restart backend server
3. Check database indexes on `product_category.parent_category_id`

### CTE Not Working

Ensure you're using PostgreSQL (not MySQL). CTEs require Postgres 8.4+.

## Further Optimizations

Potential future improvements:

1. **Database Indexes**: Add index on `product_category.parent_category_id`
2. **Materialized Views**: Pre-compute category trees
3. **GraphQL DataLoader**: Batch Medusa query.graph calls if needed

## References

- [PostgreSQL Recursive Queries](https://www.postgresql.org/docs/current/queries-with.html)
- [Knex.js Documentation](https://knexjs.org/)
- [Medusa v2 Query API](https://docs.medusajs.com/)
