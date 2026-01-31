# Pre-Render Configuration Guide

## Overview

This guide documents the pre-render configuration for static page generation in the Astro storefront. Categories and products can be marked for pre-rendering to improve performance and SEO.

---

## What is Pre-Render?

**Pre-render** determines whether a page should be:
- **Static (Pre-rendered)**: Generated at build time, served instantly
- **Dynamic (SSR)**: Generated on each request, allows real-time data

---

## Configuration Storage

Pre-render settings are stored in `metadata.prerender`:

```json
{
  "metadata": {
    "prerender": true  // or false
  }
}
```

---

## Admin UI Widgets

### Product Pre-Render Widget

**Location**: Product details page  
**File**: `src/admin/widgets/product-prerender-widget.tsx`

**Features**:
- Toggle switch to enable/disable pre-render
- Auto-saves on change
- Refreshes page to show updated state

### Category Pre-Render Widget

**Location**: Category details page  
**File**: `src/admin/widgets/category-prerender-widget.tsx`

**Features**:
- Toggle switch to enable/disable pre-render
- Fetch-merge-write pattern to preserve metadata
- Auto-saves and refreshes

---

## Bulk Configuration

### Setting Pre-Render for Category Trees

Use the provided script to enable pre-render for specific category hierarchies:

```bash
npx -y tsx set-category-prerender.ts
```

**What it does**:
- Finds specified parent categories by name
- Recursively enables prerender for ALL descendants
- Uses fetch-merge-write to preserve other metadata

**Default categories** (configured in script):
- Cables + all subcategories
- LED Controllers + all subcategories
- LED Channels + all subcategories
- LED Strips + all subcategories
- LED Drivers + all subcategories
- Backlighting + all subcategories
- Linear Lighting Accessories + all subcategories
- BY CATEGORIES (only itself, NOT children)

---

## Implementation Details

### Widget Code Pattern

Both widgets follow the same pattern:

```typescript
const handleToggle = async (checked: boolean) => {
    // Fetch current category data
    const response = await fetch(`/admin/product-categories/${data.id}`)
    const existingMetadata = response.product_category?.metadata || {}
    
    // Update with merge pattern
    await fetch(`/admin/product-categories/${data.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
            metadata: {
                ...existingMetadata,  // Preserve other fields
                prerender: checked     // Update only prerender
            }
        })
    })
    
    window.location.reload()  // Refresh to show change
}
```

**Critical**: Always use fetch-merge-write to avoid erasing other metadata fields.

### Script Pattern

```typescript
// Find category and all descendants
const category = categories.find(c => c.name === "LED Strips")
const descendants = getDescendantsRecursive(category.id)

// Update each with merge pattern
for (const cat of [category, ...descendants]) {
    const newMetadata = {
        ...cat.metadata,
        prerender: true
    }
    
    await client.query(`
        UPDATE product_category 
        SET metadata = $1 
        WHERE id = $2
    `, [JSON.stringify(newMetadata), cat.id])
}
```

---

## Storefront Integration

The Astro storefront reads `metadata.prerender` to determine page generation mode:

```typescript
// In Astro page component
export const prerender = category.metadata?.prerender === true
```

**Benefits**:
- Faster page loads for pre-rendered pages
- Better SEO for static content
- Reduced server load

**Trade-offs**:
- Pre-rendered pages show data from build time
- Dynamic pages show real-time data but load slower

---

## Best Practices

### What to Pre-Render

✅ **Good candidates**:
- Main category landing pages
- Stable product catalogs
- Informational content

❌ **Avoid pre-rendering**:
- Pages with real-time pricing
- User-specific content
- Frequently changing inventory

### When to Update

Update pre-render settings when:
1. Adding new category trees
2. Changing content update frequency
3. Migrating from dynamic to static (or vice versa)

---

## Troubleshooting

### Changes Not Appearing

**Problem**: Toggle switch doesn't update or shows old value

**Solutions**:
1. Hard refresh browser (Ctrl+Shift+R)
2. Clear browser cache
3. Verify metadata in database:
   ```sql
   SELECT name, metadata->>'prerender' as prerender
   FROM product_category
   WHERE name = 'LED Strips';
   ```

### Bulk Script Issues

**Problem**: Script updates wrong categories

**Solution**: Verify category names match exactly (case-sensitive):
```typescript
const found = allCategories.find(cat => 
    cat.name.toLowerCase() === targetName.toLowerCase()
)
```

### Metadata Overwrite

**Problem**: Other metadata fields disappeared after update

**Solution**: Always use fetch-merge-write pattern (see examples above)

---

## Related Documentation

- [Image Management](./image-management.md)
- [Category Filters](./CATEGORY_FILTERS.md)
- [Metadata Safety Audit](../brain/.../metadata_safety_audit.md)

---

## Last Updated

2026-01-31 - Initial documentation with bulk script and widget details
