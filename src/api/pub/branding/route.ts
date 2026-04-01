import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * GET /pub/branding
 *
 * Publicly accessible branding endpoint — no publishable API key required.
 * Used by external apps (e.g. Backlighting Tool) that share EcoPowerTech branding
 * but don't have a Medusa publishable key.
 *
 * Mirrors /store/branding but lives outside the /store/* namespace so Medusa's
 * publishable-key middleware does not apply.
 *
 * Cache: 1 hour on CDN / proxy, 10 minutes stale-while-revalidate.
 */

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
    const branding = {
      brand_name: process.env.BRANDING_NAME ?? "EcoPowerTech",
      tagline: process.env.BRANDING_TAGLINE ?? "Sustainable Power Solutions",
      logo: {
        url: buildLogoUrl(),
        alt: process.env.BRANDING_LOGO_ALT ?? "EcoPowerTech Logo",
      },
      logo_dark: process.env.BRANDING_LOGO_DARK_URL
        ? { url: process.env.BRANDING_LOGO_DARK_URL, alt: "EcoPowerTech Logo (dark)" }
        : null,
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
