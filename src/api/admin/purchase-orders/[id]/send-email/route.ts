/**
 * POST /admin/purchase-orders/:id/send-email
 *
 * Generates the selected Purchase Order template as a PDF and sends it to the
 * vendor. The POS frontend supplies the print-page localStorage payload because
 * the PO print route is intentionally frontend-template based.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import {
  fetchDefaultTemplateId,
  fetchTemplateForPdf,
  generatePdfFromUrl,
} from "../../../draft-orders/_shared/pdf";
import { sendMail } from "../../../../../utils/mailer";
import { getPurchaseOrdersService } from "../../_lib/service-resolver";

interface SendPoEmailBody {
  to?: string;
  cc?: string;
  subject?: string;
  templateId?: string;
  displayId?: string | number;
  emailBody?: string;
  emailSignature?: string;
  posState?: string;
  localStoragePayloads?: Record<string, string>;
  extraAttachments?: Array<{
    filename: string;
    content: string;
    type?: string;
  }>;
}

interface PurchaseOrderEmailRecord {
  id: string;
  number?: string | null;
  draft_number?: string | null;
  vendor_id: string;
  vendor_name_snapshot?: string | null;
  ordered_at?: Date | string | null;
  expected_at?: Date | string | null;
  currency_code?: string | null;
  total_cents?: number | null;
}

interface VendorEmailRecord {
  full_name?: string | null;
  name?: string | null;
  company_name?: string | null;
  email?: string | null;
}

interface UserEmailRecord {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function splitEmails(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
}

function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "";
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function poDocumentNumber(value: string | number): string {
  return String(value).replace(/^PO-/i, "");
}

async function resolveSender(req: AuthenticatedMedusaRequest): Promise<{
  from: string;
  replyTo?: string;
  name: string;
}> {
  let senderEmail: string | undefined;
  try {
    const base = `http://localhost:${process.env.PORT ?? 9000}`;
    const meRes = await fetch(`${base}/admin/users/me`, {
      headers: {
        Cookie: req.headers["cookie"] ?? "",
        Authorization: req.headers["authorization"] ?? "",
      },
    });
    if (meRes.ok) {
      const payload = (await meRes.json()) as { user?: UserEmailRecord };
      const me = payload.user;
      senderEmail =
        typeof me?.email === "string" ? me.email.trim().toLowerCase() : undefined;
    }
  } catch {
    /* best effort */
  }

  const fromAddr = "purchase@ecopowertech.com";
  const name = "EcoPowerTech Purchasing";
  return {
    from: `${name} <${fromAddr}>`,
    replyTo: senderEmail,
    name,
  };
}

function buildPreviewHtml(po: PurchaseOrderEmailRecord, vendor: VendorEmailRecord | null) {
  const poNumber = poDocumentNumber(po.number ?? po.draft_number ?? po.id);
  const vendorName =
    vendor?.company_name ?? vendor?.full_name ?? vendor?.name ?? po.vendor_name_snapshot ?? "Vendor";
  const total = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: (po.currency_code ?? "USD").toUpperCase(),
  }).format((po.total_cents ?? 0) / 100);

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
body{font-family:Arial,sans-serif;color:#0f172a;background:#fff;padding:32px}
.box{border:1px solid #e2e8f0;border-radius:12px;padding:24px;max-width:620px}
p{color:#475569;line-height:1.5}
</style></head><body>
<div class="box">
<h2>Purchase Order ${escapeHtml(poNumber)}</h2>
<p>Vendor: ${escapeHtml(vendorName)}</p>
<p>Date: ${escapeHtml(formatDate(po.ordered_at))}</p>
<p>Total: ${escapeHtml(total)}</p>
</div>
</body></html>`;
}

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const { id } = req.params as { id: string };
  const service = getPurchaseOrdersService(req);
  const po = (await service
    .retrievePurchaseOrder(id)
    .catch(() => null)) as PurchaseOrderEmailRecord | null;
  if (!po) return void res.status(404).send("Purchase order not found");

  let vendor: VendorEmailRecord | null = null;
  try {
    const catalog = req.scope.resolve("quickbooks_catalog") as {
      retrieveQbVendor: (vendorId: string) => Promise<VendorEmailRecord | null>;
    };
    vendor = await catalog.retrieveQbVendor(po.vendor_id);
  } catch {
    vendor = null;
  }

  res.setHeader("Content-Type", "text/html");
  res.send(buildPreviewHtml(po, vendor));
}

export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const { id } = req.params as { id: string };
  const body = (req.body ?? {}) as SendPoEmailBody;
  const service = getPurchaseOrdersService(req);

  const po = (await service
    .retrievePurchaseOrder(id)
    .catch(() => null)) as PurchaseOrderEmailRecord | null;
  if (!po) {
    return void res.status(404).json({ success: false, message: "Purchase order not found" });
  }

  let vendor: VendorEmailRecord | null = null;
  try {
    const catalog = req.scope.resolve("quickbooks_catalog") as {
      retrieveQbVendor: (vendorId: string) => Promise<VendorEmailRecord | null>;
    };
    vendor = await catalog.retrieveQbVendor(po.vendor_id);
  } catch {
    vendor = null;
  }

  const vendorEmail = body.to ?? vendor?.email ?? undefined;
  if (!vendorEmail) {
    return void res.status(400).json({ success: false, message: "No vendor email found" });
  }

  if (!process.env.RESEND_API_KEY) {
    return void res.status(200).json({
      success: false,
      preview_only: true,
      message: "RESEND_API_KEY not set.",
    });
  }

  const displayId = body.displayId ?? po.number ?? po.draft_number ?? po.id;
  const poNumber = poDocumentNumber(displayId);
  const vendorName =
    vendor?.company_name ?? vendor?.full_name ?? vendor?.name ?? po.vendor_name_snapshot ?? "Vendor";
  const total = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: (po.currency_code ?? "USD").toUpperCase(),
  }).format((po.total_cents ?? 0) / 100);

  const resolvedTemplateId =
    body.templateId ?? (await fetchDefaultTemplateId("purchase_order"));

  let pdfBuffer: Buffer | null = null;
  try {
    if (resolvedTemplateId && body.localStoragePayloads) {
      const forwardedHost = req.headers["x-forwarded-host"] as string | undefined;
      const forwardedProto =
        (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
      const forwardedBase = forwardedHost ? `${forwardedProto}://${forwardedHost}` : null;
      const reqOrigin =
        (req.headers["origin"] as string) || (req.headers["referer"] as string);
      const originBase = reqOrigin ? new URL(reqOrigin).origin : null;
      const posUrl =
        process.env.POS_URL ?? forwardedBase ?? originBase ?? "http://localhost:3001";
      const params = new URLSearchParams({ auto: "0" });
      if (displayId) params.set("displayId", poNumber);
      const printUrl = `${posUrl}/print/po/${resolvedTemplateId}?${params}`;
      const templateData = await fetchTemplateForPdf(resolvedTemplateId);
      pdfBuffer = await generatePdfFromUrl(
        printUrl,
        body.posState,
        templateData,
        body.localStoragePayloads
      );
    }
  } catch (err) {
    console.error("[po-send-email] PDF generation failed:", err);
  }

  const replaceVendorName = (value: string) =>
    escapeHtml(value)
      .replace(/\[Customer Name\]/gi, escapeHtml(vendorName))
      .replace(/\[Vendor Name\]/gi, escapeHtml(vendorName));
  const bodyHtml = body.emailBody
    ? `<div style="white-space:pre-wrap;line-height:1.6;font-size:15px;color:#334155;margin-bottom:8px;">${replaceVendorName(String(body.emailBody))}</div>`
    : `<p>Dear ${escapeHtml(vendorName)},</p><p>Please find attached Purchase Order #${escapeHtml(poNumber)}. Kindly review the details and confirm receipt at your earliest convenience.</p>`;
  const sigHtml = body.emailSignature
    ? `<div style="white-space:pre-wrap;line-height:1.65;font-size:14px;color:#475569;margin-top:8px;">${replaceVendorName(String(body.emailSignature))}</div>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:15px;color:#334155;background:#f8fafc;margin:0;padding:40px 0}
.wrap{max-width:600px;margin:0 auto;background:#fff;border-radius:12px;padding:48px 40px;border:1px solid #e2e8f0}
.logo{display:flex;align-items:center;gap:12px;margin-bottom:36px}
.logo span{font-size:18px;font-weight:800;letter-spacing:1px;color:#0f172a}
.box{background:#f1f5f9;border-left:4px solid #1d3b8e;border-radius:0 8px 8px 0;padding:24px;margin:28px 0;font-size:14px;line-height:1.8}
.box b{display:inline-block;width:110px;color:#0f172a}
</style></head><body><div class="wrap">
<div class="logo">
<img src="https://bucket-production-2e09.up.railway.app/medusa-media/ecopowertech-logo.png" alt="" style="height:36px;vertical-align:middle;" />
<span style="display:inline-block;vertical-align:middle;margin-left:12px;font-size:18px;font-weight:800;letter-spacing:1px;color:#0f172a;">ECOPOWERTECH</span>
</div>
<h2>Purchase Order ${escapeHtml(poNumber)}</h2>
${bodyHtml}
<div class="box">
<div><b>PO #:</b> ${escapeHtml(poNumber)}</div>
<div><b>Date:</b> ${escapeHtml(formatDate(po.ordered_at))}</div>
${po.expected_at ? `<div><b>Expected:</b> ${escapeHtml(formatDate(po.expected_at))}</div>` : ""}
<div><b>Total:</b> ${escapeHtml(total)}</div>
</div>
${sigHtml}
<p style="margin-top:40px;font-size:12px;color:#94a3b8;text-align:center">Ecopowertech Inc. · 2760 W 84th St, Unit 4, Hialeah, FL 33016</p>
</div></body></html>`;

  const attachments: Array<{
    filename: string;
    content: string;
    type?: string;
  }> = pdfBuffer
    ? [
        {
          filename: `${poNumber}.pdf`,
          content: pdfBuffer.toString("base64"),
          type: "application/pdf",
        },
      ]
    : [];
  if (Array.isArray(body.extraAttachments)) {
    attachments.push(...body.extraAttachments.filter((a) => a.filename && a.content));
  }

  const sender = await resolveSender(req);
  const toEmails = splitEmails(vendorEmail);
  const ccEmails = splitEmails(body.cc).filter((email) => !toEmails.includes(email));

  try {
    await sendMail({
      to: toEmails,
      from: sender.from,
      ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
      subject: body.subject ?? `Purchase Order ${poNumber} from EcoPowerTech`,
      html,
      ...(ccEmails.length > 0 ? { cc: ccEmails } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[po-send-email] sendMail failed:", message);
    return void res.status(500).json({ success: false, message });
  }

  res.status(200).json({
    success: true,
    sent_to: vendorEmail,
    pdf_generated: !!pdfBuffer,
  });
}
