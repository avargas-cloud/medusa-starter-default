/**
 * Download each bought label PDF from the provider CDN and re-host it in OUR
 * storage (MinIO via uploadFilesWorkflow — same path as product/trip images).
 * The invoice must never depend on Shippo's signed URLs (they expire and die
 * if we ever leave the provider). Non-fatal per package: on any failure the
 * provider URL is kept and the original is always preserved in
 * `provider_label_url` for diagnostics.
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
    let hostedUrl: string | null = null;
    if (providerUrl) {
      try {
        const res = await fetch(providerUrl);
        if (res.ok) {
          const buffer = Buffer.from(await res.arrayBuffer());
          const { result } = await uploadFilesWorkflow(scope).run({
            input: {
              files: [
                {
                  filename: `context_shipping_labels_${orderId}_${pkg.tracking_number || `pkg${i + 1}`}.pdf`,
                  mimeType: "application/pdf",
                  content: buffer as unknown as string,
                  access: "public" as const,
                },
              ],
            },
          });
          hostedUrl = (result[0] as { url?: string } | undefined)?.url ?? null;
        }
      } catch (err) {
        console.warn(
          `[rehost-labels] keeping provider URL for pkg ${i + 1}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
    out.push({
      ...pkg,
      label_url: hostedUrl ?? providerUrl,
      provider_label_url: providerUrl,
    });
  }
  return out;
}
