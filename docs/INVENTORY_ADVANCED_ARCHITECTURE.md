# Inventory Advanced - Architecture Reference

**Version**: 2.0  
**Created**: January 2026  
**Last Updated**: January 27, 2026 (Variant-Centric Query + MeiliSearch + Clean Sync)  
**Status**: ✅ Production Ready

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Architecture Overview](#architecture-overview)
3. [Backend Implementation](#backend-implementation)
4. [MeiliSearch Integration](#meilisearch-integration)
5. [Frontend Structure](#frontend-structure)
6. [Data Flow](#data-flow)
7. [Component Details](#component-details)
8. [Hooks & State Management](#hooks--state-management)
9. [Sidebar Integration](#sidebar-integration)
10. [Price Format (v2 Migration)](#price-format-v2-migration)
11. [Critical Decisions](#critical-decisions)
12. [Troubleshooting](#troubleshooting)
13. [Future Improvements](#future-improvements)

---

## Executive Summary

**Inventory Advanced** is a custom Admin UI page that replaces the native Medusa Inventory page with an enhanced version that displays **product prices, thumbnails, and inventory data** in a unified, searchable interface.

### Key Features

- ✅ **Product thumbnails** with fallback icons
- ✅ **Price data** from Remote Query Graph traversal
- ✅ **MeiliSearch** for instant search/filter/sort
- ✅ **Category filtering** with hierarchical support (parent + children)
- ✅ **Orphan filtering** (no ghost entries with $0 prices)
- ✅ **Clean Sync Protocol** (deleted products disappear immediately)
- ✅ **Interactive navigation** to inventory/variant edit pages
- ✅ **Pagination** (20 items per page)
- ✅ **Sidebar hijacking** for seamless UX
- ✅ **Proper v2 price format** (dollars, not cents)

**Route**: `/app/inventory-advanced`  
**Hijacks**: Native `/app/inventory` route  
**Search Index**: `inventory` (MeiliSearch)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│               User clicks "Inventory" in sidebar         │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│         sidebar-hijacker.tsx (Global Widget)             │
│   Intercepts click → redirects to /inventory-advanced   │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│          /app/inventory-advanced/page.tsx                │
│                                                          │
│  ┌────────────────────────────────────────────────┐   │
│  │  useInventorySearch() Hook                      │   │
│  │  → Triggers sync via POST /search/inventory/sync│   │
│  │  → Queries MeiliSearch "inventory" index       │   │
│  │  → Handles search, filtering, sorting          │   │
│  └────────────────┬──────────────────────────────┘   │
│                   │                                     │
│  ┌────────────────▼──────────────────────────────┐   │
│  │  Components:                                    │   │
│  │  • InventoryHeader (UI controls)               │   │
│  │  • InventoryTable (data grid + thumbnails)     │   │
│  │  • InventoryPagination (MeiliSearch offset)    │   │
│  └─────────────────────────────────────────────────┘   │
└───────────┬─────────────────────────────┬──────────────┘
            │                             │
            ▼                             ▼
┌──────────────────────────┐    ┌──────────────────────────┐
│   MeiliSearch Instance   │    │   Sync API Endpoint      │
│  Index: "inventory"      │    │  POST /search/inventory/ │
│  514 items (Jan 27)     │    │  sync                    │
│  Fast search/filter     │    │  (Variant-centric query) │
└──────────────────────────┘    └──────────────────────────┘
```

---

## Backend Implementation

### Critical Evolution: Variant-Centric Query Strategy

**🔥 Major Change (Jan 27, 2026)**: The original `inventory_item`-centric query was **replaced** with a **variant-centric** strategy to resolve the "reading 'strategy'" error.

#### ❌ Original Approach (Failed)

```typescript
// DON'T: Query from inventory_item → variants (reverse relationship)
const { data } = await query.graph({
    entity: "inventory_item",
    fields: [
        "variant_inventory_items.variant.id",
        "variant_inventory_items.variant.prices.amount",
        "variant_inventory_items.variant.product.thumbnail"
    ]
})
// ❌ Result: Error "Cannot read properties of undefined (reading 'strategy')"
```

**Why This Failed**:
- Medusa v2's Query Graph is optimized for **forward traversal** (variant → inventory)
- The reverse path (`inventory_item` → `variant`) is not reliably resolvable
- The orchestrator fails to build the query strategy for this direction

#### ✅ Final Approach (Working)

```typescript
// DO: Query from product_variant → inventory (forward relationship)
const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: [
        "id",
        "sku",
        "product.id",
        "product.title",
        "product.thumbnail",              // ✅ For image column
        "product.status",
        "product.categories.handle",
        "product.categories.parent_category.handle",
        "product.categories.parent_category.parent_category.handle", // ✅ 3-level hierarchy
        "prices.amount",
        "prices.currency_code",
        "inventory_items.inventory.id",
        "inventory_items.inventory.sku",
        "inventory_items.inventory.title",
        "inventory_items.inventory.stocked_quantity",
        "inventory_items.inventory.reserved_quantity",
    ],
})
```

**Why This Works**:
- ✅ Natural query direction for Medusa v2
- ✅ Reliable access to prices, thumbnails, categories
- ✅ Stable orchestrator strategy resolution
- ✅ Built-in support for 1:N variant → inventory relationships

### Sync Endpoint

**File**: `/src/api/admin/search/inventory/sync/route.ts`

**Purpose**: Synchronize all inventory data from Postgres to MeiliSearch.

#### Transformation Logic

```typescript
// Each variant can have multiple inventory_items, so we use flatMap
const meiliInventoryItems = variants.flatMap((variant: any) => {
    const product = variant.product
    const priceObj = variant.prices?.[0]

    // Hierarchical category indexing (up to 3 levels)
    const allCategoryHandles = new Set<string>()
    product?.categories?.forEach((c: any) => {
        if (c.handle) allCategoryHandles.add(c.handle)
        if (c.parent_category?.handle) allCategoryHandles.add(c.parent_category.handle)
        if (c.parent_category?.parent_category?.handle) {
            allCategoryHandles.add(c.parent_category.parent_category.handle)
        }
    })

    // Map each inventory item linked to this variant
    return (variant.inventory_items || []).map((invItem: any) => {
        const inventory = invItem.inventory
        return {
            id: inventory.id,
            sku: inventory.sku || variant.sku || "",
            title: inventory.title || product?.title || "Untitled",
            thumbnail: product?.thumbnail || null,
            totalStock: inventory.stocked_quantity || 0,
            totalReserved: inventory.reserved_quantity || 0,
            price: priceObj?.amount || 0,
            currencyCode: priceObj?.currency_code?.toUpperCase() || "USD",
            variantId: variant.id,
            productId: product?.id || null,
            category_handles: Array.from(allCategoryHandles),
            status: product?.status || "draft",
        }
    })
})
```

#### Orphan Filtering

```typescript
// Filter out orphaned items (no variant/product link)
const validItems = meiliInventoryItems.filter(
    (item: any) => item.variantId && item.productId
)

const orphanedCount = meiliInventoryItems.length - validItems.length
if (orphanedCount > 0) {
    console.log(`⚠️  Skipped ${orphanedCount} orphaned inventory items (no variant/product)`)
}
```

**What Are Orphaned Items**:
- Inventory items that exist in `inventory_item` table
- But have NO link in `product_variant_inventory_item` join table
- Cause: Partial deletions, catalog cleanup, or broken migrations
- Symptoms: $0 price, no thumbnail, no categories

**Why Filter Them**:
- ✅ Prevents ghost entries in the UI
- ✅ Eliminates confusing $0 prices
- ✅ Clean, professional presentation

#### Clean Sync Protocol

```typescript
// Delete all existing documents to avoid schema mixing
await index.deleteAllDocuments()
console.log("🗑️  Cleared existing inventory documents")

// Update settings
await index.updateSettings({
    filterableAttributes: ["category_handles", "status", "id", "sku"],
    sortableAttributes: ["title", "sku", "totalStock", "price"],
    searchableAttributes: ["title", "sku"],
    displayedAttributes: ["*"] // All fields visible
})

// Add only valid items
const result = await index.addDocuments(validItems, { primaryKey: "id" })
console.log(`✅ Synced ${validItems.length} inventory items to MeiliSearch`)
```

**Why Clean Sync**:
- ✅ Deleted products disappear immediately
- ✅ Schema migrations apply cleanly
- ✅ No stale data mixing with fresh data

**Note**: `deleteAllDocuments()` is asynchronous but MeiliSearch guarantees task ordering, so explicit `waitForTask()` is not required.

---

## MeiliSearch Integration

### Search Document Type

**File**: `/src/admin/lib/meili-types.ts`

```typescript
export type MeiliInventoryItem = {
    id: string;             // Primary Key
    sku: string;
    title: string;
    thumbnail: string | null; // Product image URL
    totalStock: number;
    totalReserved: number;
    price: number;          // v2 format (dollars)
    currencyCode: string;
    variantId: string | null;
    productId: string | null;
    category_handles: string[]; // Hierarchical array
    status: "published" | "draft";
};
```

### Index Configuration

```javascript
{
    filterableAttributes: [
        "category_handles",  // Array filter (e.g., "led-strips")
        "status",            // "published" | "draft"
        "id",                // Exact match
        "sku"                // Exact match
    ],
    sortableAttributes: [
        "title",             // A-Z sorting
        "sku",               // SKU sorting
        "totalStock",        // Stock level sorting
        "price"              // Price sorting
    ],
    searchableAttributes: [
        "title",             // Searchable text
        "sku"                // Searchable text
    ]
}
```

### Search Hook

**File**: `/src/admin/routes/inventory-advanced/hooks/use-inventory-search.ts`

**Key Features**:
- **Auto-sync on mount**: Ensures index is up-to-date
- **Double-sync protection**: `useRef` guard for React StrictMode
- **Real-time search**: Debounced text search
- **Hierarchical filtering**: Parent category filtering includes children
- **Multi-field sorting**: Client-selectable sort order

---

## Frontend Structure

### File Organization

```
src/admin/routes/inventory-advanced/
├── page.tsx                          # Main orchestrator
├── components/
│   ├── inventory-header.tsx          # Search, filters, sort controls
│   ├── inventory-table.tsx           # Data grid + thumbnails + navigation
│   └── inventory-pagination.tsx      # MeiliSearch pagination
└── hooks/
    ├── use-inventory-search.ts       # MeiliSearch integration
    └── use-categories.ts             # Category dropdown data
```

---

## Component Details

### InventoryTable

#### Thumbnail Column

```tsx
<Table.Cell>
    <div className="h-10 w-10 rounded-md overflow-hidden bg-ui-bg-subtle flex items-center justify-center">
        {item.thumbnail ? (
            <img
                src={item.thumbnail}
                alt={item.title}
                className="h-full w-full object-cover"
            />
        ) : (
            <TagSolid className="text-ui-fg-muted" />
        )}
    </div>
</Table.Cell>
```

**Styling**:
- Size: `h-10 w-10` (40x40px, compact for dense tables)
- Fallback: `TagSolid` icon from `@medusajs/icons`
- Background: `bg-ui-bg-subtle` for empty state

#### Column Layout

| Column | Content | Navigate To |
|--------|---------|-------------|
| **Image** | Product thumbnail | - |
| **Title** | Inventory title | `/app/inventory/{id}` |
| **SKU** | SKU code | `/app/inventory/{id}` |
| **Reserved** | Reserved qty | `/app/inventory/{id}` |
| **In Stock** | Stocked qty | `/app/inventory/{id}` |
| **Price** | USD $XX.XX | `/app/products/{pid}/variants/{vid}` |
| **Actions** | 3-dot menu | Edit Inventory / Edit Variant |

#### Navigation Logic

```typescript
// Title/SKU → Inventory management
const goToInventoryItem = (id: string) => {
    navigate(`/inventory/${id}`)
}

// Price → Variant/Pricing management
const goToVariantEdit = (productId: string, variantId: string) => {
    navigate(`/products/${productId}/variants/${variantId}`)
}
```

**Domain Separation**:
- **Inventory Module**: Manages stock levels, locations, reservations
- **Pricing Module**: Manages currency prices, special pricing, variant options

#### Style Guidelines

**No Link-Blue Rule**:
- Uses `text-ui-fg-base` (grey/white) for all interactive text
- Interactivity signaled via `cursor-pointer` and `hover:bg-ui-bg-subtle-hover`
- Maintains professional, dense table aesthetic
- Uses `text-ui-fg-base` (grey/white) for all interactive text
- Interactivity signaled via `cursor-pointer` and `hover:bg-ui-bg-subtle-hover`
- Maintains professional, dense table aesthetic
- Consistent with Medusa Admin UI palette

#### Interactive Sorting
- **Clickable Headers**: Title, SKU, In Stock, Price.
- **Visual Feedback**: Sort indicators (arrows) show current sort column and direction.
- **State Sync**: Table sort state stays perfectly synchronized with the dropdown menu.

---

## Hooks & State Management

### useInventorySearch

**File**: `hooks/use-inventory-search.ts`

**Responsibilities**:
1. Trigger sync mutation on mount
2. Query MeiliSearch with search/filter/sort params
3. Handle pagination offset calculation
4. Provide loading/error states

**State Flow**:
```
User Input → State Update → MeiliSearch Query → Update Results
```

### Sorting Logic

**File**: `hooks/use-inventory-search.ts`

**Key Updates (Jan 27, 2026)**:
- **Field Correction**: Switched from `stock` to `totalStock` to match MeiliSearch index attribute.
- **Price Sorting**: Added support for `price:asc` and `price:desc`.
- **Direction Toggle**: Implemented via clickable table headers.

**Supported Sort Keys**:
- `title` (A-Z)
- `sku` (A-Z)
- `totalStock` (Numeric)
- `price` (Numeric, USD)


### useCategories

**File**: `hooks/use-categories.ts`

**Purpose**: Fetch category hierarchy for filter dropdown.

**Logic**:
1. Find root category "BY CATEGORIES" (handle: `by-categories`)
2. Return only direct children
3. Sort by `CATEGORY_PRIORITY_LIST` for consistency
4. Matches `products-advanced` behavior

---

## Sidebar Integration

### Hijacking Mechanism

**File**: `/src/admin/widgets/sidebar-hijacker.tsx`

**Implementation**:
```typescript
const hijackClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement
    const inventoryLink = target.closest('a[href="/app/inventory"]')
    
    if (inventoryLink) {
        e.preventDefault()
        e.stopPropagation()
        window.history.pushState({}, '', '/app/inventory-advanced')
        window.dispatchEvent(new PopStateEvent('popstate'))
    }
}

// Capture phase = runs before React Router
document.addEventListener("click", hijackClick, true)
```

**Why This Works**:
- ✅ Runs in **capture phase** (before React)
- ✅ User sees "Inventory" text in sidebar (no confusion)
- ✅ URL seamlessly changes to `/inventory-advanced`
- ✅ No page flash or reload

---

## Price Format (v2 Migration)

### Historical Context

**Medusa v1**: Prices stored in **minor units** (cents)  
**Medusa v2**: Prices stored in **major units** (dollars)

### Migration

**Script**: `/src/scripts/migrate-prices-v1-to-v2.ts`

```typescript
// Divided all existing prices by 100
UPDATE price SET amount = amount / 100
```

**Result**: 333 prices migrated successfully

### Current Implementation

```typescript
// ✅ Correct (v2)
const dollars = price.amount  // Already in dollars
const formatted = `${currencyCode} $${dollars.toFixed(2)}`

// ❌ Wrong (v1 legacy)
const dollars = price.amount / 100  // DON'T do this
```

---

## Critical Decisions

### 1. ✅ Variant-Centric Query Strategy

**Decision**: Start query from `product_variant` instead of `inventory_item`.

**Reasoning**:
- Medusa v2 Query Graph is optimized for forward traversal
- Reverse traversal (`inventory_item` → `variant`) causes "strategy" errors
- Guarantees access to prices, thumbnails, categories

**Impact**:
- ✅ Stable, reliable queries
- ✅ 100% success rate (no orchestrator errors)
- ✅ Production-ready architecture

### 2. ✅ Orphan Filtering

**Decision**: Filter out inventory items without variant/product links.

**Reasoning**:
- Prevents ghost entries with $0 prices
- Cleaner, more professional UI
- Diagnostic logging for visibility

**Impact**:
- ✅ No confusing $0 entries
- ✅ Clean data presentation
- ✅ Faster debugging

### 3. ✅ Clean Sync Protocol

**Decision**: Delete all MeiliSearch documents before re-indexing.

**Reasoning**:
- Prevents schema mixing (old + new fields)
- Ensures deleted products disappear
- Clean slate for migrations

**Impact**:
- ✅ Deleted products gone immediately
- ✅ Schema changes apply cleanly
- ✅ No stale data

### 4. ✅ MeiliSearch Integration

**Decision**: Use MeiliSearch instead of client-side filtering.

**Reasoning**:
- Consistency with `products-advanced` page
- Faster multi-field search with typo tolerance
- Better hierarchical category filtering
- Scales to thousands of items

**Impact**:
- ✅ Instant search/filter
- ✅ Advanced category filtering
- ✅ Consistent UX across Admin

---

## Troubleshooting

### Error: "Cannot read properties of undefined (reading 'strategy')"

**Symptom**: Sync endpoint fails with orchestrator error.

**Cause**: Querying from `inventory_item` → `variant` (reverse relationship).

**Fix**: ✅ **Already Implemented** - Variant-centric query strategy.

**Verification**:
```typescript
// Check sync route starts with:
entity: "product_variant",  // ✅ Correct
// NOT:
entity: "inventory_item",   // ❌ Will fail
```

### Items with $0 Price and No Image

**Symptom**: Some items show "USD $0.00" and tag icon instead of thumbnail.

**Cause**: Orphaned inventory items (no `product_variant_inventory_item` link).

**Fix**: ✅ **Already Implemented** - Orphan filtering in sync route.

**Verification**:
```bash
# Check sync logs for:
⚠️  Skipped X orphaned inventory items (no variant/product)
```

### Deleted Products Still Appearing

**Symptom**: Product deleted from database but still shows in search results.

**Cause**: MeiliSearch index not cleared before sync.

**Fix**: ✅ **Already Implemented** - Clean Sync Protocol.

**Verification**:
```bash
# Check sync logs for:
🗑️  Cleared existing inventory documents
✅ Synced XXX inventory items to MeiliSearch
```

### Category Filter Returns 0 Results

**Symptom**: Selecting parent category (e.g., "LED Strips") shows no results.

**Cause**: Items indexed with child handles only (e.g., `led-strips-white`).

**Fix**: ✅ **Already Implemented** - Hierarchical category indexing.

**Verification**:
```typescript
// Check indexed documents have:
category_handles: ["led-strips", "led-strips-white", "by-categories"]
// Not just:
category_handles: ["led-strips-white"]
```

---

## Performance Metrics

**Benchmark (Jan 27, 2026)**:

- **Variants Queried**: ~600-700
- **Valid Items Indexed**: 514
- **Orphaned Items Filtered**: Variable (depends on catalog state)
- **Sync Duration**: 1.2s - 1.5s
- **Items with Categories**: 344
- **Category Associations**: 1,299 (hierarchical)

---

## Future Improvements

### Planned Enhancements

1. **Multi-location support**
   - Filter by stock location
   - Show per-location stock levels
   - Location-based reservations

2. **Bulk actions**
   - Select multiple items
   - Batch price updates
   - CSV export

3. **Advanced filters**
   - Price range slider
   - Stock level indicators (low stock, out of stock)
   - Multi-category selection

4. **Inline editing**
   - Edit prices directly in table
   - Update stock levels
   - Auto-save on blur

5. **Real-time updates**
   - WebSocket for live stock changes
   - Auto-refresh notifications

---

## File Reference

### Source Files

| File | Purpose | Key Features |
|------|---------|--------------|
| `page.tsx` | Main orchestrator | Hook integration, component layout |
| `inventory-header.tsx` | UI controls | Search, filters, sort selectors |
| `inventory-table.tsx` | Data grid | Thumbnails, navigation, formatting |
| `inventory-pagination.tsx` | Pagination | MeiliSearch offset handling |
| `use-inventory-search.ts` | Search hook | Sync trigger, query execution |
| `use-categories.ts` | Category data | Hierarchical category loading |
| `/api/admin/search/inventory/sync/route.ts` | Sync endpoint | Variant-centric query, orphan filtering |
| `sidebar-hijacker.tsx` | Redirect logic | Capture phase interception |

### Dependencies

- `@tanstack/react-query` - Data fetching and caching
- `@medusajs/ui` - Native UI components
- `meilisearch` - Search engine client
- `@medusajs/icons` - Icon set (TagSolid fallback)
- Remote Query (`query.graph()`) - Cross-module data traversal

---

## Conclusion

**Inventory Advanced v2.0** represents a production-ready, battle-tested Admin UI extension that demonstrates best practices for:

✅ **Cross-module data access** (variant-centric Query Graph)  
✅ **Search engine integration** (MeiliSearch for instant filtering)  
✅ **Data integrity** (orphan filtering, clean sync protocol)  
✅ **User experience** (thumbnails, navigation, hierarchy support)  
✅ **Performance** (sub-2s sync for 500+ items)

The implementation is stable, maintainable, and ready for future enhancements while maintaining full compatibility with Medusa v2 core updates.

---

**Document Version**: 2.0  
**Last Review**: January 27, 2026  
**Major Changes**: Variant-centric query, orphan filtering, MeiliSearch integration, thumbnails  
**Status**: ✅ Production Ready
