# Smart Storage vs File Minio Flat — Storage Provider Reference
> **Type**: Technical Reference
> **Repo**: backend
> **Last verified**: 2026-04-02
> **Status**: Current

---

## What they are and why both exist

There are two custom MinIO/S3 storage provider implementations in the backend:

1. **`smart-storage`** — the **active** Medusa File module provider (registered in `medusa-config.ts`)
2. **`file-minio-flat`** — an **alternate/legacy** implementation, not currently registered in `medusa-config.ts`

Both implement the `AbstractFileProviderService` interface from `@medusajs/utils` and store files in MinIO using the AWS SDK.

---

## Smart Storage (`src/modules/smart-storage/`)

### Identifier

`"smart-s3"` — registered as the default file provider under `@medusajs/medusa/file`.

### Key Feature: Phantom Prefix Routing

Smart Storage uses **phantom context prefixes** in filenames to route uploads to different MinIO folders without needing an extra metadata parameter:

| Filename prefix | MinIO folder |
|-----------------|-------------|
| `context_products_*` or `prod_*` | `products/` |
| `context_categories_*` or `cat_*` | `categories/` |
| anything else | `content/` |

The prefix is **stripped from the stored filename** — it's a routing hint, not part of the permanent name.

### Upload Flow

1. Detect folder from filename prefix
2. Remove phantom prefix from filename
3. Prepend `{timestamp}-` to the cleaned filename
4. Upload to `{folder}/{timestamp}-{cleanName}` in MinIO
5. Return public URL

### Protected Uploads

Files uploaded via `uploadProtected()` go to the `protected/` prefix and generate presigned URLs (1 hour expiry) instead of public URLs.

---

## File Minio Flat (`src/modules/file-minio-flat/`)

### Key Difference

Simpler routing — only two folders:

| Filename condition | MinIO folder |
|-------------------|-------------|
| starts with `prod_` or contains `/products/` | `products/` |
| starts with `cat_` or contains `/categories/` | `categories/` |
| anything else | `products/` (default fallback) |

Does **not** strip prefixes — the prefix stays in the stored key.

### Current Registration Status

**Not registered** in `medusa-config.ts`. This implementation exists as an alternative that was used before `smart-storage` was developed or as a fallback reference.

---

## Which One to Use

Use **`smart-storage`** for all new work. It is the active provider. `file-minio-flat` should not be registered alongside `smart-storage` as a second provider without a specific reason.

---

## Shared Configuration

Both providers accept the same environment variables:

| Variable | Purpose |
|----------|---------|
| `MINIO_ENDPOINT` | MinIO server URL (e.g., `https://bucket-production-xxxx.up.railway.app`) |
| `MINIO_ACCESS_KEY` | S3-compatible access key |
| `MINIO_SECRET_KEY` | S3-compatible secret key |
| `MINIO_BUCKET` | Bucket name |

The `file_url` option is constructed as `{MINIO_ENDPOINT}/{MINIO_BUCKET}` for public URL generation.

---

## Key Files

| Type | Full Path | Purpose |
|------|-----------|---------|
| Smart Storage Service | `backend/src/modules/smart-storage/service.ts` | Active file provider |
| Smart Storage Index | `backend/src/modules/smart-storage/index.ts` | Module export |
| File Minio Flat Service | `backend/src/modules/file-minio-flat/service.ts` | Alternate implementation |
| File Minio Flat Index | `backend/src/modules/file-minio-flat/index.ts` | Module export |
| Config | `backend/medusa-config.ts` | Provider registration (smart-storage only) |
