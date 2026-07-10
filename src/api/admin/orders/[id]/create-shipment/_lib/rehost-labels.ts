/**
 * Get each bought label into OUR storage (MinIO via uploadFilesWorkflow —
 * same path as product/trip images). The invoice must never depend on a
 * provider's signed URL (Shippo's expire and die if we ever leave the
 * provider) or on inline bytes that only exist in the purchase response
 * (UPS-direct returns the label as base64, no CDN URL at all — see
 * `LabelPackage.label_base64`). Two sources, one destination:
 *   - `label_url` set  → download from the provider CDN (Shippo).
 *   - `label_base64` set → decode inline (UPS-direct); stripped from the
 *     output either way so it never gets persisted to `order_delivery`.
 * Non-fatal per package: on any failure the provider URL (if any) is kept
 * and the original is always preserved in `provider_label_url` for
 * diagnostics.
 */

import type { MedusaContainer } from "@medusajs/framework/types";

import type { LabelPackage } from "../../../../../../lib/shipping-dispatch/types";

export interface RehostedPackage extends LabelPackage {
  /** Original provider CDN URL (kept for diagnostics/fallback). */
  provider_label_url: string | null;
}

export async function rehostLabelPdfs(
  scope: MedusaContainer,
  packages: LabelPackage[],
  orderId: string
): Promise<RehostedPackage[]> {
  const { uploadFilesWorkflow } = await import("@medusajs/medusa/core-flows");
  const out: RehostedPackage[] = [];

  for (let i = 0; i < packages.length; i++) {
    const pkg = packages[i]!;
    const providerUrl = pkg.label_url ?? null;
    const trackingSuffix = pkg.tracking_number || `pkg${i + 1}`;
    let hostedUrl: string | null = null;
    let buffer: Buffer | null = null;
    let mimeType = "application/pdf";
    let ext = "pdf";

    if (pkg.label_base64) {
      mimeType = pkg.label_mime ?? "image/gif";
      ext = mimeType.split("/")[1] || "gif";
      try {
        buffer = Buffer.from(pkg.label_base64, "base64");
      } catch (err) {
        console.warn(
          `[rehost-labels] failed to decode inline label for pkg ${i + 1}:`,
          err instanceof Error ? err.message : err
        );
      }
    } else if (providerUrl) {
      try {
        const res = await fetch(providerUrl);
        if (res.ok) buffer = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        console.warn(
          `[rehost-labels] keeping provider URL for pkg ${i + 1}:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    if (buffer) {
      try {
        const { result } = await uploadFilesWorkflow(scope).run({
          input: {
            files: [
              {
                filename: `context_shipping_labels_${orderId}_${trackingSuffix}.${ext}`,
                mimeType,
                content: buffer as unknown as string,
                access: "public" as const,
              },
            ],
          },
        });
        hostedUrl = (result[0] as { url?: string } | undefined)?.url ?? null;
      } catch (err) {
        console.warn(
          `[rehost-labels] upload failed for pkg ${i + 1}:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    // label_base64 is consumed here — never persisted downstream.
    const { label_base64: _b64, ...rest } = pkg;
    out.push({
      ...rest,
      label_url: hostedUrl ?? providerUrl,
      provider_label_url: providerUrl,
    });
  }
  return out;
}
