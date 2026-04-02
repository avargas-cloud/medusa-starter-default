# Branding API
> **Type**: Technical Reference
> **Repo**: backend
> **Last verified**: 2026-04-02
> **Status**: Current

---

## What it is and why it exists

`GET /store/branding` is a public store API endpoint that returns brand identity configuration for all frontends — website, POS, mobile apps, etc. It is the single source of truth for logo URLs, colors, and brand name across the platform.

Assets are served directly from MinIO — no binary data passes through this endpoint. It only returns URLs pointing to MinIO/S3.

---

## Response Format

```typescript
interface BrandingResponse {
  brand_name: string           // e.g., "EcoPowerTech"
  tagline: string              // e.g., "Sustainable Power Solutions"
  logo: { url: string, alt: string }
  logo_dark: { url: string, alt: string } | null   // null if BRANDING_LOGO_DARK_URL not set
  favicon: { url: string, alt: string } | null     // null if BRANDING_FAVICON_URL not set
  colors: {
    primary: string            // e.g., "#22c55e"
    primary_dark: string
    text_light: string
    text_dark: string
    background_light: string
    background_dark: string
  }
  version: string              // Cache busting version (BRANDING_VERSION env var)
}
```

---

## Logo URL Construction

If `BRANDING_LOGO_URL` is set, it is used directly. Otherwise, the URL is built as:

```
{MINIO_ENDPOINT}/{MINIO_BUCKET}/branding/logo.png
```

This means the logo file must exist at `branding/logo.png` in the MinIO bucket.

---

## Caching

The response includes caching headers:
- `Cache-Control: public, max-age=3600, s-maxage=3600, stale-while-revalidate=600`

To bust CDN/proxy cache after a brand update, increment the `BRANDING_VERSION` environment variable.

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `BRANDING_NAME` | `"EcoPowerTech"` | Brand name |
| `BRANDING_TAGLINE` | `"Sustainable Power Solutions"` | Tagline |
| `BRANDING_LOGO_URL` | auto-built from MinIO | Override logo URL |
| `BRANDING_LOGO_ALT` | `"EcoPowerTech Logo"` | Logo alt text |
| `BRANDING_LOGO_DARK_URL` | unset | Dark-mode logo URL (optional) |
| `BRANDING_FAVICON_URL` | unset | Favicon URL (optional) |
| `BRANDING_COLOR_PRIMARY` | `"#22c55e"` | Primary brand color |
| `BRANDING_COLOR_PRIMARY_DARK` | `"#16a34a"` | Dark primary color |
| `BRANDING_COLOR_TEXT_LIGHT` | `"#ffffff"` | Light text color |
| `BRANDING_COLOR_TEXT_DARK` | `"#111827"` | Dark text color |
| `BRANDING_COLOR_BG_LIGHT` | `"#ffffff"` | Light background |
| `BRANDING_COLOR_BG_DARK` | `"#111827"` | Dark background |
| `BRANDING_VERSION` | `"1"` | Cache bust version |

Also requires `MINIO_ENDPOINT` and `MINIO_BUCKET` if `BRANDING_LOGO_URL` is not set.

---

## Public API (`/pub/branding`)

There is also a public branding endpoint at `/pub/branding` that bypasses Medusa auth middleware, suitable for embedding in public-facing widgets or loading before authentication.

---

## Key Files

| Type | Full Path | Purpose |
|------|-----------|---------|
| Store Route | `backend/src/api/store/branding/route.ts` | Authenticated store endpoint |
| Public Route | `backend/src/api/pub/branding/route.ts` | Public unauthenticated endpoint |
