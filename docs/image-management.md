# Image Management System

Complete documentation for the Medusa image management system with MinIO storage, automatic folder routing, and integrated media library.

---

## Overview

**Storage Solution:** MinIO (S3-compatible)  
**Module:** Smart Storage (custom file provider)  
**Structure:** Automatic folder routing (`products/`, `categories/`, `content/`)  
**Features:**
- Automatic folder detection based on context
- Server-side search in media library
- Auto-navigation to relevant folders
- Integrated media library widget

---

## Architecture

### 1. Smart Storage Module

**Location:** `src/modules/smart-storage/`

Automatically routes uploaded files to the correct folders based on context headers.

#### Folder Routing Logic

| Context Header | Destination Folder | Example |
|---------------|-------------------|---------|
| `x-upload-context: products` | `products/` | `image.jpg` → `products/image.jpg` |
| `x-upload-context: categories` | `categories/` | `banner.png` → `categories/banner.png` |
| No context | `content/` | `logo.svg` → `content/logo.svg` |

#### Phantom Prefix System

The system uses a "phantom prefix" mechanism to pass context through Medusa's upload workflow:

1. **Frontend** sends `x-upload-context` header
2. **Upload endpoint** adds temporary prefix to filename (`context_products_filename.jpg`)
3. **Smart Storage** detects prefix, routes to correct folder, and removes prefix before saving
4. **Result:** File saved with clean name in the correct folder

### 2. Upload Context Detection

**File:** `src/admin/widgets/upload-context-interceptor.tsx`

Global fetch/XHR interceptor that automatically injects the `x-upload-context` header based on the current page URL.

**Zones configured:**
- `product.details.before`
- `product.list.before`
- `category.details.before`
- `category.list.before`

**Detection logic:**
```typescript
if (path.includes("/products")) return "products"
if (path.includes("/categories")) return "categories"
return null
```

### 3. Media Library Integration

Two media library implementations:

#### A. Product Media Library
**File:** `src/admin/components/MediaLibraryModal.tsx`  
**Widget:** `src/admin/widgets/product-media-library-widget.tsx`

Uses the shared `MediaLibraryModal` component and relies on the upload context interceptor.

#### B. Category Image Widget
**File:** `src/admin/widgets/category-image-widget.tsx`

Includes its own embedded `MediaLibraryModal` and uses **direct fetch** with explicit `x-upload-context: categories` header (bypassing SDK to ensure header is sent).

### 4. Server-Side Search

**Endpoint:** `src/api/admin/media/route.ts`

**Features:**
- Pagination with S3 continuation tokens
- **Server-side search** across all files (not just current page)
- Folder navigation with breadcrumbs
- Auto-navigation to context-specific folders

**Search implementation:**
```typescript
// When search query is provided, fetch ALL objects and filter
if (searchQuery) {
    let allObjects = []
    let nextToken = null
    
    do {
        const response = await s3Client.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: nextToken
        }))
        allObjects.push(...(response.Contents || []))
        nextToken = response.NextContinuationToken
    } while (nextToken)
    
    // Filter by search query
    const filtered = allObjects.filter(obj => 
        obj.Key.toLowerCase().includes(searchQuery.toLowerCase())
    )
    
    return filtered
}
```

---

## Implementation Details

### File Upload Flow

#### Products
1. User uploads image in Product media section
2. Upload context interceptor detects `/products` in URL
3. Interceptor injects `x-upload-context: products` header
4. Upload endpoint adds `context_products_` prefix to filename
5. Smart Storage detects prefix, routes to `products/`, removes prefix
6. File saved as `products/original-filename.jpg`

#### Categories
1. User uploads image in Category widget
2. Widget uses **direct fetch** with explicit header:
   ```typescript
   fetch('/admin/uploads', {
       headers: { 'x-upload-context': 'categories' },
       body: formData
   })
   ```
3. Upload endpoint adds `context_categories_` prefix
4. Smart Storage routes to `categories/`, removes prefix
5. File saved as `categories/original-filename.jpg`

### Media Library Features

**Auto-Navigation:**
- Opens in `products/` folder when accessed from product pages
- Opens in `categories/` folder when accessed from category pages
- Implemented via `useEffect` hook checking `window.location.pathname`

**Server-Side Search:**
- Search query sent as `?search=term` parameter
- Backend fetches all objects and filters by name
- Supports searching across all pages (not limited to first 100 results)

**Pagination:**
- Uses S3 continuation tokens for efficient pagination
- Tracks page history for back/forward navigation
- Shows "Page X of many" indicator

---

## Configuration

### medusa-config.ts

```typescript
{
  resolve: "./src/modules/smart-storage",
  id: "smart-s3",
  options: {
    file_url: process.env.MINIO_ENDPOINT + "/" + process.env.MINIO_BUCKET,
    accessKeyId: process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
    region: "us-east-1",
    bucket: process.env.MINIO_BUCKET,
    endpoint: process.env.MINIO_ENDPOINT,
  }
}
```

### Environment Variables

Required in `.env`:

```bash
MINIO_ENDPOINT=https://your-minio.example.com
MINIO_BUCKET=medusa-media
MINIO_ACCESS_KEY=your_access_key
MINIO_SECRET_KEY=your_secret_key
```

### CORS Configuration

Upload endpoint configured to allow custom headers:

**File:** `src/api/admin/uploads/route.ts`

```typescript
export const CORS = {
    origin: true,
    credentials: true,
    allowedHeaders: [
        "Content-Type",
        "Authorization",
        "x-upload-context"  // Custom header
    ]
}
```

---

## Usage Guide

### Uploading Images

#### From Product Pages
1. Navigate to Products → Edit Product → Media tab
2. Click "Upload" or drag-and-drop images
3. Images automatically saved to `products/` folder
4. Context detection is automatic (no manual action needed)

#### From Category Pages
1. Navigate to Categories → Edit Category
2. Use "Category Image" widget
3. Click "Upload" or "Select from Library"
4. Images automatically saved to `categories/` folder
5. Widget uses explicit header (no interceptor needed)

### Using Media Library

#### Search
1. Open Media Library modal
2. Type search term in search box
3. Results shown from **all pages** (server-side search)
4. Search works across entire folder, not just visible items

#### Navigation
- Library auto-opens in relevant folder (products/categories)
- Click folder names to navigate
- Use breadcrumbs to go back
- Use "Back" button to go up one level

#### Pagination
- Click "Next" to load more items (100 per page)
- Click "Previous" to go back
- Current page indicator shown at bottom

---

## File Structure

```
src/
├── modules/
│   └── smart-storage/
│       ├── index.ts              # Module definition
│       └── service.ts            # S3 upload logic with routing
├── admin/
│   ├── components/
│   │   └── MediaLibraryModal.tsx # Shared media library component
│   └── widgets/
│       ├── category-image-widget.tsx        # Category widget (uses direct fetch)
│       ├── product-media-library-widget.tsx # Product widget (uses SDK)
│       └── upload-context-interceptor.tsx   # Global context injector
└── api/
    └── admin/
        ├── uploads/
        │   └── route.ts          # Upload endpoint with phantom prefix
        └── media/
            └── route.ts          # Media list API with server-side search
```

---

## Key Implementation Files

### 1. Smart Storage Service
**File:** `src/modules/smart-storage/service.ts`

```typescript
// Detect folder from phantom prefix
const getTargetFolder = (filename: string): string => {
    if (filename.startsWith("context_products_")) return "products"
    if (filename.startsWith("context_categories_")) return "categories"
    return "content"
}

// Remove phantom prefix
const getCleanFilename = (filename: string): string => {
    return filename
        .replace(/^context_products_/, "")
        .replace(/^context_categories_/, "")
}

// Upload with routing
async upload(file) {
    const folder = getTargetFolder(file.filename)
    const cleanName = getCleanFilename(file.filename)
    const s3Key = `${folder}/${cleanName}`
    
    await s3Client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        Body: fileContent,
        ContentType: file.mimetype
    }))
}
```

### 2. Upload Endpoint
**File:** `src/api/admin/uploads/route.ts`

```typescript
const files = req.files as any[]
const context = req.headers["x-upload-context"] as string

let prefix = ""
if (context === "products") prefix = "context_products_"
if (context === "categories") prefix = "context_categories_"

const filesWithContext = files.map(f => ({
    filename: prefix ? `${prefix}${f.originalname}` : f.originalname,
    mimeType: f.mimetype,
    content: f.buffer,
    access: "public" as const,
}))

const { result } = await uploadFilesWorkflow(req.scope).run({
    input: { files: filesWithContext }
})
```

### 3. Category Widget (Direct Fetch)
**File:** `src/admin/widgets/category-image-widget.tsx`

```typescript
const handleFileChange = async (e) => {
    const file = e.target.files?.[0]
    
    const formData = new FormData()
    formData.append("files", file)
    
    // Direct fetch with explicit header
    const response = await fetch(`${BASE_URL}/admin/uploads`, {
        method: "POST",
        headers: {
            "x-upload-context": "categories",  // Explicit header
        },
        credentials: "include",
        body: formData,
    })
    
    const data = await response.json()
    const url = data.files?.[0]?.url
    
    updateCategory.mutate({ metadata: { thumbnail: url } })
}
```

### 4. Media Library with Search
**File:** `src/admin/widgets/category-image-widget.tsx` (lines 23-51)

```typescript
const { data, isLoading } = useQuery({
    queryKey: ["media_files", currentPrefix, continuationToken, searchQuery],
    enabled: open,
    refetchOnMount: true,
    queryFn: async () => {
        const params = new URLSearchParams()
        if (currentPrefix) params.set("prefix", currentPrefix)
        if (continuationToken) params.set("continuationToken", continuationToken)
        if (searchQuery) params.set("search", searchQuery)  // Server-side search
        
        const response = await fetch(`${BASE_URL}/admin/media?${params.toString()}`)
        return response.json()
    }
})
```

---

## Troubleshooting

### Images Upload to Wrong Folder

**Problem:** Images go to `content/` instead of `products/` or `categories/`

**Solutions:**
1. **For products:** Verify upload context interceptor is loaded by checking widget zones
2. **For categories:** Ensure category widget uses direct fetch (not SDK)
3. Check browser console for context detection logs during debugging
4. Verify `x-upload-context` header in Network tab

### Media Library Search Not Working

**Problem:** Search only finds items on current page

**Solutions:**
1. Verify `searchQuery` is in `queryKey` of `useQuery`
2. Check `search` parameter is sent to backend in Network tab
3. Ensure backend endpoint implements full search (fetches all objects when `searchQuery` present)
4. Clear browser cache and rebuild admin: `rm -rf .medusa && yarn build`

### Widget Not Loading

**Problem:** Upload context interceptor or media library widget doesn't appear

**Solutions:**
1. Verify widget is configured with correct zones in `config`
2. Rebuild admin panel: `yarn build`
3. Clear `.medusa` cache: `rm -rf .medusa`
4. Restart dev server: `yarn dev`

### 0-Byte Files

**Problem:** Uploaded files have 0 bytes in MinIO

**Solutions:**
1. Verify `content` property is set in upload endpoint
2. Check file buffer is passed correctly from Multer
3. Ensure `access: "public"` is set in file object
4. Check S3 upload command includes `Body` parameter

---

## Best Practices

### 1. Folder Organization
- **Products:** All product images in `products/`
- **Categories:** Category banners/thumbnails in `categories/`
- **Content:** Logos, general assets in `content/`

### 2. Widget Development
- Use **SDK** for products (interceptor handles context)
- Use **direct fetch** for categories (explicit header required)
- Always include `searchQuery` in media library `queryKey`
- Pass `search` parameter to backend for server-side filtering

### 3. Debugging
- Add temporary `console.log` to verify context detection
- Check Network tab for `x-upload-context` header
- Verify file lands in correct MinIO folder
- Test search across multiple pages

### 4. Performance
- Server-side search only when needed (small datasets can use client-side)
- Use pagination to limit initial load
- Implement continuation tokens for efficient S3 navigation

---

## Migration History

### MinIO Reorganization (Completed)

**Before:**
```
medusa-media/
└── products/
    ├── 9599/  ← WooCommerce ID folders
    │   ├── image1.jpg
    │   └── image2.png
    ├── 9590/
    └── 8378/
```

**After:**
```
medusa-media/
├── products/
│   ├── image1.jpg  ← All flat
│   ├── image2.png
│   └── image3.jpg
├── categories/
│   ├── banner.jpg
│   └── icon.png
└── content/
    └── logo.svg
```

**Results:**
- **824 files** moved to `products/`
- **178 duplicates** handled with timestamp suffixes
- **918 URLs** updated in database

---

## Testing Checklist

### Upload Testing
- [ ] Upload image from product page → Lands in `products/`
- [ ] Upload image from category page → Lands in `categories/`
- [ ] File has correct size (not 0 bytes)
- [ ] Filename is clean (no `context_` prefix)

### Media Library Testing
- [ ] Library opens in correct folder (auto-navigation)
- [ ] Search finds items across all pages (server-side)
- [ ] Pagination works (next/previous buttons)
- [ ] Can navigate between folders
- [ ] Can select image and it updates entity

### Context Detection Testing
- [ ] Interceptor runs on product pages
- [ ] Category widget sends explicit header
- [ ] Upload endpoint receives context header
- [ ] Smart Storage routes to correct folder

---

## Related Documentation

- [Smart Storage Module](../modules/smart-storage/)
- [MinIO Configuration](./minio-setup.md)
- [Admin Widgets Guide](./admin-widgets.md)