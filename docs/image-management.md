# Image Management System

This document describes the complete image management system including MinIO storage, file organization, and the Smart Storage module.

---

## Overview

**Storage Solution:** MinIO (S3-compatible)  
**Module:** Smart Storage (custom file provider)  
**Structure:** Flat folder organization (`products/`, `categories/`, `content/`)

---

## MinIO Reorganization (Completed)

### Before

```
medusa-media/
├── products/
│   ├── 9599/  ← WooCommerce ID folders
│   │   ├── image1.jpg
│   │   └── image2.png
│   ├── 9590/
│   └── 8378/
```

### After

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

### Migration Results

- **824 files** moved from nested folders to `products/`
- **178 duplicates** handled with timestamp suffixes
- **918 URLs** updated in database:
  - 824 in `image` table
  - 94 in `product_category.metadata`

---

## Smart Storage Module

### Purpose

Automatically route uploaded files to correct folders based on filename prefixes.

### Routing Logic

| Filename Pattern | Destination | Example |
|-----------------|-------------|---------|
| `prod_*` | `products/` | `prod_shoes.jpg` → `products/prod_shoes-123.jpg` |
| `cat_*` | `categories/` | `cat_summer.png` → `categories/cat_summer-124.png` |
| Default | `content/` | `logo.svg` → `content/logo-125.svg` |

### Implementation

**Location:** `src/modules/smart-storage/`

**Files:**
- `service.ts` - File provider service
- `index.ts` - Module definition

**Configuration:** `medusa-config.ts`
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

---

## Usage

### Admin Panel

**For Products:**
1. Rename file to `prod_productname.jpg`
2. Upload via Product → Media
3. File saved to `products/prod_productname-{timestamp}.jpg`

**For Categories:**
1. Rename file to `cat_categoryname.jpg`  
2. Upload via Category widget
3. File saved to `categories/cat_categoryname-{timestamp}.jpg`

**For Other Content:**
- Upload with any name
- File saved to `content/{filename}-{timestamp}.{ext}`

### Programmatic/API

```typescript
const file = {
  originalname: "prod_zapatos.jpg", // Prefix determines folder
  buffer: imageBuffer,
  mimetype: "image/jpeg"
}

await fileService.upload(file)
// → Saved to: products/prod_zapatos-1737654321.jpg
```

---

## Environment Variables

Required in `.env`:

```bash
MINIO_ENDPOINT=https://your-minio.example.com
MINIO_BUCKET=medusa-media
MINIO_ACCESS_KEY=your_access_key
MINIO_SECRET_KEY=your_secret_key
```

---

## Migration Scripts

### Reorganize MinIO

**File:** `scripts/reorganize-minio.ts`

**Purpose:** Move files from nested folders to flat structure

**Usage:**
```bash
# Preview
npx tsx scripts/reorganize-minio.ts

# Execute
npx tsx scripts/reorganize-minio.ts --live
```

### Update Database URLs

**File:** `scripts/update-image-urls.ts`

**Purpose:** Update URLs after reorganization

**Usage:**
```bash
# Preview
npx tsx scripts/update-image-urls.ts

# Execute
npx tsx scripts/update-image-urls.ts --live
```

---

## Best Practices

1. **Naming Convention:**
   - Products: `prod_{description}.{ext}`
   - Categories: `cat_{description}.{ext}`
   - Generic: `{description}.{ext}` (goes to content/)

2. **File Organization:**
   - Keep products in `products/`
   - Keep categories in `categories/`
   - Keep logos, banners, misc in `content/`

3. **Avoid:**
   - Creating manual subfolders
   - Uploading without prefixes if targeting specific folder

---

## Troubleshooting

### Images Not Loading

1. Check MinIO bucket is public
2. Verify `MINIO_ENDPOINT` is accessible
3. Check URL in database matches MinIO path

### Files Going to Wrong Folder

1. Verify filename has correct prefix (`prod_` or `cat_`)
2. Check Smart Storage module is loaded
3. Restart backend after config changes

### Module Not Loading

```bash
# Check logs
tail -f logs/medusa.log

# Look for: "smart-storage module loaded"
```

---

## Related Documentation

- [MinIO Storage Implementation](./minio-storage-implementation.md)
- [Smart Storage Usage Guide](../brain/{conversation-id}/smart-storage-guide.md)
