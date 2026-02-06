# MeiliSearch Inventory Sync - Batch Variant Price Update Fix (Feb 2026)

## Issue Summary
Price changes in Medusa Admin UI were not syncing automatically to MeiliSearch `inventory` index, causing inventory-advanced page to show stale prices.

## Root Causes

### 1. Middleware Batch Detection Missing (PRIMARY)
When changing prices in Medusa Admin, the system uses:
```
POST /admin/products/{product_id}/variants/batch
```

Response format:
```json
{
  "created": [],
  "updated": [{ "id": "variant_xxx", ...}],
  "deleted": []
}
```

**Bug:** Middleware condition didn't check for `data.updated`, so batch updates never triggered sync logic.

### 2. Incremental Workflow Field Mismatch
- **Full sync** used: `inventory.stocked_quantity` (direct field)
- **Incremental sync** used: `inventory.location_levels.stocked_quantity` (nested array, often empty)
- Result: Timestamp updated but data didn't sync

## Fixes Applied

### File: `src/api/middlewares.ts` (Line 472)
```typescript
// Added batch update detection
const hasBatchUpdate = data?.updated && Array.isArray(data.updated)

// Updated condition to include batch updates
if (hasProduct || hasVariant || hasInventoryItem || hasPrice || hasBatchUpdate || isInventoryPath) {
    // Sync logic now triggers for batch updates
}

// Inside setImmediate, extract variant IDs from batch
if (data.updated && Array.isArray(data.updated)) {
    variantIds = data.updated.map(v => v.id).filter(Boolean)
    // Sync each variant individually
}
```

### File: `src/workflows/update-inventory-incremental.ts` (Line 45-104)
```typescript
// Changed from location_levels to direct fields (matching full sync)
fields: [
    "inventory_items.inventory.stocked_quantity",      // ✅ Direct field
    "inventory_items.inventory.reserved_quantity",     // ✅ Direct field
    
    // Added parent category flattening (matching full sync)
    "product.categories.parent_category.handle",
    "product.categories.parent_category.parent_category.handle",
]

// Transform logic now matches full sync exactly
totalStock: inventory.stocked_quantity || 0,           // Direct access
totalReserved: inventory.reserved_quantity || 0,       // Direct access
category_handles: Array.from(allCategoryHandles),      // Flatten parents
```

## Verification
After fix, price changes show these logs:
```
[MEILI-INVENTORY-SYNC] 🔍 DEBUG: POST /admin/products/.../variants/batch
[MEILI-INVENTORY-SYNC] 📦 Batch update detected: 1 variants
[MEILI-INVENTORY-SYNC] 🔄 Syncing 1 variant(s)...
[MEILI-INVENTORY-SYNC] ✅ Updated 1 items for variant xxx
```

## Documentation Updated
- ✅ `backend/docs/MEILISEARCH_AUTO_SYNC_COMPLETE_GUIDE.md` - Troubleshooting section added
- ✅ This file created for future reference
- ✅ Date: February 6, 2026
