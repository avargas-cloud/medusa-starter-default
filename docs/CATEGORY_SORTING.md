---
**Purpose:** Document the custom Category Sorting System that lets admins manually define the display order of subcategories and products within each category via a drag-and-drop interface in the Admin UI.

**Solves:** Medusa v2 has no native support for custom subcategory/product ordering within categories. The system follows the same metadata-driven architecture as Category Filters, storing sort order in `category.metadata.sort_config`.

**Expected Result:** Category admins can drag-and-drop subcategories and products into a custom display order. The sort configuration is stored in metadata and served by the store API, with automatic sync when categories or products are modified.

---

# Category Sorting System

## Overview

The Category Sorting System allows administrators to manually define the display order of subcategories and products within each category using a drag-and-drop interface. This system follows the same architectural patterns as the Category Filters system, using metadata-driven configuration and automatic synchronization.

## Architecture

### Metadata Storage

Sorting configuration is stored in `category.metadata.sorting_config`:

```typescript
{
  subcategory_order: string[],  // Array of category IDs in display order
  product_order: string[]        // Array of product IDs in display order
}
```

### Components

#### Backend

1. **Store API Endpoint** (`/store/categories/:id/sorting`)
   - GET endpoint for frontend consumption
   - Returns sorted lists of subcategories and products
   - Supports inheritance from parent category
   - Response format:
     ```json
     {
       "category_id": "cat_123",
       "category_name": "Electronics",
       "category_handle": "electronics",
       "subcategories": [
         { "id": "cat_456", "name": "Phones", "handle": "phones", "order": 0 }
       ],
       "products": [
         { "id": "prod_789", "title": "iPhone 15", "handle": "iphone-15", "order": 0 }
       ],
       "inherited": false
     }
     ```

2. **Admin Sync Endpoint** (`/admin/product-categories/:id/sync-sorting`)
   - Internal POST endpoint for cleanup operations
   - Removes orphaned IDs from sorting_config
   - Preserves order of remaining items
   - Called automatically by middleware

3. **Auto-Sync Middleware**
   - HTTP response interception pattern (same as Filters)
   - Triggers on product/category mutations
   - Handles 5 scenarios automatically:
     - Product deleted
     - Product removed from category
     - Category deleted
     - Category moved (parent changed)
     - Product added to category

#### Frontend

1. **Data Hooks**
   - `useSortingData` - Fetches categories, subcategories, and products
   - `useCategorySorting` - Manages sorting state and save operations

2. **UI Components** (all <200 lines)
   - `CategorySelector` - Tree view for category navigation
   - `SortableItem` - Generic drag-and-drop item
   - `SubcategoriesList` - Sortable subcategories with dnd-kit
   - `ProductsList` - Sortable products with dnd-kit

3. **Main Page** (`/admin/sorting`)
   - 3-panel layout (Category Selector | Subcategories | Products)
   - Drag-and-drop reordering
   - Save buttons with optimistic updates

## Auto-Sync Middleware Logic

### Triggering Scenarios

#### Scenario 1: Product Removed from Category
```
User removes Product A from Category X
→ Middleware detects product-category link change
→ Calls /sync-sorting for Category X
→ Removes Product A ID from product_order array
→ Preserves order of remaining products
```

#### Scenario 2: Product Deleted
```
User deletes Product B
→ Middleware detects DELETE on /admin/products/:id
→ Finds all categories that had Product B in sorting_config
→ Calls /sync-sorting for each affected category
→ Removes Product B ID from all product_order arrays
```

#### Scenario 3: Category Moved
```
User moves Category Y from Parent A to Parent B
→ Middleware detects parent_category_id change
→ Calls /sync-sorting for OLD parent (Parent A)
→ Calls /sync-sorting for NEW parent (Parent B)
→ Removes Category Y from Parent A's subcategory_order
→ Does NOT auto-add to Parent B (user must manually sort)
```

#### Scenario 4: Category Deleted
```
User deletes Category Z
→ Middleware detects DELETE on /admin/product-categories/:id
→ Finds parent category
→ Calls /sync-sorting for parent
→ Removes Category Z from parent's subcategory_order
```

#### Scenario 5: Product Added to Category
```
User assigns Product C to Category X
→ Middleware detects product update
→ Calls /sync-sorting for Category X
→ Does NOT auto-add Product C to product_order
→ Only removes orphaned IDs, never adds
```

### Philosophy: "Remove Only, Never Add"

The sorting system is **opt-in**:
- ✅ Automatically removes IDs that no longer exist (cleanup)
- ❌ Does NOT auto-add new items to sorting arrays

**Rationale:**
- New items appear at their natural position (end of list by default)
- Users explicitly drag to create custom ordering
- Prevents unexpected ordering changes
- Maintains predictable behavior

## Usage

### Admin UI

1. Navigate to **Sorting** in the admin sidebar
2. Select a category from the left panel
3. Drag subcategories/products to reorder them
4. Click "Save Order" button
5. Changes are saved to category metadata

### Frontend Integration

```typescript
// Fetch sorting configuration
const response = await fetch(`/store/categories/${categoryId}/sorting`)
const { subcategories, products } = await response.json()

// Render in order
subcategories.forEach(subcat => {
  // Display subcategory in order
})

products.forEach(product => {
  // Display product in order
})
```

## File Structure

```
src/
├── api/
│   ├── store/categories/[id]/sorting/route.ts (150 lines)
│   ├── admin/product-categories/[id]/sync-sorting/route.ts (150 lines)
│   └── middlewares.ts (MODIFIED, +160 lines)
├── admin/
│   ├── hooks/
│   │   ├── useSortingData.ts (85 lines)
│   │   └── useCategorySorting.ts (85 lines)
│   ├── components/sorting/
│   │   ├── CategorySelector.tsx (95 lines)
│   │   ├── SortableItem.tsx (50 lines)
│   │   ├── SubcategoriesList.tsx (120 lines)
│   │   └── ProductsList.tsx (125 lines)
│   └── routes/sorting/page.tsx (145 lines)
```

**Total: ~1,160 lines of code**
**All files comply with <200 line modularization rule**

## Testing

### Manual Testing

1. **Basic Sorting**
   - Select category
   - Drag items to reorder
   - Save and verify order persists

2. **Auto-Sync Testing**
   - Delete a product → Verify it's removed from all sorting configs
   - Move a category → Verify it's removed from old parent's config
   - Add new products → Verify they appear at end of list

3. **Inheritance Testing**
   - Category without sorting_config should inherit from parent
   - Verify `inherited: true` flag in Store API response

### API Testing

```bash
# Fetch sorting config
curl http://localhost:9000/store/categories/cat_123/sorting

# Trigger manual sync (internal endpoint)
curl -X POST http://localhost:9000/admin/product-categories/cat_123/sync-sorting \
  -H "Cookie: connect.sid=..."
```

## Dependencies

- `@dnd-kit/core` - Drag-and-drop primitives
- `@dnd-kit/sortable` - Sortable list utilities
- `@medusajs/admin-sdk` - Admin route configuration
- `@medusajs/ui` - UI components
- `@tanstack/react-query` - Data fetching

## Comparison with Filters System

| Aspect | Filters | Sorting |
|--------|---------|---------|
| **Purpose** | Show/hide product attributes | Define display order |
| **Metadata** | `filter_config.active_filters` | `sorting_config.{subcategory_order, product_order}` |
| **Auto-Sync** | ✅ Same middleware pattern | ✅ Same middleware pattern |
| **Inheritance** | ✅ From parent categories | ✅ From parent categories |
| **UI Pattern** | Tree + checkbox list | Tree + drag-and-drop lists |
| **Data Fetched** | Attribute metadata only | Actual categories/products |

## Future Enhancements

- [ ] Optional category sorting widget on category detail page
- [ ] Bulk sorting operations
- [ ] Import/export sorting configurations
- [ ] Sorting templates for category hierarchies

## Related Documentation

- [CATEGORY_FILTERS.md](./CATEGORY_FILTERS.md) - Category Filters System
- [CATEGORY_FILTERS_SOFT_DELETE_SECTION.md](./CATEGORY_FILTERS_SOFT_DELETE_SECTION.md) - Soft-delete filtering pattern
