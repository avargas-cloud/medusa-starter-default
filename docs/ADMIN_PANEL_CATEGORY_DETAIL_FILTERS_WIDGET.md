# Category Filters Widget - Admin UI Component

> **Last Updated**: 2026-01-31  
> **Status**: ✅ Production Ready (Bug Fixes Applied)


## 📋 Descripción del Documento

| Campo | Detalle |
|-------|---------|
| **Propósito** | Document the widget injected into the Category Detail Page (`product_category.details.after`) that provides inline editing of filter configuration (active/available filters, inheritance toggle) without navigating to the dedicated Filters page at `/app/filters`. |
| **Problemas que resuelve** | (1) The modal was showing all 121 system attributes instead of the curated list from nuclear sync. (2) Inconsistent naming between "Inactive Filters" and "Available Filters" across pages. (3) The need for quick filter management directly from the category detail view. |
| **Resultado esperado** | Category managers can configure filters from the category detail page. The widget shows only curated attributes (from `filter_config.available_filters`), not all system attributes. |
| **Scripts Creados** | `sync/smart-sync-filters.ts`, `force/force-resync-filters.ts`, `force/force-filter-regeneration.ts`, `verify/verify-category-filters.ts`, `trigger/trigger-filter-resync.ts`, `show/show-category-filters.ts` |
| **Última verificación** | 2026-01-31 |

## Overview

A widget that displays and edits category filter configuration directly on the Category detail page in Medusa Admin. This provides quick visibility into which filters are active and available without navigating to the dedicated Filters page.

## Recent Bug Fixes (2026-01-31)

Three critical bugs were fixed:

1. **✅ Modal shows curated filters** - Previously showed all 121 system attributes, now shows only the curated list from nuclear sync (e.g., 33 for LED Strips)
2. **✅ Improved spacing** - Added left padding (`pl-1`) to Active/Available Filters badge containers and helper text
3. **✅ Consistent naming** - Changed "Inactive Filters" to "Available Filters" to match main Filters page terminology

## Location

**File**: `src/admin/widgets/category-filters-widget.tsx`  
**Zone**: `product_category.details.after`

The widget appears below the main category details section.

## Features

###View Mode (Default)

- ✅ **Active Filters Display** - Shows configured filters as blue badges with count
- ✅ **Available Filters** - Shows curated filters from nuclear sync (not all system attributes)
- ✅ **Inheritance Status** - Orange badge when \"Override Inheritance\" is enabled
- ✅ **Edit Button** - Quick access to editing mode
- ✅ **Empty State** - Helpful message when no filters configured

### Edit Mode

- ✅ **Checkbox Selection** - Toggle filters on/off from curated list
- ✅ **Override Inheritance Toggle** - Control parent filter inheritance
- ✅ **Attribute Metadata** - Shows filter handle and type
- ✅ **Live Counter** - Shows number of selected/available filters
- ✅ **Save/Cancel** - Standard CRUD operations with toast notifications
- ✅ **Auto-refresh** - Reloads page after successful save

## Data Source

The widget reads from `category.metadata.filter_config`:

```typescript
{
  available_filters: [  // ⭐ Curated by nuclear sync
    { attribute_id: \"01...\", order: 0, type: \"checkbox\" },
    { attribute_id: \"01...\", order: 1, type: \"checkbox\" }
  ],
  active_filters: [     // User-activated subset
    { attribute_id: \"01...\", order: 0, type: \"checkbox\" }
  ],
  override_inheritance: boolean
}
```

**Critical Implementation Detail:**

The widget passes `availableAttrs` (filtered from `available_filters`) to the modal, **not** `attributes` (all 121 system attributes). This ensures the edit modal only shows relevant filters.

```tsx
// ✅ CORRECT - Pass curated list
<ManageFiltersModal
    availableAttributes={availableAttrs}  // 33 curated filters
    ...
/>

// ❌ WRONG - Would show all system attrs
<ManageFiltersModal
    availableAttributes={attributes}  // 121 system attributes
    ...
/>
```

## Usage

### For Users

1. Navigate to any category detail page (`/app/categories/[id]`)
2. Scroll to \"Category Filters\" widget
3. Click \"Edit\" to modify filters
4. Select/deselect attributes using checkboxes from curated list
5. Toggle \"Override Inheritance\" if needed
6. Click \"Save Changes\"

### For Developers

The widget automatically:
- Fetches all attribute definitions from `/admin/attributes`
- Filters to curated list from `filter_config.available_filters`
- Handles both old (string[]) and new (object[]) filter config formats
- Saves changes to category metadata via standard Medusa API
- Provides loading states and error handling

## Integration with Main Filters Page

This widget complements the dedicated Filters page:

- **Main Filters Page** (`/app/filters`) - Full editing with drag-and-drop ordering, advanced features
- **Category Widget** - Quick inline editing from category detail page

Both update the same `category.metadata.filter_config` structure and respect the same `available_filters` curation.

## Technical Details

### API Calls

```typescript
// Fetch all attribute definitions
GET /admin/attributes

// Update category metadata
POST /admin/product-categories/{id}
Body: { metadata: { filter_config: {...} } }
```

### Format Compatibility

Supports both legacy and current formats:

```typescript
// Old format (still supported)
active_filters: [\"attr_id_1\", \"attr_id_2\"]

// New format (recommended)
active_filters: [
  { attribute_id: \"attr_id_1\", order: 0, type: \"checkbox\" },
  { attribute_id: \"attr_id_2\", order: 1, type: \"checkbox\" }
]
```

The widget normalizes both formats internally.

## Related Documentation

- [CATEGORY_FILTERS.md](./CATEGORY_FILTERS.md) - Complete filter system
- [CATEGORY_FILTERS_NUCLEAR_SYNC.md](./CATEGORY_FILTERS_NUCLEAR_SYNC.md) - Nuclear sync algorithm
- [PRODUCT_ATTRIBUTES_ARCHITECTURE.md](./PRODUCT_ATTRIBUTES_ARCHITECTURE.md) - Attribute architecture

---

**Note**: For advanced features like drag-and-drop reordering of active filters, use the dedicated Filters page at `/app/filters`.
