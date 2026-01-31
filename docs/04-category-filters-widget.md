# Category Filters Widget - Admin UI Component

> **Last Updated**: 2026-01-30  
> **Status**: ✅ Production Ready

## Overview

A read-only widget that displays category filter configuration directly on the Category detail page in Medusa Admin. This provides quick visibility into which filters are active and available without navigating to the dedicated Filters page.

## Location

**File**: `src/admin/widgets/category-filters-widget.tsx`  
**Zone**: `product_category.details.after`

The widget appears below the main category details section.

## Features

### View Mode (Default)

- ✅ **Active Filters Display** - Shows configured filters as blue badges with count
- ✅ **Available Attributes** - Shows detected attributes as gray badges with count
- ✅ **Inheritance Status** - Orange badge when "Override Inheritance" is enabled
- ✅ **Edit Button** - Quick access to editing mode
- ✅ **Empty State** - Helpful message when no filters configured

### Edit Mode

- ✅ **Checkbox Selection** - Toggle filters on/off with visual feedback
- ✅ **Override Inheritance Toggle** - Control parent filter inheritance
- ✅ **Attribute Metadata** - Shows filter type (checkbox, range, etc.)
- ✅ **Live Counter** - Shows number of selected filters
- ✅ **Save/Cancel** - Standard CRUD operations with toast notifications
- ✅ **Auto-refresh** - Reloads page after successful save

## Data Source

The widget reads from `category.metadata`:

```typescript
{
  filter_config: {
    active_filters: string[],  // Attribute key IDs
    override_inheritance: boolean
  },
  available_attributes: string[]  // Auto-synced by middleware
}
```

## Usage

### For Users

1. Navigate to any category detail page (`/app/categories/[id]`)
2. Scroll to "Category Filters" widget
3. Click "Edit" to modify filters
4. Select/deselect attributes using checkboxes
5. Toggle "Override Inheritance" if needed
6. Click "Save Changes"

### For Developers

The widget automatically:
- Fetches all attribute definitions from `/admin/attributes`
- Handles both old (string[]) and new (object[]) filter config formats
- Saves changes to category metadata via standard Medusa API
- Provides loading states and error handling

## Integration with Filters Page

This widget is **read-only by design** to maintain a single source of truth:

- **Filters Page** (`/app/filters`) - Full editing with drag-and-drop ordering
- **Category Widget** - Quick view and basic editing inline

Both update the same `category.metadata.filter_config` structure.

## Technical Details

### API Calls

```typescript
// Fetch attributes
GET /admin/attributes

// Update category
POST /admin/product-categories/{id}
Body: { metadata: { filter_config: {...} } }
```

### Format Compatibility

Supports both legacy and current formats:

```typescript
// Old format (still supported)
active_filters: ["attr_id_1", "attr_id_2"]

// New format (recommended)
active_filters: [
  { attribute_id: "attr_id_1", order: 0 },
  { attribute_id: "attr_id_2", order: 1 }
]
```

The widget normalizes both to simple ID arrays for editing.

## Related Documentation

- [CATEGORY_FILTERS.md](file:///home/alejo/medusa-starter-default/docs/CATEGORY_FILTERS.md) - Complete filter system
- [product-attributes-architecture.md](file:///home/alejo/medusa-starter-default/docs/product-attributes-architecture.md) - Attribute architecture

---

**Note**: This widget complements the dedicated Filters page but does not replace it. For advanced features like drag-and-drop ordering, use `/app/filters`.
