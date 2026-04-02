# Soft-Delete Filtering & Mass Sync

> [!WARNING]
> **CRITICAL FIX (2026-01-30):** Filter generation now excludes soft-deleted attribute links.


## 📋 Descripción del Documento

| Campo | Detalle |
|-------|---------|
| **Propósito** | Document the critical fix (2026-01-30) that added soft-delete filtering to all filter generation queries, and the mass sync operation that re-processed all categories with the corrected logic. |
| **Problemas que resuelve** | Soft-deleted attribute links (`deleted_at IS NOT NULL`) were being included in filter generation, causing deleted attribute values to appear as filter options in the storefront. The fix adds `whereNull('deleted_at')` to all Knex queries in the filter pipeline. |
| **Resultado esperado** | Filter options in the storefront only reflect active (non-deleted) attribute values. Mass sync was run to recompute `available_filters` for all categories using the corrected query. |
| **Scripts Creados** | `sync/mass-sync-all-filters.ts`, `cleanup/cleanup-all-soft-deletes.ts`, `verify/verify-category-filters.ts`, `quick-fix/quick-fix-white-leds.ts` |

## The Problem

Medusa's `remoteLink.delete()` creates **soft-deleted records** (sets `deleted_at` timestamp) instead of permanently removing them. Without filtering, these ghost links cause:

- ❌ Duplicate filter values (old + new)
- ❌ Stale values from deleted products
- ❌ Incorrect filter counts

## The Solution

All queries to `product_product_productattributes_attribute_value` **MUST include**:

```typescript
.whereNull("deleted_at")  // ✅ Exclude soft-deleted links
```

**Fixed in:**
- ✅ `filter-generator.ts` (line 296)
- ✅ `route.ts` GET endpoint (product attributes)
- ✅ `update-product-attributes.ts` workflow (uses hard deletes)

### Example: Filter Generator Fix

```typescript
// ✅ CORRECT - Filters soft-deletes
const links = await knex("product_product_productattributes_attribute_value")
    .select("product_id", "attribute_value_id")
    .whereIn("product_id", productIds)
    .whereIn("attribute_value_id", valueIds)
    .whereNull("deleted_at")  // ← CRITICAL

// ❌ WRONG - Includes ghost links
const links = await knex("product_product_productattributes_attribute_value")
    .select("product_id", "attribute_value_id")
    .whereIn("product_id", productIds)
    .whereIn("attribute_value_id", valueIds)
```

---

## Mass Filter Sync

### When to Use

Run mass sync when:
- After cleaning up soft-deleted links
- After bulk product import/update
- When filters show stale/incorrect values
- After upgrading to v2.0

### Scripts

**Option 1: Regenerate All Categories (Slow)**

```bash
npx medusa exec src/scripts/mass-sync-all-filters.ts
```

- Processes: All categories with `filter_config`
- Time: ~5-10 seconds per category with 50+ products
- Use: After major data changes

**Option 2: Regenerate Single Category (Fast)**

```bash
# Edit script to set your category handle
npx medusa exec src/scripts/quick-fix-white-leds.ts
```

- Processes: 1 specific category  
- Time: <2 seconds
- Use: Quick fix for one category

### Cleanup Before Sync

**Always clean soft-deleted links first:**

```bash
# 1. Remove ghost data
npx medusa exec src/scripts/cleanup-all-soft-deletes.ts

# 2. Then regenerate filters
npx medusa exec src/scripts/mass-sync-all-filters.ts
```

### Verification

After sync, verify filters are correct:

```bash
npx medusa exec src/scripts/verify-category-filters.ts
```

This will show you exactly what filter values are in the metadata vs actual product attributes.

---

**See also:** [Product Attributes Architecture](file:///home/alejo/medusa-starter-default/docs/product-attributes-architecture.md) for details on hard delete policy and attribute link management.
