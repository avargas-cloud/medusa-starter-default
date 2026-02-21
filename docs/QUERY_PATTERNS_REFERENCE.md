---
**Purpose:** Decision guide for choosing between `remoteQuery` (Medusa's data layer) and raw Knex when querying data — covering when each approach is appropriate, performance tradeoffs, and code examples for each pattern.

**Solves:** Developers were inconsistently mixing `remoteQuery` (high-level, type-safe, slower) and Knex (raw SQL, fast) without understanding the tradeoffs. This doc establishes team standards for which pattern to use in which scenario.

**Expected Result:** All new backend queries use the correct pattern. Performance-critical paths use Knex. Cross-module queries use `remoteQuery`. No more ad-hoc mixing that causes maintainability issues.

---

# Query Pattern Reference: remoteQuery vs Knex

**Project**: Medusa v2 E-Commerce Platform  
**Last Updated**: 2026-01-29  
**Purpose**: Definitive guide for querying system entities

---

## Quick Decision Tree

```
┌─────────────────────────────────────┐
│  Need to query data?                │
└──────────────┬──────────────────────┘
               │
               ▼
       ┌───────────────┐
       │ Is it a       │
       │ Medusa Module?│ ────Yes───► Use remoteQuery()
       └───────┬───────┘
               │
               No
               │
               ▼
       ┌───────────────┐
       │ Is it a       │
       │ Manual Table? │ ────Yes───► Use knex()
       └───────┬───────┘
               │
               No
               │
               ▼
       ┌───────────────┐
       │ Is it in      │
       │ metadata JSON?│ ────Yes───► Direct property access
       └───────────────┘
```

---

## System Entities Overview

| Entity | Query Method | Reason | Module/Table Name |
|--------|-------------|--------|-------------------|
| **Attributes** | | | |
| - AttributeKey | `remoteQuery()` | Medusa module | `attribute_key` |
| - AttributeValue | `remoteQuery()` | Medusa module | `attribute_value` |
| - AttributeSet | `remoteQuery()` | Medusa module | `attribute_set` |
| - Product-Attribute Links | `knex()` | Manual table | `product_product_productattributes_attribute_value` |
| **Products** | | | |
| - Product | `remoteQuery()` | Core Medusa module | `product` |
| - Product Metadata | Direct access | JSON field | `product.metadata.*` |
| **Categories** | | | |
| - ProductCategory | `remoteQuery()` | Core Medusa module | `product_category` |
| - Category Metadata | Direct access / `knex()` | JSON field | `product_category.metadata.*` |
| **Filters** | | | |
| - Filter Definitions | Direct access | Stored in metadata | `category.metadata.filters` |
| - Available Attributes | Direct access | Stored in metadata | `category.metadata.available_attributes` |

---

## Part 1: Medusa Modules (Use remoteQuery)

### 1.1 AttributeKey (Attribute Definitions)

**Query Method**: ✅ `remoteQuery()`  
**Why**: Registered Medusa module

**Example: Get all attribute keys**
```typescript
const remoteQuery = req.scope.resolve("remoteQuery")

const attributeKeys = await remoteQuery({
    entryPoint: "attribute_key",
    fields: ["id", "handle", "label", "filter_type", "icon", "unit"],
    variables: {
        filters: {
            // Optional filters
            id: ["attr_key_1", "attr_key_2"]
        }
    }
})
```

**Example: Get attribute keys by attribute set**
```typescript
const attributeKeys = await remoteQuery({
    entryPoint: "attribute_key",
    fields: ["id", "handle", "label", "attribute_set_id"],
    variables: {
        filters: {
            attribute_set_id: "attrset_lighting"
        }
    }
})
```

**Common Fields**:
- `id`, `handle`, `label`
- `display_name`, `description`, `icon`, `unit`
- `filter_type`, `filter_order`
- `attribute_set_id`
- `metadata`

---

### 1.2 AttributeValue (Attribute Options)

**Query Method**: ✅ `remoteQuery()`  
**Why**: Registered Medusa module

**Example: Get values for a specific attribute**
```typescript
const attributeValues = await remoteQuery({
    entryPoint: "attribute_value",
    fields: ["id", "value", "attribute_key_id"],
    variables: {
        filters: {
            attribute_key_id: "attr_key_power"
        }
    }
})
```

**Example: Get specific values by ID**
```typescript
const values = await remoteQuery({
    entryPoint: "attribute_value",
    fields: ["id", "value"],
    variables: {
        filters: {
            id: ["val_85w", "val_100w"]
        }
    }
})
```

**Common Fields**:
- `id`, `value`
- `attribute_key_id`
- `metadata`

---

### 1.3 AttributeSet (Attribute Groups)

**Query Method**: ✅ `remoteQuery()`  
**Why**: Registered Medusa module

**Example: Get all attribute sets**
```typescript
const attributeSets = await remoteQuery({
    entryPoint: "attribute_set",
    fields: ["id", "name", "handle"],
    variables: {
        filters: {}
    }
})
```

**Common Fields**:
- `id`, `name`, `handle`
- `metadata`

---

### 1.4 Product

**Query Method**: ✅ `remoteQuery()`  
**Why**: Core Medusa module

**Example: Get products in a category**
```typescript
const products = await remoteQuery({
    entryPoint: "product",
    fields: ["id", "title", "handle"],
    variables: {
        filters: {
            categories: {
                id: ["pcat_led_strips"]
            }
        }
    }
})
```

**Example: Get product with metadata**
```typescript
const products = await remoteQuery({
    entryPoint: "product",
    fields: ["id", "title", "metadata"],
    variables: {
        filters: {
            id: "prod_123"
        }
    }
})

// Access metadata
const variantAttributes = products[0]?.metadata?.variant_attributes || []
```

**Common Fields**:
- `id`, `title`, `handle`
- `description`
- `metadata` (JSON field - access directly)
- `categories` (relation)

---

### 1.5 ProductCategory

**Query Method**: ✅ `remoteQuery()` OR `knex()` (depending on need)  
**Why**: Core Medusa module, but metadata updates require Knex

**Example: Get categories (READ)**
```typescript
// Use remoteQuery for reading
const categories = await remoteQuery({
    entryPoint: "product_category",
    fields: ["id", "name", "handle", "metadata", "parent_category_id"],
    variables: {
        filters: {
            id: "pcat_electronics"
        }
    }
})

// Access metadata
const filterConfig = categories[0]?.metadata?.filter_config
const availableAttrs = categories[0]?.metadata?.available_attributes || []
```

**Example: Update category metadata (WRITE)**
```typescript
// ❌ DON'T use remoteQuery for metadata updates
// ✅ Use Knex for direct metadata updates
const knex = req.scope.resolve("__pg_connection__")

await knex("product_category")
    .where({ id: categoryId })
    .update({
        metadata: JSON.stringify({
            ...existingMetadata,
            filter_config: newFilterConfig
        }),
        updated_at: new Date()
    })
```

**Common Fields**:
- `id`, `name`, `handle`
- `parent_category_id`
- `metadata` (JSON field)

---

## Part 2: Manual Tables (Use Knex)

### 2.1 Product-Attribute Links ⚠️ NUCLEAR OPTION

**Query Method**: ✅ `knex()` ONLY  
**Why**: Manual table due to Medusa v2 Link Service bug  
**Table**: `product_product_productattributes_attribute_value`

**❌ DOES NOT WORK**:
```typescript
// This will FAIL - table not registered as service
const links = await remoteQuery({
    entryPoint: "product_product_productattributes_attribute_value"
})
// Error: Service not found
```

**✅ CORRECT APPROACH**:
```typescript
const knex = req.scope.resolve("__pg_connection__")

// Get all attribute links for products
const links = await knex("product_product_productattributes_attribute_value")
    .select("product_id", "attribute_value_id")
    .whereIn("product_id", ["prod_1", "prod_2"])

// Count attributes per value
const counts = await knex("product_product_productattributes_attribute_value")
    .select("attribute_value_id")
    .count("* as count")
    .whereIn("product_id", productIds)
    .whereIn("attribute_value_id", valueIds)
    .groupBy("attribute_value_id")

// Get attributes for a single product
const productAttrs = await knex("product_product_productattributes_attribute_value")
    .select("attribute_value_id")
    .where({ product_id: "prod_123" })
```

**Table Schema**:
```sql
CREATE TABLE "product_product_productattributes_attribute_value" (
    "id" text PRIMARY KEY,
    "product_id" text NOT NULL,
    "attribute_value_id" text NOT NULL,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    "updated_at" timestamptz DEFAULT now() NOT NULL,
    "deleted_at" timestamptz,
    CONSTRAINT "unique_pair" UNIQUE ("product_id", "attribute_value_id")
);
```

**Why Manual?**:
- Medusa v2 Link Service forces `UNIQUE(product_id)` → Only 1 attribute per product ❌
- We need `UNIQUE(product_id, attribute_value_id)` → Many attributes per product ✅
- Created via `src/scripts/force-create-link-table.js`

---

## Quick Reference Table

| Entity | Read | Write | Reason |
|--------|------|-------|--------|
| AttributeKey | `remoteQuery()` | `remoteQuery()` | Medusa module |
| AttributeValue | `remoteQuery()` | `remoteQuery()` | Medusa module |
| AttributeSet | `remoteQuery()` | `remoteQuery()` | Medusa module |
| Product-Attribute Links | `knex()` | `knex()` | Manual table |
| Product | `remoteQuery()` | `remoteQuery()` | Core module |
| Product.metadata | Access after query | `knex()` update | JSON field |
| ProductCategory | `remoteQuery()` | `remoteQuery()` | Core module |
| Category.metadata | Access after query | `knex()` update | JSON field |

---

**Last Updated**: 2026-01-29  
**Maintained By**: Development Team  
**Questions?** Check `docs/product-attributes-architecture.md` for "Nuclear Option" context
