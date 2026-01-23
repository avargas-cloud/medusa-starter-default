# MinIO/S3 Storage Implementation Guide

## Overview

This document details the complete implementation of MinIO object storage for handling file uploads in Medusa v2. This replaces the default local file storage with a scalable cloud storage solution.

**Implementation Date:** January 23, 2026  
**Medusa Version:** 2.12.5  
**Storage Provider:** MinIO (S3-compatible)  

---

## Table of Contents

1. [Architecture](#architecture)
2. [Prerequisites](#prerequisites)
3. [Installation](#installation)
4. [Configuration](#configuration)
5. [Custom Media Library API](#custom-media-library-api)
6. [Admin Widget Implementation](#admin-widget-implementation)
7. [Troubleshooting](#troubleshooting)
8. [Restoration Guide](#restoration-guide)

---

## Architecture

### Components

```
┌─────────────────────────────────────────────────────────────┐
│                     Medusa Admin UI                         │
│  ┌────────────────────────────────────────────────────┐    │
│  │  Category Image Widget                              │    │
│  │  - Upload Button                                    │    │
│  │  - Media Library Modal (Folder Navigation + Search) │    │
│  └────────────────────────────────────────────────────┘    │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                   Medusa Backend API                        │
│  ┌──────────────────┐         ┌─────────────────────────┐  │
│  │ /admin/files     │         │ /admin/media (custom)   │  │
│  │ (upload)         │         │ (list files/folders)    │  │
│  └──────────────────┘         └─────────────────────────┘  │
└──────────┬──────────────────────────────┬───────────────────┘
           │                              │
           ▼                              ▼
┌─────────────────────────────────────────────────────────────┐
│              @medusajs/file-s3 Provider                     │
│  ┌────────────────────────────────────────────────────┐    │
│  │  AWS S3 SDK Client                                  │    │
│  │  - Upload files                                     │    │
│  │  - List objects (with prefix/delimiter)            │    │
│  └────────────────────────────────────────────────────┘    │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              MinIO Storage (Railway)                        │
│  Bucket: medusa-media                                       │
│  Endpoint: https://bucket-production-2e09.up.railway.app    │
└─────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

### Required Services

1. **MinIO Instance** (deployed on Railway)
   - Endpoint URL
   - Access Key ID
   - Secret Access Key
   - Bucket name

2. **Medusa v2 Backend** (version 2.12.5+)

3. **Node.js** (v20+) and **Yarn** package manager

---

## Installation

### 1. Install S3 File Provider

```bash
yarn add @medusajs/file-s3
```

The package includes:
- `@aws-sdk/client-s3` (v3.974.0)
- `@aws-sdk/lib-storage` (v3.974.0)

---

## Configuration

### 1. Environment Variables

Add the following to your `.env` file:

```bash
# MinIO / S3 Storage Configuration
MINIO_ENDPOINT=https://bucket-production-2e09.up.railway.app
MINIO_ACCESS_KEY=xvyYtNjjihzWeLodFtfN4UYEdNtMJKTk
MINIO_SECRET_KEY=HQ2pjxOg5ISSiVwcogdUwnqSbxr87PgNbMLxwiUcrcRVUxv2
MINIO_BUCKET=medusa-media
```

> **Security Note:** Never commit `.env` files to version control. Use separate credentials for production and development.

### 2. Medusa Configuration

Update [medusa-config.ts](file:///home/alejo/medusa-starter-default/medusa-config.ts):

```typescript
modules: [
  {
    resolve: "@medusajs/medusa/file",
    options: {
      providers: [
        {
          resolve: "@medusajs/file-s3",
          id: "s3",
          options: {
            file_url: process.env.MINIO_ENDPOINT 
              ? `${process.env.MINIO_ENDPOINT}/${process.env.MINIO_BUCKET}` 
              : "",
            access_key_id: process.env.MINIO_ACCESS_KEY,
            secret_access_key: process.env.MINIO_SECRET_KEY,
            region: "us-east-1",
            bucket: process.env.MINIO_BUCKET,
            endpoint: process.env.MINIO_ENDPOINT,
            s3_force_path_style: true,
          },
        },
      ],
    },
  },
]
```

**Key Points:**
- Use `@medusajs/medusa/file` as the parent module
- Nest the S3 provider inside `providers` array
- Set `s3_force_path_style: true` for MinIO compatibility
- `file_url` must be the full public URL prefix for uploaded files

### 3. SDK Configuration for Browser Compatibility

Update [src/lib/sdk.ts](file:///home/alejo/medusa-starter-default/src/lib/sdk.ts):

```typescript
import Medusa from "@medusajs/js-sdk"

export let BASE_URL = "http://localhost:9000"

// Robust URL resolution for both Browser (Admin UI) and Node (Server scripts)
if (typeof window !== "undefined") {
    // Browser: Use localhost if on localhost, otherwise assume production
    BASE_URL = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
        ? "http://localhost:9000" 
        : "https://medusa-starter-default-production-b69e.up.railway.app"
} else if (typeof process !== "undefined" && process.env?.MEDUSA_BACKEND_URL) {
    // Node: Use env var
    BASE_URL = process.env.MEDUSA_BACKEND_URL
} else {
    // Fallback
    BASE_URL = "https://medusa-starter-default-production-b69e.up.railway.app"
}

export const sdk = new Medusa({
    baseUrl: BASE_URL,
    debug: false,
    auth: {
        type: "session",
    },
})
```

**Why?**
- The SDK instance doesn't expose `sdk.config.baseUrl` in Medusa v2
- Exporting `BASE_URL` allows widgets and API routes to use the correct backend URL
- Prevents crashes from accessing `process.env` in browser context

---

## Custom Media Library API

### Purpose

The default Medusa file endpoints (`/admin/files`) only handle uploads. We need a custom endpoint to:
1. List files from MinIO storage
2. Support folder navigation (using S3 prefix/delimiter)
3. Enable search and filtering in the Admin UI

### Implementation

Create [src/api/admin/media/route.ts](file:///home/alejo/medusa-starter-default/src/api/admin/media/route.ts):

```typescript
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3"

export const GET = async (
    req: MedusaRequest,
    res: MedusaResponse
) => {
    try {
        const prefix = (req.query.prefix as string) || ""
        
        // Create S3 client directly using environment variables
        const s3Client = new S3Client({
            endpoint: process.env.MINIO_ENDPOINT,
            region: "us-east-1",
            credentials: {
                accessKeyId: process.env.MINIO_ACCESS_KEY || "",
                secretAccessKey: process.env.MINIO_SECRET_KEY || "",
            },
            forcePathStyle: true, // Required for MinIO
        })

        const bucket = process.env.MINIO_BUCKET || "medusa-media"

        // List objects from S3/MinIO with delimiter to get folders
        const command = new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            Delimiter: "/", // This makes S3 return CommonPrefixes (folders)
            MaxKeys: 100,
        })

        const response = await s3Client.send(command)
        
        // Folders (CommonPrefixes)
        const folders = (response.CommonPrefixes || []).map((item) => ({
            id: item.Prefix,
            name: item.Prefix?.replace(prefix, "").replace("/", "") || "",
            type: "folder" as const,
            prefix: item.Prefix,
        }))

        // Files (Contents)
        const files = (response.Contents || [])
            .filter(item => item.Key !== prefix) // Exclude the folder itself
            .map((item) => ({
                id: item.Key,
                url: `${process.env.MINIO_ENDPOINT}/${bucket}/${item.Key}`,
                name: item.Key?.replace(prefix, "") || "",
                key: item.Key,
                size: item.Size,
                type: "file" as const,
                last_modified: item.LastModified,
            }))

        res.json({
            folders,
            files,
            prefix,
            count: folders.length + files.length
        })
    } catch (error) {
        console.error("Media library error:", error)
        res.status(500).json({ 
            message: "Failed to list files", 
            error: error.message,
            folders: [],
            files: [],
            count: 0
        })
    }
}
```

**API Endpoint:** `GET /admin/media?prefix={folder_path}`

**Query Parameters:**
- `prefix` (optional): Folder path to list (e.g., `categories/`, `products/images/`)

**Response Format:**
```json
{
  "folders": [
    {
      "id": "categories/",
      "name": "categories",
      "type": "folder",
      "prefix": "categories/"
    }
  ],
  "files": [
    {
      "id": "image.jpg",
      "url": "https://bucket.railway.app/medusa-media/image.jpg",
      "name": "image.jpg",
      "key": "image.jpg",
      "size": 45678,
      "type": "file",
      "last_modified": "2026-01-23T12:00:00.000Z"
    }
  ],
  "prefix": "",
  "count": 2
}
```

---

## Admin Widget Implementation

### Category Image Widget with Media Library

Full implementation in [src/admin/widgets/category-image-widget.tsx](file:///home/alejo/medusa-starter-default/src/admin/widgets/category-image-widget.tsx)

**Key Features:**
1. **Upload**: Direct upload to MinIO via `/admin/files`
2. **Remove**: Unlink image from category (preserves file in storage)
3. **Media Library Modal**:
   - Folder navigation with breadcrumbs
   - Search/filter by filename
   - Click to select image from existing uploads

**Widget Structure:**

```typescript
import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Container, Heading, Button, IconButton, toast, Drawer, Input } from "@medusajs/ui"
import { DetailWidgetProps, AdminProductCategory } from "@medusajs/framework/types"
import { Trash, Photo, CloudArrowUp, MagnifyingGlass } from "@medusajs/icons"
import { useState, useRef } from "react"
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query"
import { BASE_URL } from "../../lib/sdk"

const MediaLibraryModal = ({ open, onClose, onSelect }) => {
    const [currentPrefix, setCurrentPrefix] = useState("")
    const [searchQuery, setSearchQuery] = useState("")
    
    const { data, isLoading } = useQuery({
        queryKey: ["media_files", currentPrefix],
        enabled: open, // Only fetch when modal is open
        queryFn: async () => {
            const params = new URLSearchParams()
            if (currentPrefix) params.set("prefix", currentPrefix)
            
            const response = await fetch(`${BASE_URL}/admin/media?${params}`, {
                credentials: "include",
            })
            return response.json()
        }
    })

    // ... folder navigation logic ...
    // ... search filtering ...
    // ... breadcrumb rendering ...
}

const CategoryImageWidget = ({ data }) => {
    // ... upload logic using native fetch ...
    // ... update category metadata ...
    // ... remove image logic ...
}

export const config = defineWidgetConfig({
    zone: "product_category.details.side.after",
})
```

**Critical Implementation Details:**

1. **Use `BASE_URL` instead of `sdk.config.baseUrl`**
   - `sdk.config` doesn't exist in Medusa JS SDK v2
   - Import from `src/lib/sdk.ts`

2. **Query only runs when modal is open**
   ```typescript
   enabled: open, // Prevents unnecessary API calls
   ```

3. **Native `fetch` with credentials**
   ```typescript
   credentials: "include" // Required for session authentication
   ```

4. **Query key includes `currentPrefix`**
   ```typescript
   queryKey: ["media_files", currentPrefix]
   // Triggers refetch when navigating folders
   ```

---

## Troubleshooting

### Common Issues and Solutions

#### 1. **White Screen / Widget Crashes**

**Symptoms:**
- Admin panel shows blank screen when viewing category
- Console error: `Cannot read properties of undefined`

**Causes & Fixes:**

**a) Missing Imports**
```typescript
// ❌ WRONG
import { sdk } from "../../lib/sdk"
const url = sdk.config.baseUrl // ❌ sdk.config doesn't exist

// ✅ CORRECT
import { BASE_URL } from "../../lib/sdk"
const url = BASE_URL
```

**b) Invalid Icon Import**
```typescript
// ❌ WRONG - Spinner doesn't exist in @medusajs/icons
import { Spinner } from "@medusajs/icons"

// ✅ CORRECT - Use text or different approach
<div>Loading...</div>
```

**c) Accessing `process.env` in Browser**
```typescript
// ❌ WRONG - Crashes in browser
const url = process.env.MEDUSA_BACKEND_URL

// ✅ CORRECT - Use exported BASE_URL
import { BASE_URL } from "../../lib/sdk"
```

#### 2. **"Unauthorized" Error on `/admin/media`**

**Symptom:**
```json
{"message": "Unauthorized"}
```

**Cause:** Missing authentication middleware

**Fix:** Ensure the route function is exported as `GET` (capitalized):
```typescript
// ✅ CORRECT
export const GET = async (req, res) => { ... }

// ❌ WRONG
export default async (req, res) => { ... }
```

Medusa automatically applies session authentication to routes in `/admin/*` when using the named export pattern.

#### 3. **Empty Media Library**

**Symptom:** Modal opens but shows no files/folders

**Debugging Steps:**

1. **Check Network Tab:**
   - Request to `/admin/media` returns 200?
   - Response has `files` or `folders` array?

2. **Verify MinIO Credentials:**
   ```bash
   # Test S3 connection
   curl -v "$MINIO_ENDPOINT"
   ```

3. **Check Query Execution:**
   ```typescript
   // Add logging
   const { data, isLoading } = useQuery({
       queryKey: ["media_files", currentPrefix],
       enabled: open, // ← Check this is true when modal opens
       queryFn: async () => {
           console.log("Fetching media with prefix:", currentPrefix)
           // ... rest of query
       }
   })
   ```

4. **Verify Environment Variables:**
   ```bash
   # In terminal
   echo $MINIO_ENDPOINT
   echo $MINIO_BUCKET
   ```

#### 4. **Upload Fails**

**Symptoms:**
- Upload button stuck in loading state
- Toast error: "Upload failed"

**Debugging:**

1. **Check `/admin/files` endpoint exists:**
   ```bash
   curl -X POST http://localhost:9000/admin/files \
     -H "Cookie: connect.sid=..." \
     -F "files=@test.jpg"
   ```

2. **Verify MinIO bucket permissions:**
   - Bucket must allow writes from the access key
   - Check Railway MinIO console

3. **Check file size limits:**
   - Medusa has default limits
   - MinIO may have separate limits

#### 5. **TypeScript Errors**

**Common Errors:**

```typescript
// Error: Property 'config' does not exist on type 'Medusa'
sdk.config.baseUrl
// Fix: Use exported BASE_URL

// Error: Parameter 'file' implicitly has an 'any' type
data?.files?.map((file) => ...)
// Fix: Add explicit type
data?.files?.map((file: any) => ...)
```

---

## Restoration Guide

### Complete File Restoration

If the implementation breaks, restore these key files:

#### 1. **medusa-config.ts**

```typescript
modules: [
  {
    resolve: "@medusajs/medusa/file",
    options: {
      providers: [
        {
          resolve: "@medusajs/file-s3",
          id: "s3",
          options: {
            file_url: process.env.MINIO_ENDPOINT 
              ? `${process.env.MINIO_ENDPOINT}/${process.env.MINIO_BUCKET}` 
              : "",
            access_key_id: process.env.MINIO_ACCESS_KEY,
            secret_access_key: process.env.MINIO_SECRET_KEY,
            region: "us-east-1",
            bucket: process.env.MINIO_BUCKET,
            endpoint: process.env.MINIO_ENDPOINT,
            s3_force_path_style: true,
          },
        },
      ],
    },
  },
]
```

#### 2. **src/lib/sdk.ts**

Restore from: [GitHub commit e143f9c](https://github.com/avargas-cloud/medusa-starter-default/blob/e143f9c/src/lib/sdk.ts)

#### 3. **src/api/admin/media/route.ts**

Restore from: [GitHub commit e143f9c](https://github.com/avargas-cloud/medusa-starter-default/blob/e143f9c/src/api/admin/media/route.ts)

#### 4. **src/admin/widgets/category-image-widget.tsx**

Restore from: [GitHub commit e143f9c](https://github.com/avargas-cloud/medusa-starter-default/blob/e143f9c/src/admin/widgets/category-image-widget.tsx)

### Quick Recovery Commands

```bash
# 1. Checkout working version
git checkout e143f9c -- src/lib/sdk.ts
git checkout e143f9c -- src/api/admin/media/route.ts
git checkout e143f9c -- src/admin/widgets/category-image-widget.tsx
git checkout e143f9c -- medusa-config.ts

# 2. Verify environment variables
cat .env | grep MINIO

# 3. Restart dev server
yarn dev

# 4. Test in browser
# Navigate to: http://localhost:9000/app/categories/{category-id}
# Click "Library" button
```

---

## Best Practices

### Security

1. **Never commit credentials:**
   ```bash
   # Add to .gitignore
   .env
   .env.local
   .env.*.local
   ```

2. **Use separate credentials per environment:**
   - Development: Limited bucket access
   - Production: Full access with rotation policy

3. **Implement file type validation:**
   ```typescript
   const allowedTypes = ['image/jpeg', 'image/png', 'image/webp']
   if (!allowedTypes.includes(file.type)) {
       throw new Error('Invalid file type')
   }
   ```

### Performance

1. **Limit query results:**
   ```typescript
   MaxKeys: 100 // Prevent loading thousands of files
   ```

2. **Use pagination for large buckets:**
   ```typescript
   const command = new ListObjectsV2Command({
       Bucket: bucket,
       Prefix: prefix,
       ContinuationToken: nextToken, // For pagination
   })
   ```

3. **Cache query results:**
   ```typescript
   const { data } = useQuery({
       queryKey: ["media_files", currentPrefix],
       staleTime: 60000, // Cache for 1 minute
   })
   ```

---

## References

- [Medusa v2 File Module Documentation](https://docs.medusajs.com/resources/file-module)
- [@medusajs/file-s3 NPM Package](https://www.npmjs.com/package/@medusajs/file-s3)
- [AWS S3 SDK Documentation](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-client-s3/)
- [MinIO Documentation](https://min.io/docs/minio/linux/index.html)

---

## Changelog

### 2026-01-23 - Initial Implementation

**Added:**
- MinIO/S3 storage configuration
- Custom `/admin/media` API endpoint
- Category Image Widget with Media Library
- Folder navigation and search functionality
- Complete TypeScript support

**Fixed:**
- SDK `config.baseUrl` access errors
- Browser crashes from `process.env` access
- Authentication issues on custom routes
- TypeScript errors in widget implementation

**Files Modified:**
- `medusa-config.ts`
- `src/lib/sdk.ts`
- `src/api/admin/media/route.ts` (new)
- `src/admin/widgets/category-image-widget.tsx`
- `.env`

**Commits:**
- `e143f9c` - feat: complete media library with folder navigation and search
- `6d75930` - fix(widget): remove invalid Spinner import
- `4626609` - fix: sdk environment check for browser compatibility

---

## Support

For issues or questions:
1. Check [Troubleshooting](#troubleshooting) section
2. Review deployment logs on Railway
3. Verify all environment variables are set correctly
4. Ensure MinIO bucket is accessible and has proper permissions
