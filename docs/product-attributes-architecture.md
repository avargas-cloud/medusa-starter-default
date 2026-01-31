# Product Attributes Architecture (v3.0)

> [!WARNING]
> **CRITICAL:** This module uses **HARD DELETE ONLY** for attribute links. All SELECT queries MUST include `.whereNull("deleted_at")` to filter soft-deleted ghost records.

## Overview

Product attributes in Medusa v2 use a custom link table (`product_product_productattributes_attribute_value`) that supports many-to-many relationships between products and attribute values.

**Key Principle:** We use **raw SQL** for critical operations to bypass Medusa's caching and soft-delete issues.

---

## Architecture Components

### 1. Database Schema

**Link Table:** `product_product_productattributes_attribute_value`

```sql
CREATE TABLE product_product_productattributes_attribute_value (
  product_id VARCHAR NOT NULL,
  attribute_value_id VARCHAR NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP NULL,  -- ⚠️ ALWAYS filter this!
  UNIQUE (product_id, attribute_value_id)
);
```

**Critical Constraint:** `UNIQUE (product_id, attribute_value_id)` allows multiple attributes per product.

---

### 2. Hard Delete Policy

> [!IMPORTANT]
> **NO SOFT DELETES** - We use hard deletes to prevent ghost data:
> - Workflow updates: Raw SQL `.del()`
> - Category filters: Filter with `.whereNull("deleted_at")`
> - GET endpoints: Filter with `.whereNull("deleted_at")`

**Why?**
Medusa's `remoteLink.delete()` creates soft-deleted records that pollute queries and cause duplicate/stale data in the UI.

---

### 3. Core Files

| File | Purpose | Delete Strategy |
|------|---------|----------------|
| `src/workflows/product-attributes/update-product-attributes.ts` | Update product attributes | **HARD DELETE** via raw SQL |
| `src/api/admin/products/[id]/attributes/route.ts` | GET product attributes | Filter soft-deletes `.whereNull()` |
| `src/modules/category-filters/utils/filter-generator.ts` | Generate category filters | Filter soft-deletes `.whereNull()` |

---

## Critical Code Patterns

### ✅ Correct: Hard Delete in Workflow

```typescript
// ✅ HARD DELETE using RAW SQL
const knex = container.resolve("__pg_connection__")

promises.push(
    knex("product_product_productattributes_attribute_value")
        .where("product_id", productId)
        .whereIn("attribute_value_id", toDelete)  // Only specific IDs
        .del()  // ← HARD DELETE
)
```

### ✅ Correct: Filter Soft-Deletes in SELECT

```typescript
// ✅ GET endpoint - filter soft-deletes
const links = await knex("product_product_productattributes_attribute_value")
    .select("attribute_value_id")
    .where("product_id", id)
    .whereNull("deleted_at")  // ✅ CRITICAL
```

### ❌ Incorrect: Using remoteLink.delete()

```typescript
// ❌ NEVER USE - creates soft-deleted ghost records
await remoteLink.delete({
    [Modules.PRODUCT]: { product_id: productId },
    [PRODUCT_ATTRIBUTES_MODULE]: { attribute_value_id: valueIds }
})
```

---

## Workflow Logic

### Update Attributes Workflow

**File:** `src/workflows/product-attributes/update-product-attributes.ts`

**Steps:**

1. **Fetch existing links** (filtered for soft-deletes)
2. **Compare** old vs new attribute sets
3. **Delete changed attributes** via raw SQL hard delete
4. **Create new links** via `remoteLink.create()`
5. **Update product metadata** for variant switches

**Key Feature:** Only modifies attributes whose values actually changed - other attributes remain untouched.

```typescript
// Compare sets - only delete if values changed
const newSet = new Set(newValueIds)
const oldSet = new Set(oldValueIds)
const unchanged = newSet.size === oldSet.size && [...newSet].every(id => oldSet.has(id))

if (unchanged) {
    return  // Skip - no change
}

// Hard delete old values
await knex("product_product_productattributes_attribute_value")
    .where("product_id", productId)
    .whereIn("attribute_value_id", oldValueIds)
    .del()

// Create new values
await remoteLink.create([...])
```

---

## Troubleshooting

### Issue: Attributes show duplicate/ghost values

**Cause:** Soft-deleted links not filtered in queries

**Solution:**
1. Run cleanup script:
   ```bash
   npx medusa exec src/scripts/cleanup-all-soft-deletes.ts
   ```
2. Verify all SELECT queries include `.whereNull("deleted_at")`

---

### Issue: Category filters show wrong values

**Cause:** Filter generator reading soft-deleted links

**Solution:**
1. Clean up soft-deletes (see above)
2. Regenerate filters:
   ```bash
   # Single category (fast)
   npx medusa exec src/scripts/quick-fix-white-leds.ts
   
   # All categories (slow for large catalogs)
   npx medusa exec src/scripts/mass-sync-all-filters.ts
   ```

---

### Issue: Workflow deletes ALL product attributes

**Cause:** Using `remoteLink.delete()` with filters instead of raw SQL

**Fix:** See "Correct: Hard Delete in Workflow" pattern above

---

## Verification Scripts

| Script | Purpose |
|--------|---------|
| `src/scripts/debug-power-consumption.ts` | Check specific attribute values for a product |
| `src/scripts/count-links.ts` | Ground truth count of attribute links |
| `src/scripts/check-soft-deletes.ts` | Find soft-deleted ghost links |
| `src/scripts/cleanup-all-soft-deletes.ts` | **HARD DELETE** all soft-deleted links |
| `src/scripts/verify-category-filters.ts` | Verify filter metadata matches actual data |

---

## Migration Notes

### If Upgrading from v2.1

The key changes in v3.0:

1. **Workflow now uses HARD DELETE** - Changed from `remoteLink.delete()` to raw SQL `.del()`
2. **All SELECT queries filter soft-deletes** - Added `.whereNull("deleted_at")` everywhere
3. **Cleanup script available** - Can remove accumulated ghost data
4. **Filter generation fixed** - No longer shows stale/deleted attribute values

**Action Required:**
```bash
# 1. Clean existing ghost data
npx medusa exec src/scripts/cleanup-all-soft-deletes.ts

# 2. Regenerate category filters
npx medusa exec src/scripts/mass-sync-all-filters.ts
```

---

## References

| Doc | Topic |
|-----|-------|
| [CATEGORY_FILTERS.md](file:///home/alejo/medusa-starter-default/docs/CATEGORY_FILTERS.md) | Category filter generation |
| [QUERY_PATTERNS_REFERENCE.md](file:///home/alejo/medusa-starter-default/docs/QUERY_PATTERNS_REFERENCE.md) | Database query patterns |

---

**Last Updated:** 2026-01-30  
**Version:** 3.0 (Hard Delete + Soft-Delete Filtering)
