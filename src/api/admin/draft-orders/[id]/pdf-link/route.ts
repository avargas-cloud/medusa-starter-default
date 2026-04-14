/**
 * POST /admin/draft-orders/:id/pdf-link
 *
 * Generates a PDF for the given draft order and uploads it to MinIO
 * under the `pdf-shares/` prefix (which should have a 7-day lifecycle
 * rule configured in MinIO to auto-delete old files).
 *
 * Returns a public URL valid for 7 days.
 *
 * Setup (one-time, MinIO):
 *   mc ilm rule add --expiry-days 7 --prefix "pdf-shares/" myminio/medusa-media
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  fetchTemplateForPdf,
  fetchDefaultTemplateId,
  generatePdfFromUrl,
} from "../../_shared/pdf";

function buildS3Client(): S3Client {
  return new S3Client({
    credentials: {
      accessKeyId: process.env.MINIO_ACCESS_KEY!,
      secretAccessKey: process.env.MINIO_SECRET_KEY!,
    },
    region: "us-east-1",
    endpoint: process.env.MINIO_ENDPOINT,
    forcePathStyle: true,
  });
}

interface PdfLinkBody {
  templateId?: string;
  docId?: string;
  displayId?: string | number;
  documentType?: string;
  posState?: string;
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { id } = req.params as { id: string };
  const {
    templateId,
    docId,
    displayId,
    documentType = "Estimate",
    posState,
  } = (req.body ?? {}) as PdfLinkBody;

  const docType = documentType.toLowerCase();
  const resolvedTemplateId =
    templateId ?? (await fetchDefaultTemplateId(docType));

  if (!resolvedTemplateId || !docId) {
    res
      .status(400)
      .json({ success: false, error: "templateId and docId are required" });
    return;
  }

  try {
    // Resolve POS base URL — same logic as send-email
    const forwardedHost = req.headers["x-forwarded-host"] as string | undefined;
    const forwardedProto =
      (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
    const forwardedBase = forwardedHost
      ? `${forwardedProto}://${forwardedHost}`
      : null;
    const reqOrigin =
      (req.headers["origin"] as string) || (req.headers["referer"] as string);
    const originBase = reqOrigin ? new URL(reqOrigin).origin : null;
    const POS_URL =
      process.env.POS_URL ??
      forwardedBase ??
      originBase ??
      "http://localhost:3001";

    const templateData = await fetchTemplateForPdf(resolvedTemplateId);
    if (!templateData) {
      console.warn(
        `[pdf-link] Template ${resolvedTemplateId} not found — print page may hang`
      );
    }

    const params = new URLSearchParams({ docId, auto: "0" });
    if (displayId) params.set("displayId", String(displayId));
    const printUrl = `${POS_URL}/print/${resolvedTemplateId}?${params}`;
    console.log(`[pdf-link] Generating PDF from: ${printUrl}`);

    const pdfBuffer = await generatePdfFromUrl(
      printUrl,
      posState,
      templateData
    );
    console.log(`[pdf-link] PDF generated (${pdfBuffer.length} bytes)`);

    // Upload to MinIO — pdf-shares/ prefix has a 7-day lifecycle rule
    const bucket = process.env.MINIO_BUCKET ?? "medusa-media";
    const endpoint = process.env.MINIO_ENDPOINT!;
    const fileKey = `pdf-shares/${documentType.toLowerCase()}-${displayId ?? id}-${Date.now()}.pdf`;

    await buildS3Client().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: fileKey,
        Body: pdfBuffer,
        ContentType: "application/pdf",
        ContentLength: pdfBuffer.length,
        ACL: "public-read",
      })
    );

    const pdfUrl = `${endpoint}/${bucket}/${fileKey}`;
    const expiresAt = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000
    ).toISOString();

    console.log(`[pdf-link] Uploaded: ${pdfUrl}`);
    res.json({ success: true, pdfUrl, expiresAt });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[pdf-link] Error:", message);
    res.status(500).json({ success: false, error: message });
  }
}
