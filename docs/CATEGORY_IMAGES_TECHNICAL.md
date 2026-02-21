---
**Purpose:** Technical reference for category image management — covering the Admin API limitation (images can't be set directly on categories), the metadata-based workaround, and the MinIO folder routing strategy for category vs. product images.

**Solves:** Medusa v2's Admin API does not support setting images on categories natively. This doc documents the discovery and the accepted workaround using `category.metadata.image_url` plus direct MinIO upload with the `categories/` prefix folder.

**Expected Result:** Category images are stored in MinIO under `categories/<category-handle>/` and referenced via metadata. Frontend reads `category.metadata.image_url` to display the category hero image.

---

# Category Images - Technical Reference

## Overview

This document details the technical implementation of category image management, including the critical discovery about Admin API limitations and the solution using metadata.

---

## The Admin API Limitation

### Discovery (2026-01-31)

**Issue**: The Medusa Admin API does not expose the `thumbnail` column for product categories, even though it exists in the database.

**Verification**:
```sql
-- Column EXISTS in database
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'product_category' 
  AND column_name = 'thumbnail';

-- Returns: thumbnail | text
```

**API Behavior**:
```typescript
// API Request
GET /admin/product-categories/{id}

// Response (missing thumbnail!)
{
  "product_category": {
    "id": "pcat_...",
    "name": "LED Strips",
    "handle": "led-strips",
    "metadata": { ... }
    // ❌ No "thumbnail" field
  }
}
```

**Root Cause**: Medusa v2 Admin SDK does not include `thumbnail` in the default field set for categories, and the `fields` query parameter doesn't expose it either.

---

## Solution: metadata.image

Since the Admin API doesn't expose the `thumbnail` column, we store image URLs in `metadata.image`:

### Data Structure

```json
{
  "metadata": {
    "image": {
      "url": "https://bucket-production-2e09.up.railway.app/medusa-media/categories/pcat_led-strips.png"
    }
  }
}
```

### Why This Structure?

1. **Accessible via Admin API**: `metadata` is always included in responses
2. **Clean naming**: `image` instead of `woocommerce_image` (legacy)
3. **Extensible**: Can add `filename`, `alt`, etc. later if needed
4. **Future-proof**: When Medusa fixes the API, we can migrate

---

## Implementation

### Category Image Widget

**File**: `src/admin/widgets/category-image-widget.tsx`

#### Read Pattern

```typescript
const imageData = category.metadata?.image as { url?: string } | undefined
const initialThumbnail = imageData?.url || null
```

#### Write Pattern (Fetch-Merge-Write)

```typescript
// STEP 1: Fetch current metadata
const fetchResponse = await fetch(`${BASE_URL}/admin/product-categories/${data.id}`, {
    credentials: "include",
})

const categoryData = await fetchResponse.json()
const existingMetadata = categoryData.product_category?.metadata || {}

// STEP 2: Merge with new data
const response = await fetch(`${BASE_URL}/admin/product-categories/${data.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
        metadata: {
            ...existingMetadata,  // ✅ Preserve all existing fields
            image: {
                url: payload.thumbnail  // Update only image
            }
        }
    })
})
```

**Critical**: The fetch-merge-write pattern prevents erasing other metadata fields like `prerender`, `filter_config`, etc.

---

## Migration History

### Phase 5A: Import Images to MinIO
- Imported category images from WooCommerce to MinIO
- Stored in `metadata.woocommerce_image`

### Phase 5B: Populate thumbnail Column  
- Copied MinIO URLs to `thumbnail` column in database
- Result: 94 categories with thumbnail data

### Phase 6: Rename Metadata Structure
- Renamed `metadata.woocommerce_image` → `metadata.image`
- Cleaner, more generic naming

### Phase 7: Copy MinIO URLs to Metadata
- Copied from `thumbnail` column to `metadata.image.url`
- Widget now reads from metadata (accessible via API)

---

## Database vs API

| Location | Column `thumbnail` | `metadata.image.url` |
|----------|-------------------|-------------------|
| **Database** | ✅ Exists (type: text) | ✅ Exists (jsonb) |
| **Admin API** | ❌ Not exposed | ✅ Exposed in responses |
| **Widget Reads From** | ❌ Can't access | ✅ Uses this |
| **Widget Writes To** | ❌ Not writable via API | ✅ Writes here |

---

## MinIO Integration

### Upload Flow

1. User clicks "Upload" in Category Image Widget
2. Widget sends file with `x-upload-context: categories` header
3. Upload endpoint adds `context_categories_` prefix
4. Smart Storage detects prefix, routes to `categories/` folder
5. File saved as `categories/pcat_{handle}.{ext}`
6. URL returned: `https://bucket.../medusa-media/categories/pcat_led-strips.png`
7. Widget saves URL to `metadata.image.url`

### Media Library

The widget includes an embedded media library for selecting existing images:

```typescript
const { data } = useQuery({
    queryKey: ["media_files", currentPrefix, searchQuery],
    queryFn: async () => {
        const params = new URLSearchParams()
        if (currentPrefix) params.set("prefix", currentPrefix)
        if (searchQuery) params.set("search", searchQuery)
        
        const response = await fetch(`${BASE_URL}/admin/media?${params}`)
        return response.json()
    }
})
```

**Features**:
- Server-side search across all files
- Auto-navigation to `categories/` folder
- Pagination with S3 continuation tokens

---

## Troubleshooting

### Image Not Displaying

**Check 1: Metadata Structure**
```sql
SELECT 
    name, 
    metadata->>'image' as image_json
FROM product_category 
WHERE handle = 'led-strips';
```

Expected: `{"url": "https://..."}`

**Check 2: Widget Console**
```typescript
console.log('[Category Image Widget] Data received:', {
    thumbnail: category.metadata?.image?.url
})
```

**Check 3: Hard Refresh**
Clear browser cache: Ctrl+Shift+R (Windows) or Cmd+Shift+R (Mac)

### Upload Fails

**Check 1: Context Header**
Network tab → Request Headers → Look for `x-upload-context: categories`

**Check 2: MinIO Permissions**
Verify bucket allows writes from access key

**Check 3: File in Correct Folder**
Check MinIO console → Should be in `categories/` not `content/` or `products/`

---

## Best Practices

### 1. Always Use Fetch-Merge-Write

❌ **WRONG** (erases other metadata):
```typescript
metadata: {
    image: { url: newUrl }  // ❌ Everything else is lost!
}
```

✅ **CORRECT**:
```typescript
metadata: {
    ...existingMetadata,  // ✅ Preserve all fields
    image: { url: newUrl }
}
```

### 2. Handle Missing Data Gracefully

```typescript
const imageUrl = category.metadata?.image?.url || null

if (!imageUrl) {
    return <EmptyState />
}
```

### 3. Verify Upload Context

Always include context header for uploads:
```typescript
headers: {
    "x-upload-context": "categories"  // Ensures correct folder
}
```

---

## Related Documentation

- [IMAGE_MANAGEMENT_MINIO_SYSTEM.md](./IMAGE_MANAGEMENT_MINIO_SYSTEM.md) - Image management system
- [MINIO_STORAGE_IMPLEMENTATION.md](./MINIO_STORAGE_IMPLEMENTATION.md) - MinIO storage implementation

---

## Future Improvements

### If Medusa Fixes the API

When Medusa exposes the `thumbnail` column in Admin API responses:

1. Update widget to read from `category.thumbnail`
2. Keep `metadata.image.url` as fallback for existing data
3. Create migration to move URLs from metadata to column
4. Update documentation

### Potential Enhancements

- [ ] Alt text support in `metadata.image.alt`
- [ ] Multiple images in `metadata.image.gallery[]`
- [ ] Automatic image optimization (resize, compress)
- [ ] Lazy loading in media library

---

## Last Updated

2026-01-31 - Documented Admin API limitation and metadata.image solution
