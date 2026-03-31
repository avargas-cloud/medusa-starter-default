import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * GET /store/branding
 *
 * Returns brand identity config for all frontends (website, POS, mobile apps, etc.).
 * Assets are served directly from MinIO — no binary data passes through this endpoint.
 *
 * Cache: 1 hour on CDN / proxy, 10 minutes stale-while-revalidate.
 * To bust the cache after a brand update, bump BRANDING_VERSION.
 */

interface BrandingAsset {
  url: string
  alt: string
}

interface BrandingColors {
  primary: string
  primary_dark: string
  text_light: string
  text_dark: string
  background_light: string
  background_dark: string
}

interface BrandingResponse {
  brand_name: string
  tagline: string
  logo: BrandingAsset
  logo_dark: BrandingAsset | null
  favicon: BrandingAsset | null
  colors: BrandingColors
  version: string
}

function buildLogoUrl(): string {
  const override = process.env.BRANDING_LOGO_URL
  if (override) return override

  const endpoint = process.env.MINIO_ENDPOINT
  const bucket = process.env.MINIO_BUCKET
  if (!endpoint || !bucket) {
    throw new Error("MINIO_ENDPOINT and MINIO_BUCKET are required to build the logo URL")
  }

  return `${endpoint}/${bucket}/branding/logo.png`
}

export const GET = async (_req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    const branding: BrandingResponse = {
      brand_name: process.env.BRANDING_NAME ?? "EcoPowerTech",
      tagline: process.env.BRANDING_TAGLINE ?? "Sustainable Power Solutions",
      logo: {
        url: buildLogoUrl(),
        alt: process.env.BRANDING_LOGO_ALT ?? "EcoPowerTech Logo",
      },
      // Set BRANDING_LOGO_DARK_URL to enable a dark-mode logo variant
      logo_dark: process.env.BRANDING_LOGO_DARK_URL
        ? { url: process.env.BRANDING_LOGO_DARK_URL, alt: "EcoPowerTech Logo (dark)" }
        : null,
      // Set BRANDING_FAVICON_URL to expose the favicon URL
      favicon: process.env.BRANDING_FAVICON_URL
        ? { url: process.env.BRANDING_FAVICON_URL, alt: "EcoPowerTech Favicon" }
        : null,
      colors: {
        primary: process.env.BRANDING_COLOR_PRIMARY ?? "#2563EB",
        primary_dark: process.env.BRANDING_COLOR_PRIMARY_DARK ?? "#1d4ed8",
        text_light: "#0f172a",
        text_dark: "#ffffff",
        background_light: "#f8fafc",
        background_dark: "#0B1221",
      },
      version: process.env.BRANDING_VERSION ?? "1",
    }

    // Cache: CDN/proxies cache for 1 hour, clients revalidate after 10 min
    res.setHeader(
      "Cache-Control",
      "public, s-maxage=3600, max-age=600, stale-while-revalidate=86400"
    )
    res.setHeader("Vary", "Accept-Encoding")

    res.status(200).json(branding)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to build branding config"
    res.status(500).json({ error: message })
  }
}
